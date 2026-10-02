import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import {
  addMerchantDelivery,
  bearer,
  buildTestApp,
  caller,
  cheapestDelivery,
  dzAddress,
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
let support: TestUser;
let owner: TestUser;
let staff: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;
let merchantId: string;
let productId: string;
let offer: { id: string; sku: string };
let mbOfferId: string; // the seeded MB Parfum offer for Oud Royal 50 ml

const address = dzAddress('DZ-31-C-oran', { phone: '+213661234567' });
/** The address as the server stores it: Commune, Daïra and Wilaya filled from the Commune id. */
const storedAddress = { fullName: address.fullName, phone: '+213661234567', cityId: 'DZ-31-C-oran', city: 'Oran', regionId: 'DZ-31', region: 'Oran', line1: address.line1 };
const checkout = async (user: TestUser, lines: { offerId: string; quantity: number }[], key: string | null = randomUUID(), extra = {}) => {
  const delivery = await cheapestDelivery(app, lines, address);
  return app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(user.token), ...(key ? { 'idempotency-key': key } : {}) },
    payload: {
      lines,
      paymentMethod: 'cash_on_delivery',
      shippingAddress: address,
      delivery: delivery.length ? delivery : [{ merchantId: randomUUID(), methodId: randomUUID() }],
      ...extra,
    },
  });
};
const stock = async (offerId: string) => {
  const [o] = await db.select().from(s.offers).where(eq(s.offers.id, offerId));
  return { onHand: o!.onHandQuantity, reserved: o!.reservedQuantity, available: o!.availableQuantity };
};
const mUrl = (orderId: string) => `/v1/merchants/${merchantId}/orders/${orderId}`;
const move = (user: TestUser, orderId: string, body: Record<string, unknown>) => call('POST', `${mUrl(orderId)}/status`, user.token, body);

beforeAll(async () => {
  await app.ready();
  [admin, support, owner, staff, customer, otherCustomer] = await Promise.all([
    registerUser(app),
    registerUser(app),
    registerUser(app),
    registerUser(app),
    registerUser(app),
    registerUser(app),
  ]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  await db.update(s.users).set({ role: 'support' }).where(eq(s.users.id, support.userId));
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Orders Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 1200 });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  await addMerchantDelivery(app, owner, merchantId);

  const pslug = uniqueSlug('ord');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'ورد الطائف' }, { locale: 'fr', name: 'Rose de Taïf' }],
      variants: [{ sku: `${pslug}-30`, options: { sizeMl: 30 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  const created = (
    await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 5, prices: [{ currency: 'DZD', amountMinor: 350000 }] })
  ).json().data;
  offer = { id: created.id, sku: created.sku };

  const [mb] = await db.select().from(s.offers).where(eq(s.offers.sku, 'OUD-ROYAL-50ML'));
  mbOfferId = mb!.id;
});

afterAll(async () => {
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('placing an order', () => {
  it('validates the request and refuses to oversell, creating nothing', async () => {
    expect((await checkout(customer, [{ offerId: offer.id, quantity: 1 }], null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await checkout(customer, [{ offerId: randomUUID(), quantity: 1 }])).json().error.code).toBe('OFFER_UNAVAILABLE');
    const abroad = await app.inject({
      method: 'POST',
      url: '/v1/stores/mb-parfum/orders',
      headers: { ...bearer(customer.token), 'idempotency-key': randomUUID() },
      payload: {
        lines: [{ offerId: offer.id, quantity: 1 }],
        paymentMethod: 'cash_on_delivery',
        shippingAddress: { ...address, country: 'FR' },
        delivery: [{ merchantId, methodId: randomUUID() }],
      },
    });
    expect(abroad.json().error.code).toBe('COUNTRY_NOT_SERVED');

    const tooMany = await checkout(customer, [
      { offerId: mbOfferId, quantity: 1 },
      { offerId: offer.id, quantity: 6 },
    ]);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error).toMatchObject({ code: 'OUT_OF_STOCK', details: { offerId: offer.id, requested: 6, available: 5 } });
    expect((await call('GET', '/v1/me/orders', customer.token)).json().data).toEqual([]);
    expect(await stock(offer.id)).toEqual({ onHand: 5, reserved: 0, available: 5 });
  });

  let orderA: any;
  let key: string;

  it('splits a checkout into one order per merchant, priced by the server, with stock reserved', async () => {
    key = randomUUID();
    const mbBefore = await stock(mbOfferId);
    const res = await checkout(customer, [
      { offerId: offer.id, quantity: 2, unitPriceMinor: 1 } as any, // a client-side price is ignored
      { offerId: mbOfferId, quantity: 1 },
    ], key);
    expect(res.statusCode).toBe(201);
    const { checkoutId, orders } = res.json().data;
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((o: any) => o.checkoutId))).toEqual(new Set([checkoutId]));

    orderA = orders.find((o: any) => o.merchantId === merchantId);
    expect(orderA).toMatchObject({
      status: 'new',
      currency: 'DZD',
      subtotalMinor: 700000,
      shippingMinor: 0,
      totalMinor: 700000,
      paymentMethod: 'cash_on_delivery',
      shippingAddress: storedAddress,
      delivery: { type: 'merchant_delivery', name: 'Livraison par nos soins' },
      shipment: null,
      lines: [{ sku: offer.sku, quantity: 2, unitPriceMinor: 350000, lineTotalMinor: 700000, productNames: { ar: 'ورد الطائف', fr: 'Rose de Taïf' } }],
      allowedTransitions: [{ to: 'cancelled', reasonRequired: false }],
    });
    expect(orderA.number).toMatch(/^\d{4}-\d{6}$/);
    expect(orderA.commissionBps).toBeUndefined(); // not shown to customers
    expect(orderA.history).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'new', actorType: 'customer' })]);

    expect(await stock(offer.id)).toEqual({ onHand: 5, reserved: 2, available: 3 });
    expect((await stock(mbOfferId)).reserved).toBe(mbBefore.reserved + 1);
  });

  it('is safe to retry: the same Idempotency-Key returns the same orders', async () => {
    const again = await checkout(customer, [{ offerId: offer.id, quantity: 2 }, { offerId: mbOfferId, quantity: 1 }], key);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.orders.map((o: any) => o.id).sort()).toEqual(
      (await call('GET', '/v1/me/orders', customer.token)).json().data.map((o: any) => o.id).sort(),
    );
    expect((await stock(offer.id)).reserved).toBe(2);

    const k = randomUUID();
    const [r1, r2] = await Promise.all([checkout(customer, [{ offerId: offer.id, quantity: 1 }], k), checkout(customer, [{ offerId: offer.id, quantity: 1 }], k)]);
    expect(r1.json().data.orders[0].id).toBe(r2.json().data.orders[0].id);
    expect((await stock(offer.id)).reserved).toBe(3);
    // Cancel that extra order so the rest of the suite starts from 2 reserved.
    await call('POST', `/v1/me/orders/${r1.json().data.orders[0].id}/cancel`, customer.token, {});
  });

  it('keeps the order price even if the merchant changes it later', async () => {
    await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, {
      variantId: (await db.select().from(s.offers).where(eq(s.offers.id, offer.id)))[0]!.variantId,
      prices: [{ currency: 'DZD', amountMinor: 999900 }],
    });
    const again = (await call('GET', `/v1/me/orders/${orderA.id}`, customer.token)).json().data;
    expect(again.lines[0].unitPriceMinor).toBe(350000);
  });

  it('shows customers only their own orders', async () => {
    expect((await call('GET', `/v1/me/orders/${orderA.id}`, otherCustomer.token)).statusCode).toBe(404);
    expect((await call('GET', '/v1/me/orders', otherCustomer.token)).json().data).toEqual([]);
  });

  describe('merchant flow', () => {
    it('shows the merchant only its own part of the checkout', async () => {
      const list = (await call('GET', `/v1/merchants/${merchantId}/orders`, staff.token)).json().data;
      expect(list.map((o: any) => o.id)).toContain(orderA.id);
      expect(list.every((o: any) => o.merchantId === merchantId)).toBe(true);
      const detail = (await call('GET', mUrl(orderA.id), staff.token)).json().data;
      expect(detail).toMatchObject({ commissionBps: 1200, shippingAddress: { phone: '+213661234567' } });
      expect(detail.allowedTransitions.map((t: any) => t.to)).toEqual(['processing', 'cancelled']);
    });

    it('refuses transitions that skip steps', async () => {
      const res = await move(staff, orderA.id, { to: 'delivered' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'new', to: 'delivered' } });
    });

    it('confirms, prepares and ships; shipping takes the stock out of the warehouse', async () => {
      expect((await move(staff, orderA.id, { to: 'processing', note: 'Confirmé par téléphone' })).json().data.status).toBe('processing');
      expect((await move(staff, orderA.id, { to: 'preparing' })).json().data.status).toBe('preparing');
      // Customers can no longer cancel once preparation started.
      expect((await call('POST', `/v1/me/orders/${orderA.id}/cancel`, customer.token, {})).statusCode).toBe(403);
      await move(staff, orderA.id, { to: 'shipping', note: 'Yalidine 123456' });
      expect(await stock(offer.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
      expect((await move(staff, orderA.id, { to: 'delivered' })).json().data.status).toBe('delivered');
    });

    it('lets only owners and managers record a return, with a reason and a restock decision', async () => {
      expect((await move(staff, orderA.id, { to: 'returned', reason: 'x', restock: true })).statusCode).toBe(403);
      expect((await move(owner, orderA.id, { to: 'returned', restock: true })).json().error.code).toBe('REASON_REQUIRED');
      expect((await move(owner, orderA.id, { to: 'returned', reason: 'Flacon non conforme' })).json().error.code).toBe('RESTOCK_REQUIRED');
      const res = await move(owner, orderA.id, { to: 'returned', reason: 'Le client a changé d’avis', restock: true });
      expect(res.json().data.status).toBe('returned');
      expect(await stock(offer.id)).toEqual({ onHand: 5, reserved: 0, available: 5 });
    });

    it('never lets a merchant refund: money goes back only through the refund flow', async () => {
      expect((await move(owner, orderA.id, { to: 'refunded', reason: 'x' })).statusCode).toBe(403);
      // Even an administrator cannot just mark it refunded: the money must actually be returned.
      expect((await call('POST', `/v1/admin/orders/${orderA.id}/status`, admin.token, { to: 'refunded', reason: 'x' })).json().error.code).toBe('USE_REFUND');
      const refundUrl = `/v1/admin/orders/${orderA.id}/refunds`;
      const refund = (user: TestUser, body: object) =>
        app.inject({ method: 'POST', url: refundUrl, headers: { ...bearer(user.token), 'idempotency-key': randomUUID() }, payload: body });
      expect((await refund(support, { amountMinor: 700000, reason: 'Retour' })).statusCode).toBe(403);
      // Cash on delivery is refunded outside ARUMA: the proof is required.
      expect((await refund(admin, { amountMinor: 700000, reason: 'Retour accepté' })).json().error.code).toBe('EXTERNAL_REFERENCE_REQUIRED');
      expect((await refund(admin, { amountMinor: 700001, reason: 'Retour accepté', externalReference: 'x' })).json().error.code).toBe('REFUND_EXCEEDS_ORDER');
      const done = await refund(admin, { amountMinor: 700000, reason: 'Remboursé en espèces au point relais', externalReference: 'RECU-0042' });
      expect(done.json().data).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', refundedMinor: 700000 });
      expect(done.json().data.allowedTransitions).toEqual([]);
    });

    it('records every change: who, when, from, to, why', async () => {
      const { history } = (await call('GET', mUrl(orderA.id), owner.token)).json().data;
      expect(history.map((h: any) => [h.fromStatus, h.toStatus, h.actorType, h.reason])).toEqual([
        [null, 'new', 'customer', null],
        ['new', 'processing', 'merchant', null],
        ['processing', 'preparing', 'merchant', null],
        ['preparing', 'shipping', 'merchant', null],
        ['shipping', 'delivered', 'merchant', null],
        ['delivered', 'returned', 'merchant', 'Le client a changé d’avis'],
        ['returned', 'refunded', 'platform', 'Remboursé en espèces au point relais'],
      ]);
      expect(history.every((h: any) => h.createdAt && h.actorName)).toBe(true);
      expect(history[1].note).toBe('Confirmé par téléphone');
      expect(history[5].note).toBe('restock: yes');
      // The customer sees roles, not staff names.
      const forCustomer = (await call('GET', `/v1/me/orders/${orderA.id}`, customer.token)).json().data.history;
      expect(forCustomer[1]).toMatchObject({ actorType: 'merchant', actorName: null });
    });
  });

  describe('cancellations', () => {
    it('lets the customer cancel a new order without a reason; stock comes back', async () => {
      const order = (await checkout(customer, [{ offerId: offer.id, quantity: 2 }])).json().data.orders[0];
      expect((await stock(offer.id)).available).toBe(3);
      const res = await call('POST', `/v1/me/orders/${order.id}/cancel`, customer.token, {});
      expect(res.json().data.status).toBe('cancelled');
      expect(await stock(offer.id)).toEqual({ onHand: 5, reserved: 0, available: 5 });
    });

    it('requires owner or manager and a reason for a merchant cancellation', async () => {
      const order = (await checkout(customer, [{ offerId: offer.id, quantity: 1 }])).json().data.orders[0];
      expect((await move(staff, order.id, { to: 'cancelled', reason: 'x' })).statusCode).toBe(403);
      expect((await move(owner, order.id, { to: 'cancelled' })).json().error.code).toBe('REASON_REQUIRED');
      const res = await move(owner, order.id, { to: 'cancelled', reason: 'Client injoignable' });
      expect(res.json().data.history.at(-1)).toMatchObject({ fromStatus: 'new', toStatus: 'cancelled', actorType: 'merchant', reason: 'Client injoignable' });
      expect((await stock(offer.id)).reserved).toBe(0);
    });

    it('hides other merchants’ orders', async () => {
      const order = (await checkout(customer, [{ offerId: mbOfferId, quantity: 1 }])).json().data.orders[0];
      expect((await call('GET', mUrl(order.id), owner.token)).statusCode).toBe(404);
      expect((await move(owner, order.id, { to: 'cancelled', reason: 'x' })).statusCode).toBe(404);
      await call('POST', `/v1/me/orders/${order.id}/cancel`, customer.token, {});
    });
  });
});

describe('database guards', () => {
  it('rejects direct status jumps, edits to amounts, and deletions', async () => {
    const order = (await checkout(customer, [{ offerId: offer.id, quantity: 1 }])).json().data.orders[0];
    const refused = (message: RegExp) => ({ cause: expect.objectContaining({ message: expect.stringMatching(message) }) });
    await expect(db.execute(sql`update orders set status = 'delivered' where id = ${order.id}`)).rejects.toMatchObject(refused(/not allowed/));
    await expect(db.execute(sql`update orders set total_minor = 1, subtotal_minor = 1 where id = ${order.id}`)).rejects.toMatchObject(refused(/only the status/));
    await expect(db.execute(sql`delete from order_status_history where order_id = ${order.id}`)).rejects.toMatchObject(refused(/append-only/));
    await expect(db.execute(sql`update order_lines set quantity = 9 where order_id = ${order.id}`)).rejects.toMatchObject(refused(/append-only/));
    await expect(db.execute(sql`delete from orders where id = ${order.id}`)).rejects.toMatchObject(refused(/append-only/));
    await call('POST', `/v1/me/orders/${order.id}/cancel`, customer.token, {});
  });

  it('counts orders on the merchant dashboard', async () => {
    const d = (await call('GET', `/v1/merchants/${merchantId}/dashboard`, staff.token)).json().data;
    // Cancelled: the retry test's extra order, two cancellation tests, and the guard test's order.
    expect(d.orders).toEqual({ refunded: 1, cancelled: 4 });
  });
});
