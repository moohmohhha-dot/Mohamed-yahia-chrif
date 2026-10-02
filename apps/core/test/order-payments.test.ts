import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { expireUnpaidCheckouts } from '../src/modules/orders/payments.js';
import { createHttpPaymentsClient } from '../src/modules/payments/index.js';
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
let owner: TestUser;
let customer: TestUser;
let merchantId: string;
let productId: string;
let offerId: string;
let mbOfferId: string;
let storeId: string;

const address = dzAddress('DZ-25-C-constantine', { fullName: 'Lina Haddad', phone: '+213770112233', line1: '3 rue Ben Badis' });
const checkout = async (lines: { offerId: string; quantity: number }[], paymentMethod: 'online' | 'cash_on_delivery' = 'online', key = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(customer.token), 'idempotency-key': key },
    payload: { lines, paymentMethod, shippingAddress: address, delivery: await cheapestDelivery(app, lines, address), onlinePaymentMethod: 'cib', locale: 'fr' },
  });
const order = async (id: string) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;
const available = async (id: string) => (await db.select().from(s.offers).where(eq(s.offers.id, id)))[0]!.availableQuantity;
const merchantMove = (orderId: string, body: object) => call('POST', `/v1/merchants/${merchantId}/orders/${orderId}/status`, owner.token, body);
const refund = (orderId: string, body: object) =>
  app.inject({ method: 'POST', url: `/v1/admin/orders/${orderId}/refunds`, headers: { ...bearer(admin.token), 'idempotency-key': randomUUID() }, payload: body });

beforeAll(async () => {
  await app.ready();
  [admin, owner, customer] = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Pay Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 1000 });
  await addMerchantDelivery(app, owner, merchantId);
  const pslug = uniqueSlug('pay');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'مسك أبيض' }],
      variants: [{ sku: `${pslug}-50`, options: { sizeMl: 50 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 20, prices: [{ currency: 'DZD', amountMinor: 400000 }] })).json().data.id;
  mbOfferId = (await db.select().from(s.offers).where(eq(s.offers.sku, 'FLEUR-DE-JASMIN-75ML')))[0]!.id;
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
});

afterAll(async () => {
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('online payment', () => {
  it('is refused while the store has not switched it on', async () => {
    expect((await checkout([{ offerId, quantity: 1 }])).json().error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    await db.insert(s.featureFlagOverrides).values({ flagKey: 'checkout.online_payment', storeId, enabled: true });
  });

  let checkoutId: string;
  let ours: any;

  it('creates one payment for the whole checkout and blocks merchants until it is paid', async () => {
    const res = await checkout([
      { offerId, quantity: 2 },
      { offerId: mbOfferId, quantity: 1 },
    ]);
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    checkoutId = data.checkoutId;
    expect(data.orders).toHaveLength(2);
    expect(data.payment).toMatchObject({ status: 'pending', currency: 'DZD', amountMinor: 800000 + 690000 });
    expect(data.payment.redirectUrl).toMatch(/^http:\/\/payments\.test\/sandbox\/checkouts\//);
    ours = data.orders.find((o: any) => o.merchantId === merchantId);
    expect(ours).toMatchObject({ paymentMethod: 'online', paymentStatus: 'pending' });
    expect((await order(ours.id)).paymentIntentId).toBe(data.payment.intentId);

    const blocked = await merchantMove(ours.id, { to: 'processing' });
    expect(blocked.json().error.code).toBe('PAYMENT_NOT_COMPLETED');
  });

  it('retries after a failed payment, then succeeds; the signed event unlocks the orders', async () => {
    const first = (await call('GET', `/v1/me/checkouts/${checkoutId}/payment`, customer.token)).json().data;
    await app.payInSandbox(first.redirectUrl, 'failed');
    await app.flushPaymentEvents();
    expect((await order(ours.id)).paymentStatus).toBe('failed');
    const view = (await call('GET', `/v1/me/checkouts/${checkoutId}/payment?verify=true`, customer.token)).json().data;
    expect(view).toMatchObject({ status: 'failed', retryable: true });

    const retried = (await call('POST', `/v1/me/checkouts/${checkoutId}/payment/retry`, customer.token, {})).json().data;
    expect(retried).toMatchObject({ status: 'pending' });
    expect(retried.redirectUrl).not.toBe(first.redirectUrl);
    await app.payInSandbox(retried.redirectUrl, 'paid');
    expect(await app.flushPaymentEvents()).toBeGreaterThan(0);

    for (const o of await db.select().from(s.orders).where(eq(s.orders.checkoutId, checkoutId))) expect(o.paymentStatus).toBe('successful');
    expect((await merchantMove(ours.id, { to: 'processing' })).json().data.status).toBe('processing');
  });

  it('accepts only signed, fresh events, each once', async () => {
    const body = JSON.stringify({ id: randomUUID(), type: 'payment.cancelled', data: { intent: { id: 'x', referenceType: 'checkout', referenceId: checkoutId } } });
    const send = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/internal/payments/events', payload: body, headers: { 'content-type': 'application/json', ...headers } });
    const sign = (ts: number) => createHmac('sha256', app.eventsSecret).update(`${ts}.${body}`).digest('hex');
    const now = Math.floor(Date.now() / 1000);
    expect((await send({ 'x-aruma-timestamp': String(now), 'x-aruma-signature': 'a'.repeat(64) })).statusCode).toBe(401);
    expect((await send({ 'x-aruma-timestamp': String(now - 3600), 'x-aruma-signature': sign(now - 3600) })).statusCode).toBe(401);
    expect((await order(ours.id)).status).toBe('processing'); // nothing happened

    // A real event delivered twice is applied once.
    const valid = JSON.stringify({ id: randomUUID(), type: 'payment.failed', data: { intent: { id: 'x', referenceType: 'checkout', referenceId: checkoutId } } });
    const headers = { 'content-type': 'application/json', 'x-aruma-timestamp': String(now), 'x-aruma-signature': createHmac('sha256', app.eventsSecret).update(`${now}.${valid}`).digest('hex') };
    expect((await app.inject({ method: 'POST', url: '/internal/payments/events', payload: valid, headers })).json().data.handled).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/internal/payments/events', payload: valid, headers })).json().data.handled).toBe(false);
    expect((await order(ours.id)).paymentStatus).toBe('successful'); // a "failed" event cannot undo a payment
  });

  it('refunds part of a paid order, then the rest after cancellation; each refund counted once', async () => {
    const before = await available(offerId);
    const partial = await refund(ours.id, { amountMinor: 100000, reason: 'Geste commercial' });
    expect(partial.json().data).toMatchObject({ status: 'processing', paymentStatus: 'successful', refundedMinor: 100000 });

    const cancelled = await merchantMove(ours.id, { to: 'cancelled', reason: 'Rupture chez le fournisseur' });
    expect(cancelled.json().data).toMatchObject({ status: 'cancelled', paymentStatus: 'successful' });
    expect(await available(offerId)).toBe(before + 2);
    // The other merchant's paid order is not affected by this cancellation.
    const other = (await db.select().from(s.orders).where(and(eq(s.orders.checkoutId, checkoutId))))!.find((o) => o.id !== ours.id)!;
    expect(other.status).toBe('new');

    expect((await refund(ours.id, { amountMinor: 700001, reason: 'Annulation' })).json().error.code).toBe('REFUND_EXCEEDS_ORDER');
    const rest = await refund(ours.id, { amountMinor: 700000, reason: 'Annulation remboursée' });
    expect(rest.json().data).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', refundedMinor: 800000 });
    expect(rest.json().data.history.at(-1)).toMatchObject({ fromStatus: 'cancelled', toStatus: 'refunded', actorType: 'platform', reason: 'Annulation remboursée' });

    // The Payment Service also announces those refunds: applying them again changes nothing.
    await app.flushPaymentEvents();
    expect((await order(ours.id)).refundedMinor).toBe(800000n);
    expect(await db.select().from(s.orderRefunds).where(eq(s.orderRefunds.orderId, ours.id))).toHaveLength(2);
  });
});

describe('unpaid online checkouts', () => {
  it('cancelling one unpaid order cancels the whole checkout and its payment, releasing stock', async () => {
    const before = await available(offerId);
    const data = (await checkout([{ offerId, quantity: 1 }, { offerId: mbOfferId, quantity: 1 }])).json().data;
    expect(await available(offerId)).toBe(before - 1);
    const mine = data.orders.find((o: any) => o.merchantId === merchantId);
    const res = await call('POST', `/v1/me/orders/${mine.id}/cancel`, customer.token, {});
    expect(res.json().data.status).toBe('cancelled');
    const all = await db.select().from(s.orders).where(eq(s.orders.checkoutId, data.checkoutId));
    expect(all.map((o) => o.status)).toEqual(['cancelled', 'cancelled']);
    expect(await available(offerId)).toBe(before);
    expect((await call('GET', `/v1/me/checkouts/${data.checkoutId}/payment`, customer.token)).json().data.status).toBe('cancelled');
  });

  it('expires checkouts left unpaid, and a payment arriving afterwards is flagged for refund', async () => {
    const before = await available(offerId);
    const data = (await checkout([{ offerId, quantity: 3 }])).json().data;
    expect(await expireUnpaidCheckouts(db, { payments: app.payments }, 60, new Date(Date.now() + 2 * 3600_000))).toBeGreaterThan(0);
    expect((await order(data.orders[0].id)).status).toBe('cancelled');
    expect(await available(offerId)).toBe(before);

    // The customer still pays on an old tab: the money is recorded and an admin is asked to refund it.
    await app.payInSandbox(data.payment.redirectUrl, 'paid');
    await app.flushPaymentEvents();
    expect((await order(data.orders[0].id)).paymentStatus).toBe('successful');
    const flagged = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.action, 'orders.payment.needs_refund'), eq(s.auditLogs.entityId, data.checkoutId)));
    expect(flagged).toHaveLength(1);
  });
});

describe('cash on delivery', () => {
  it('records the cash as collected when the order is delivered', async () => {
    const data = (await checkout([{ offerId, quantity: 1 }], 'cash_on_delivery')).json().data;
    expect(data.payment).toBeNull();
    const id = data.orders[0].id;
    for (const to of ['processing', 'preparing', 'shipping']) await merchantMove(id, { to });
    expect((await order(id)).paymentStatus).toBe('pending');
    const delivered = await merchantMove(id, { to: 'delivered' });
    expect(delivered.json().data).toMatchObject({ status: 'delivered', paymentStatus: 'successful' });
  });
});

describe('Payment Service client', () => {
  it('reports an unreachable Payment Service as a temporary error', async () => {
    const client = createHttpPaymentsClient({ baseUrl: 'http://payments.invalid', token: 'x', fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(client.getIntent(randomUUID())).rejects.toMatchObject({ statusCode: 503, code: 'PAYMENTS_UNAVAILABLE' });
  });
});
