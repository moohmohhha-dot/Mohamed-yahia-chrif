import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import {
  consumeStock,
  releaseExpiredReservations,
  releaseStock,
  reserveStock,
} from '../src/modules/inventory/index.js';
import {
  bearer,
  buildTestApp,
  caller,
  multipartFile,
  registerUser,
  testDatabaseUrl,
  uniqueSlug,
  verifyMerchantViaApi,
  type TestUser,
} from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let owner: TestUser;
let staff: TestUser;
let merchantId: string;
let offerA: { id: string; sku: string };
let offerB: { id: string; sku: string };
let productIds: string[] = [];
const ref = (id: string) => ({ type: 'order', id });

async function newOffer(name: string, stock: number) {
  const slug = uniqueSlug('inv');
  const created = await call('POST', `${base()}/products`, owner.token, {
    storeSlug: 'mb-parfum',
    slug,
    translations: [{ locale: 'ar', name }],
    variants: [{ sku: `${slug}-50`, options: { sizeMl: 50 } }],
  });
  const productId = created.json().data.id;
  productIds.push(productId);
  const products = (await call('GET', `${base()}/products`, owner.token)).json().data;
  const variantId = products.find((p: { id: string }) => p.id === productId).variants[0].id;
  const offer = await call('PUT', `${base()}/offers`, owner.token, {
    variantId,
    stockQuantity: stock,
    prices: [{ currency: 'DZD', amountMinor: 100000 }],
  });
  return { id: offer.json().data.id as string, sku: offer.json().data.sku as string, productId: productId as string, slug };
}

const base = () => `/v1/merchants/${merchantId}`;
const totals = async (offerId: string) => {
  const [o] = await db.select().from(s.offers).where(eq(s.offers.id, offerId));
  return { onHand: o!.onHandQuantity, reserved: o!.reservedQuantity, available: o!.availableQuantity };
};
const inventory = async () => (await call('GET', `${base()}/inventory`, staff.token)).json().data as any[];
const locations = async () => (await call('GET', `${base()}/inventory/locations`, owner.token)).json().data as any[];
async function upload(path: string, body: Buffer, fileName: string, token = owner.token) {
  const { payload, headers } = multipartFile(body, fileName, 'text/csv');
  return app.inject({ method: 'POST', url: path, payload, headers: { ...headers, ...bearer(token) } });
}

beforeAll(async () => {
  await app.ready();
  [admin, owner, staff] = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'business',
      slug,
      name: 'Inventory Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 1000 });
  await call('PUT', `${base()}/staff`, owner.token, { email: staff.email, role: 'staff' });
  offerA = await newOffer('عطر أ', 10);
  offerB = await newOffer('=HYPERLINK("http://evil")', 3);
});

afterAll(async () => {
  // Keep the shared MB Parfum catalog as other test files expect it.
  for (const id of productIds) await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, id));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('quantities', () => {
  it('starts in the default location with on hand = available', async () => {
    expect(await totals(offerA.id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    const [main] = await locations();
    expect(main).toMatchObject({ code: 'MAIN', isDefault: true, onHand: 13 });
    const item = (await inventory()).find((i) => i.offerId === offerA.id);
    expect(item).toMatchObject({ sku: offerA.sku, onHand: 10, reserved: 0, available: 10, lowStock: false });
    expect(item.locations).toEqual([expect.objectContaining({ locationCode: 'MAIN', onHand: 10, reserved: 0, available: 10 })]);
  });

  it('keeps offer totals in sync through the database trigger only', async () => {
    // Even a direct write to levels is reflected on the offer.
    await db.update(s.inventoryLevels).set({ onHand: 11 }).where(eq(s.inventoryLevels.offerId, offerA.id));
    expect(await totals(offerA.id)).toEqual({ onHand: 11, reserved: 0, available: 11 });
    await db.update(s.inventoryLevels).set({ onHand: 10 }).where(eq(s.inventoryLevels.offerId, offerA.id));
  });
});

describe('reservations: order created → reserve, cancelled → release, shipped → consume', () => {
  it('reserves stock: available drops, on hand stays', async () => {
    const rows = await db.transaction((tx) => reserveStock(tx, { reference: ref('order-1'), lines: [{ offerId: offerA.id, quantity: 3 }] }));
    expect(rows).toHaveLength(1);
    expect(await totals(offerA.id)).toEqual({ onHand: 10, reserved: 3, available: 7 });
    const active = (await call('GET', `${base()}/inventory/reservations`, staff.token)).json().data;
    expect(active).toEqual([expect.objectContaining({ referenceId: 'order-1', quantity: 3, locationCode: 'MAIN' })]);
  });

  it('is idempotent: retrying the same order does not reserve twice', async () => {
    await db.transaction((tx) => reserveStock(tx, { reference: ref('order-1'), lines: [{ offerId: offerA.id, quantity: 3 }] }));
    expect((await totals(offerA.id)).reserved).toBe(3);
  });

  it('is all-or-nothing and refuses to oversell', async () => {
    const attempt = db.transaction((tx) =>
      reserveStock(tx, {
        reference: ref('order-2'),
        lines: [
          { offerId: offerA.id, quantity: 2 },
          { offerId: offerB.id, quantity: 4 }, // only 3 exist
        ],
      }),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'OUT_OF_STOCK', details: { offerId: offerB.id, requested: 4, available: 3 } });
    expect(await totals(offerA.id)).toEqual({ onHand: 10, reserved: 3, available: 7 }); // offer A untouched
    expect(await totals(offerB.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('cannot remove or count away stock that is reserved', async () => {
    const adjust = await call('POST', `${base()}/inventory/offers/${offerA.id}/adjust`, staff.token, { delta: -8, reason: 'damaged' });
    expect(adjust.json().error.code).toBe('INSUFFICIENT_STOCK');
    const count = await call('POST', `${base()}/inventory/offers/${offerA.id}/count`, staff.token, { quantity: 2 });
    expect(count.json().error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('releases on cancellation, idempotently', async () => {
    expect(await db.transaction((tx) => releaseStock(tx, ref('order-1'), { reason: 'Customer cancelled' }))).toBe(1);
    expect(await db.transaction((tx) => releaseStock(tx, ref('order-1')))).toBe(0);
    expect(await totals(offerA.id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('consumes on shipment: on hand and reserved both drop', async () => {
    await db.transaction((tx) => reserveStock(tx, { reference: ref('order-3'), lines: [{ offerId: offerA.id, quantity: 2 }] }));
    expect(await db.transaction((tx) => consumeStock(tx, ref('order-3')))).toBe(1);
    expect(await db.transaction((tx) => releaseStock(tx, ref('order-3')))).toBe(0); // already consumed
    expect(await totals(offerA.id)).toEqual({ onHand: 8, reserved: 0, available: 8 });

    const history = (await call('GET', `${base()}/inventory/offers/${offerA.id}/history`, staff.token)).json().data;
    expect(history.slice(0, 2).map((h: any) => [h.reason, h.delta, h.reservedDelta, h.referenceId])).toEqual([
      ['sale', -2, -2, 'order-3'],
      ['reserved', 0, 2, 'order-3'],
    ]);
  });

  it('never oversells under concurrent orders', async () => {
    const offer = await newOffer('عطر محدود', 5);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        db.transaction((tx) => reserveStock(tx, { reference: ref(`rush-${offer.id}-${i}`), lines: [{ offerId: offer.id, quantity: 1 }] })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason.code === 'OUT_OF_STOCK')).toBe(true);
    expect(await totals(offer.id)).toEqual({ onHand: 5, reserved: 5, available: 0 });
    // The storefront now shows it as out of stock.
    await call('PATCH', `${base()}/products/${offer.productId}`, owner.token, { status: 'active' });
    const product = (await call('GET', `/v1/stores/mb-parfum/products/${offer.slug}`)).json().data;
    expect(product.variants[0].inStock).toBe(false);
  });

  it('is also guarded by the database itself', async () => {
    const attempt = db.execute(sql`update inventory_levels set reserved = on_hand + 1 where offer_id = ${offerA.id}`);
    await expect(attempt).rejects.toMatchObject({ cause: expect.objectContaining({ constraint: 'inventory_levels_no_oversell' }) });
  });

  it('frees checkout holds when they expire', async () => {
    await db.transaction((tx) =>
      reserveStock(tx, { reference: { type: 'checkout', id: 'cart-1' }, lines: [{ offerId: offerA.id, quantity: 1 }], expiresAt: new Date(Date.now() - 1000) }),
    );
    await db.transaction((tx) =>
      reserveStock(tx, { reference: { type: 'checkout', id: 'cart-2' }, lines: [{ offerId: offerA.id, quantity: 1 }], expiresAt: new Date(Date.now() + 600_000) }),
    );
    expect((await totals(offerA.id)).reserved).toBe(2);
    expect(await releaseExpiredReservations(db)).toBe(1);
    expect((await totals(offerA.id)).reserved).toBe(1);
    await db.transaction((tx) => releaseStock(tx, { type: 'checkout', id: 'cart-2' }));
  });
});

describe('warehouses and transfers', () => {
  let main: any;
  let alger: any;

  it('creates a second location', async () => {
    const res = await call('POST', `${base()}/inventory/locations`, owner.token, { code: 'alger-1', name: 'Dépôt Alger', city: 'Alger', country: 'DZ' });
    expect(res.statusCode).toBe(201);
    alger = res.json().data;
    expect(alger).toMatchObject({ code: 'ALGER-1', isDefault: false });
    expect((await call('POST', `${base()}/inventory/locations`, owner.token, { code: 'ALGER-1', name: 'x' })).json().error.code).toBe('LOCATION_CODE_TAKEN');
    [main] = await locations();
  });

  it('transfers available stock only, and only managers and owners can', async () => {
    const body = { offerId: offerA.id, fromLocationId: main.id, toLocationId: alger.id, quantity: 3 };
    expect((await call('POST', `${base()}/inventory/transfers`, staff.token, body)).statusCode).toBe(403);
    const res = await call('POST', `${base()}/inventory/transfers`, owner.token, body);
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ from: { onHand: 5 }, to: { onHand: 3 } });
    expect(await totals(offerA.id)).toEqual({ onHand: 8, reserved: 0, available: 8 }); // totals unchanged

    await db.transaction((tx) => reserveStock(tx, { reference: ref('order-4'), lines: [{ offerId: offerA.id, quantity: 5 }] }));
    const blocked = await call('POST', `${base()}/inventory/transfers`, owner.token, { ...body, quantity: 1 });
    expect(blocked.json().error.code).toBe('INSUFFICIENT_STOCK');
    await db.transaction((tx) => releaseStock(tx, ref('order-4')));
  });

  it('splits a reservation across locations, default first', async () => {
    const rows = await db.transaction((tx) => reserveStock(tx, { reference: ref('order-5'), lines: [{ offerId: offerA.id, quantity: 7 }] }));
    expect(rows.map((r) => [r.locationId, r.quantity])).toEqual([
      [main.id, 5],
      [alger.id, 2],
    ]);
    await db.transaction((tx) => releaseStock(tx, ref('order-5')));
  });

  it('protects locations: default and non-empty ones cannot be archived', async () => {
    const archive = (id: string) => call('PATCH', `${base()}/inventory/locations/${id}`, owner.token, { status: 'archived' });
    expect((await archive(main.id)).json().error.code).toBe('DEFAULT_LOCATION');
    expect((await archive(alger.id)).json().error.code).toBe('LOCATION_NOT_EMPTY');
    const made = await call('PATCH', `${base()}/inventory/locations/${alger.id}`, owner.token, { isDefault: true });
    expect(made.json().data.isDefault).toBe(true);
    expect((await locations()).filter((l) => l.isDefault).map((l) => l.code)).toEqual(['ALGER-1']);
    await call('PATCH', `${base()}/inventory/locations/${main.id}`, owner.token, { isDefault: true });
  });
});

describe('low stock', () => {
  it('flags offers at or below their threshold', async () => {
    await call('PUT', `${base()}/inventory/offers/${offerB.id}/low-stock-threshold`, staff.token, { threshold: 3 });
    const low = (await call('GET', `${base()}/inventory?lowStock=true`, staff.token)).json().data;
    expect(low.map((i: any) => i.sku)).toContain(offerB.sku);
    expect(low.map((i: any) => i.sku)).not.toContain(offerA.sku);
  });
});

describe('bulk import and export', () => {
  const importUrl = (dryRun: boolean) => `${base()}/inventory/import?dryRun=${dryRun}`;

  it('checks a CSV first without writing anything', async () => {
    const csv = `﻿sku;quantité;emplacement;mode;note\r\n${offerA.sku};20;MAIN;set;"Inventaire; annuel"\r\n${offerB.sku};+2;;adjust;\r\n`;
    const res = await upload(importUrl(true), Buffer.from(csv), 'stock.csv');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ dryRun: true, valid: true, errors: 0 });
    expect(data.rows.map((r: any) => [r.sku, r.before, r.after])).toEqual([
      [offerA.sku, 5, 20],
      [offerB.sku, 3, 5],
    ]);
    expect((await totals(offerB.id)).onHand).toBe(3); // nothing written
  });

  it('rejects the whole file when any row is wrong', async () => {
    const csv = `sku,quantity,location\n${offerA.sku},7,MAIN\nNOPE-1,3,\n${offerB.sku},abc,\n${offerB.sku},4,MARS\n`;
    const res = await upload(importUrl(false), Buffer.from(csv), 'bad.csv');
    expect(res.statusCode).toBe(400);
    const { code, details } = res.json().error;
    expect(code).toBe('IMPORT_INVALID');
    expect(details.rows.map((r: any) => r.error ?? null)).toEqual([null, 'Unknown SKU NOPE-1', 'Quantity must be a whole number', 'Unknown location MARS']);
    expect((await totals(offerA.id)).onHand).toBe(8); // unchanged
  });

  it('applies a valid CSV in one go, with history', async () => {
    const csv = `sku,quantity,location,mode\n${offerA.sku},20,MAIN,set\n${offerB.sku},2,,adjust\n`;
    const res = await upload(importUrl(false), Buffer.from(csv), 'stock.csv');
    expect(res.json().data).toMatchObject({ valid: true, dryRun: false });
    expect(await totals(offerA.id)).toEqual({ onHand: 23, reserved: 0, available: 23 }); // 20 MAIN + 3 ALGER-1
    expect((await totals(offerB.id)).onHand).toBe(5);
    const history = (await call('GET', `${base()}/inventory/offers/${offerB.id}/history`, staff.token)).json().data;
    expect(history[0]).toMatchObject({ reason: 'import', delta: 2, referenceType: 'import' });
  });

  it('imports Excel files', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Stock');
    sheet.addRow(['SKU', 'Quantity']);
    sheet.addRow([offerB.sku, 9]);
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const res = await upload(importUrl(false), body, 'stock.xlsx');
    expect(res.json().data.rows[0]).toMatchObject({ sku: offerB.sku, before: 5, after: 9 });
    expect((await totals(offerB.id)).onHand).toBe(9);
  });

  it('only lets owners and managers import', async () => {
    const res = await upload(importUrl(true), Buffer.from(`sku,quantity\n${offerA.sku},1\n`), 'x.csv', staff.token);
    expect(res.statusCode).toBe(403);
  });

  it('exports CSV and Excel that can be re-imported, without spreadsheet formulas', async () => {
    const res = await app.inject({ method: 'GET', url: `${base()}/inventory/export?format=csv&locale=ar`, headers: bearer(staff.token) });
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('sku,product,location,quantity,reserved,available,mode,note');
    expect(lines).toContain(`${offerA.sku},عطر أ,ALGER-1,3,0,3,set,`);
    const evil = lines.find((l) => l.startsWith(offerB.sku))!;
    expect(evil).toContain(`"'=HYPERLINK(""http://evil"")"`);

    const xlsx = await app.inject({ method: 'GET', url: `${base()}/inventory/export?format=xlsx`, headers: bearer(staff.token) });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(workbook.worksheets[0]!.getRow(1).getCell(1).value).toBe('sku');

    // Round trip: re-importing the export changes nothing.
    const again = await upload(importUrl(true), Buffer.from(res.body), 'export.csv');
    expect(again.json().data.rows.every((r: any) => r.before === r.after && !r.error)).toBe(true);
  });
});
