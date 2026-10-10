import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RouteOptions } from 'fastify';
import { createDb, schema as s } from '@aruma/db';
import {
  buildTestApp,
  caller,
  registerUser,
  testDatabaseUrl,
  uniqueSlug,
  verifyMerchantViaApi,
  type TestUser, makeStaff } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const routes: RouteOptions[] = [];
app.addHook('onRoute', (r) => void routes.push(r));
const call = caller(app);

let admin: TestUser;
let owner: TestUser;
let staff: TestUser;
let rival: TestUser;
let merchantId: string;
let rivalMerchantId: string;
let productId: string;
let variantId: string;
let offerId: string;

async function createMerchant(user: TestUser) {
  const slug = uniqueSlug();
  const res = await call('POST', '/v1/merchants', user.token, {
    type: 'individual',
    slug,
    name: `Shop ${slug}`,
    country: 'DZ',
    activityCode: 'perfume_retail',
    contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    contactEmail: `${slug}@example.com`,
  });
  return res.json().data.id as string;
}

beforeAll(async () => {
  await app.ready();
  [admin, owner, staff, rival] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await makeStaff(db, admin.userId, 'super_admin');
  merchantId = await createMerchant(owner);
  rivalMerchantId = await createMerchant(rival);
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 1500 });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
});

afterAll(async () => {
  // Leave the shared MB Parfum catalog as other test files expect it.
  if (productId) await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

const base = () => `/v1/merchants/${merchantId}`;
const newProduct = (overrides: Record<string, unknown> = {}) => ({
  storeSlug: 'mb-parfum',
  slug: uniqueSlug('musc'),
  categorySlugs: ['oriental'],
  attributes: { gender: 'unisex', concentration: 'EDP', notes: { top: ['musk'] } },
  translations: [
    { locale: 'ar', name: 'مسك الليل', description: 'مسك دافئ' },
    { locale: 'fr', name: 'Musc de Nuit' },
  ],
  variants: [{ sku: 'musc-nuit-50', options: { sizeMl: 50 } }],
  ...overrides,
});

describe('products and variants', () => {
  it('creates a draft product with translations, categories and variants', async () => {
    const res = await call('POST', `${base()}/products`, owner.token, newProduct());
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'draft', createdByMerchantId: merchantId });
    productId = res.json().data.id;

    const list = (await call('GET', `${base()}/products`, staff.token)).json().data;
    const mine = list.find((p: { id: string }) => p.id === productId);
    expect(mine).toMatchObject({ storeSlug: 'mb-parfum', categories: ['oriental'], ownedByMe: true });
    expect(mine.variants).toEqual([expect.objectContaining({ sku: 'MUSC-NUIT-50', myOffer: null })]);
    variantId = mine.variants[0].id;
  });

  it('validates languages, categories, SKUs and slugs', async () => {
    const code = async (body: Record<string, unknown>) => (await call('POST', `${base()}/products`, owner.token, body)).json().error.code;
    expect(await code(newProduct({ translations: [{ locale: 'fr', name: 'X' }] }))).toBe('DEFAULT_LOCALE_REQUIRED');
    expect(await code(newProduct({ translations: [{ locale: 'ar', name: 'X' }, { locale: 'de', name: 'X' }] }))).toBe('UNSUPPORTED_LOCALE');
    expect(await code(newProduct({ categorySlugs: ['nope'] }))).toBe('UNKNOWN_CATEGORY');
    expect(await code(newProduct({ variants: [{ sku: 'A' }, { sku: 'a' }] }))).toBe('DUPLICATE_SKU');
    expect(await code(newProduct({ slug: 'oud-royal' }))).toBe('SLUG_TAKEN');
  });

  it('lets only owners and managers manage products', async () => {
    expect((await call('POST', `${base()}/products`, staff.token, newProduct())).statusCode).toBe(403);
    expect((await call('PATCH', `${base()}/products/${productId}`, staff.token, { status: 'archived' })).statusCode).toBe(403);
  });

  it('adds and updates variants of its own product', async () => {
    const added = await call('POST', `${base()}/products/${productId}/variants`, owner.token, { sku: 'musc-nuit-100', options: { sizeMl: 100 } });
    expect(added.statusCode).toBe(201);
    const dup = await call('POST', `${base()}/products/${productId}/variants`, owner.token, { sku: 'MUSC-NUIT-100' });
    expect(dup.json().error.code).toBe('DUPLICATE_SKU');
    const off = await call('PATCH', `${base()}/products/${productId}/variants/${added.json().data.id}`, owner.token, { isActive: false });
    expect(off.json().data.isActive).toBe(false);
  });

  it('publishes only while verified', async () => {
    await call('POST', `/v1/admin/merchants/${merchantId}/suspend`, admin.token, { reason: 'Test' });
    const blocked = await call('PATCH', `${base()}/products/${productId}`, owner.token, { status: 'active' });
    expect(blocked.json().error.code).toBe('MERCHANT_NOT_VERIFIED');
    await call('POST', `/v1/admin/merchants/${merchantId}/unsuspend`, admin.token);

    const res = await call('PATCH', `${base()}/products/${productId}`, owner.token, {
      status: 'active',
      translations: [{ locale: 'en', name: 'Night Musk' }],
    });
    expect(res.json().data.status).toBe('active');
  });

  it('finds marketplace products to sell, including other merchants’ products', async () => {
    const found = (await call('GET', `${base()}/catalog?q=oud`, staff.token)).json().data;
    expect(found.map((p: { slug: string }) => p.slug)).toContain('oud-royal');
    expect(found.find((p: { slug: string }) => p.slug === 'oud-royal').ownedByMe).toBe(false);
  });
});

describe('offers and inventory', () => {
  it('puts the product on sale and shows it in the store', async () => {
    const res = await call('PUT', `${base()}/offers`, staff.token, {
      variantId,
      stockQuantity: 4,
      prices: [{ currency: 'DZD', amountMinor: 450000 }],
    });
    expect(res.statusCode).toBe(200);
    offerId = res.json().data.id;
    const slug = (await call('GET', `${base()}/products`, owner.token)).json().data.find((p: { id: string }) => p.id === productId).slug;
    const storefront = (await call('GET', `/v1/stores/mb-parfum/products/${slug}?locale=en`)).json().data;
    expect(storefront).toMatchObject({ name: 'Night Musk', variants: [{ inStock: true, price: { amount: '4500.00' } }] });

    const offers = (await call('GET', `${base()}/offers`, staff.token)).json().data;
    expect(offers[0]).toMatchObject({ sku: 'MUSC-NUIT-50', storeSlug: 'mb-parfum', product: { names: { ar: 'مسك الليل' } } });
  });

  it('adjusts stock with a reason and keeps a history', async () => {
    const url = `${base()}/inventory/offers/${offerId}/adjust`;
    expect((await call('POST', url, staff.token, { delta: 10, reason: 'restock', note: 'Arrivage' })).json().data.totals.available).toBe(14);
    expect((await call('POST', url, staff.token, { delta: -2, reason: 'damaged' })).json().data.totals.available).toBe(12);
    const tooMany = await call('POST', url, staff.token, { delta: -100, reason: 'correction' });
    expect(tooMany.json().error.code).toBe('INSUFFICIENT_STOCK');
    // 'sale' movements belong to the orders module, never to manual edits.
    expect((await call('POST', url, staff.token, { delta: -1, reason: 'sale' })).statusCode).toBe(400);

    // Setting stock through the offer form is recorded as a correction.
    await call('PUT', `${base()}/offers`, owner.token, { variantId, stockQuantity: 20, prices: [{ currency: 'DZD', amountMinor: 450000 }] });
    const history = (await call('GET', `${base()}/inventory/offers/${offerId}/history`, staff.token)).json().data;
    expect(history.map((h: { reason: string; delta: number; quantityAfter: number }) => [h.reason, h.delta, h.quantityAfter])).toEqual([
      ['correction', 8, 20],
      ['damaged', -2, 12],
      ['restock', 10, 14],
      ['initial', 4, 4],
    ]);
  });

  it('summarizes everything on the dashboard', async () => {
    const d = (await call('GET', `${base()}/dashboard`, staff.token)).json().data;
    expect(d.merchant).toMatchObject({ verificationStatus: 'verified', canSell: true, type: 'individual' });
    expect(d.myRole).toBe('staff');
    expect(d.stores).toEqual([{ storeSlug: 'mb-parfum', storeName: 'MB Parfum', commissionBps: 1500 }]);
    expect(d.products).toEqual({ active: 1 });
    expect(d.offers).toMatchObject({ active: 1, outOfStock: 0, units: 20, reserved: 0, available: 20 });
    expect(d.recentMovements[0]).toMatchObject({ sku: 'MUSC-NUIT-50', reason: 'correction' });
    expect(d.upcomingSections.orders).toBeUndefined();
    expect(d.upcomingSections.sales).toBe(1);
    expect(d.orders).toEqual({});
  });
});

describe('what a merchant can never do', () => {
  const fill = (url: string) =>
    url.replace(':merchantId', merchantId).replace(/:([a-zA-Z]+)/g, (_m, name) => (name === 'kind' ? 'identity' : randomUUID()));

  it('cannot reach another merchant through any merchant route', async () => {
    const merchantRoutes = routes.filter((r) => r.url.includes(':merchantId') && !r.url.startsWith('/v1/admin'));
    expect(merchantRoutes.length).toBeGreaterThan(25);
    for (const r of merchantRoutes) {
      for (const method of [r.method].flat()) {
        if (method === 'HEAD') continue;
        const res = await call(method as 'GET', fill(r.url), rival.token, {});
        if (res.statusCode < 400 || ![400, 403, 404].includes(res.statusCode)) {
          throw new Error(`${method} ${r.url} → ${res.statusCode} for another merchant`);
        }
        if (method === 'GET') expect([403, 404]).toContain(res.statusCode);
      }
    }
  });

  it('cannot edit another merchant’s products', async () => {
    const res = await call('PATCH', `/v1/merchants/${rivalMerchantId}/products/${productId}`, rival.token, { status: 'archived' });
    expect(res.statusCode).toBe(404);
  });

  it('cannot change the ARUMA commission', async () => {
    const res = await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, owner.token, { commissionBps: 0 });
    expect(res.statusCode).toBe(403);
    // Extra fields are dropped by validation, never written.
    await call('PUT', `${base()}/offers`, owner.token, {
      variantId,
      stockQuantity: 20,
      prices: [{ currency: 'DZD', amountMinor: 450000 }],
      commissionBps: 0,
    });
    await call('PATCH', base(), owner.token, { name: 'Renamed', commissionBps: 0 });
    const [row] = await db.select().from(s.storeMerchants).where(eq(s.storeMerchants.merchantId, merchantId));
    expect(row!.commissionBps).toBe(1500);
    // No merchant-facing route can write the store relationship.
    expect(routes.filter((r) => !r.url.startsWith('/v1/admin') && /commission|stores\/:storeSlug\/merchants/.test(r.url))).toEqual([]);
  });

  it('cannot rewrite or delete history: the database refuses', async () => {
    const refused = { cause: expect.objectContaining({ message: expect.stringMatching(/is append-only/) }) };
    for (const statement of [
      sql`update inventory_movements set delta = 999`,
      sql`delete from inventory_movements`,
      sql`truncate inventory_movements`,
      sql`update audit_logs set action = 'forged'`,
      sql`delete from audit_logs`,
      sql`truncate audit_logs`,
    ]) {
      await expect(db.execute(statement)).rejects.toMatchObject(refused);
    }
    // And no route offers deletion of offers, stock history or audit logs.
    const deletes = routes.filter((r) => [r.method].flat().includes('DELETE')).map((r) => r.url);
    expect(deletes.filter((u) => /offers|inventory|audit|products/.test(u))).toEqual([]);
  });

  it('is logged out of everything without a session', async () => {
    const merchantRoutes = routes.filter((r) => r.url.includes(':merchantId'));
    for (const r of merchantRoutes) {
      for (const method of [r.method].flat()) {
        if (method === 'HEAD') continue;
        expect((await call(method as 'GET', fill(r.url), undefined, {})).statusCode).toBe(401);
      }
    }
  });
});
