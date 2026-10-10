import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { sandboxSignature } from '../src/modules/shipping/index.js';
import { bearer, buildTestApp, caller, dzAddress, lastCode, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser, makeStaff } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let owner: TestUser;
let staff: TestUser;
let customer: TestUser;
let merchantId: string;
let productId: string;
let offerId: string;
let storeId: string;
let ownDelivery: string;
let courier: string;

const DZD = (dinars: number) => dinars * 100;
/** A fresh Algerian mobile number, so each scenario has its own customer history. */
const newPhone = () => `0661${randomInt(100_000, 999_999)}`;
const intl = (local: string) => `+213${local.slice(1)}`;
const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};

const placeCod = (opts: { phone: string; user?: TestUser; methodId?: string; quantity?: number }) =>
  app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer((opts.user ?? customer).token), 'idempotency-key': randomUUID() },
    payload: {
      lines: [{ offerId, quantity: opts.quantity ?? 1 }],
      paymentMethod: 'cash_on_delivery',
      shippingAddress: dzAddress('DZ-16-C-alger-centre', { phone: opts.phone }),
      delivery: [{ merchantId, methodId: opts.methodId ?? ownDelivery }],
    },
  });
const order = async (opts: Parameters<typeof placeCod>[0]) => (await ok(await placeCod(opts), 201)) as { checkoutId: string; orders: any[]; cod: any };

const mUrl = (orderId: string) => `/v1/merchants/${merchantId}/orders/${orderId}`;
const callResult = (orderId: string, outcome: string, user = staff, note?: string) => call('POST', `${mUrl(orderId)}/cod/calls`, user.token, { outcome, note });
const move = (orderId: string, body: object, user = owner) => call('POST', `${mUrl(orderId)}/status`, user.token, body);
const parcel = (orderId: string, body: object = {}) => call('POST', `${mUrl(orderId)}/shipment`, staff.token, body);
const parcelStatus = (orderId: string, body: object) => call('POST', `${mUrl(orderId)}/shipment/status`, staff.token, body);
const merchantView = async (orderId: string) => ok(await call('GET', mUrl(orderId), owner.token));
const available = async () => (await db.select().from(s.offers).where(eq(s.offers.id, offerId)))[0]!.availableQuantity;

/** A COD order confirmed by phone and handed over (with a parcel), ready for delivery attempts. */
async function confirmedAndSent(methodId = ownDelivery, phone = newPhone(), user?: TestUser) {
  const { orders } = await order({ phone, methodId, user });
  const id = orders[0].id;
  await ok(await callResult(id, 'confirmed'));
  await ok(await parcel(id, methodId === courier ? { trackingNumber: `YAL-${randomInt(100_000, 999_999)}` } : {}), 201);
  await ok(await parcelStatus(id, { status: methodId === courier ? 'in_transit' : 'out_for_delivery' }));
  return { id, phone };
}

beforeAll(async () => {
  await app.ready();
  [admin, owner, staff, customer] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await makeStaff(db, admin.userId, 'super_admin');
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'COD Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  const pslug = uniqueSlug('cod');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'مسك' }, { locale: 'fr', name: 'Musc' }],
      variants: [{ sku: `${pslug}-50`, options: { sizeMl: 50 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 200, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] })).json().data.id;
  const base = `/v1/merchants/${merchantId}/shipping`;
  ownDelivery = (await ok(await call('POST', `${base}/methods`, owner.token, { type: 'merchant_delivery', name: 'Notre livreur' }), 201)).id;
  await ok(await call('PUT', `${base}/methods/${ownDelivery}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(300) }));
  courier = (await ok(await call('POST', `${base}/methods`, owner.token, { type: 'courier', name: 'Yalidine', courierCode: 'yalidine' }), 201)).id;
  await ok(await call('PUT', `${base}/methods/${courier}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(500) }));
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
  // MB Parfum's own COD rules for this file: confirm every order, 3 calls, 2 delivery attempts, COD stops after 2 refusals, 50 000 DZD at most.
  await ok(
    await call('PUT', `/v1/admin/cod/policy?storeId=${storeId}`, admin.token, {
      requireConfirmation: true,
      maxCallAttempts: 3,
      maxDeliveryAttempts: 2,
      blockAfterRefusals: 2,
      maxAmountMinor: DZD(50_000),
    }),
  );
});

afterAll(async () => {
  await call('DELETE', `/v1/admin/cod/policy?storeId=${storeId}`, admin.token);
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('COD rules', () => {
  it('are set by ARUMA administrators, per store or for the whole platform', async () => {
    expect(await ok(await call('GET', `/v1/admin/cod/policy?storeId=${storeId}`, admin.token))).toMatchObject({ source: 'store', maxDeliveryAttempts: 2, maxAmountMinor: DZD(50_000) });
    expect((await ok(await call('GET', '/v1/admin/cod/policy', admin.token))).source).toBe('platform');
    expect((await call('PUT', `/v1/admin/cod/policy?storeId=${storeId}`, owner.token, { requireConfirmation: false, maxCallAttempts: 1, maxDeliveryAttempts: 1, blockAfterRefusals: 0, maxAmountMinor: null })).statusCode).toBe(403);
  });

  it('refuses cash above the store limit', async () => {
    const res = await placeCod({ phone: newPhone(), quantity: 11 }); // 55 000 DZD
    expect(res.json().error).toMatchObject({ code: 'COD_AMOUNT_TOO_HIGH', details: { maxAmountMinor: DZD(50_000) } });
  });
});

describe('order confirmation', () => {
  it('by SMS code: the customer confirms, then the merchant can prepare the order', async () => {
    const phone = newPhone();
    const placed = await order({ phone });
    expect(placed.cod).toMatchObject({ confirmationRequired: true, codeSent: true });
    const sms = app.sentMessages.at(-1)!;
    expect(sms).toMatchObject({ channel: 'sms', to: intl(phone), template: 'cod.confirmation_code', params: { amountMinor: String(DZD(5_300)), currency: 'DZD' } });

    const o = placed.orders[0];
    expect(o.cod).toEqual({
      confirmationStatus: 'pending',
      confirmedVia: null,
      confirmedAt: null,
      amountDueMinor: DZD(5_300), // 5 000 of goods + 300 of delivery
      currency: 'DZD',
      deliveryAttempts: 0,
      nextAttemptAt: null,
      outcome: 'open',
    }); // no risk, no history for the customer

    const view = await merchantView(o.id);
    expect(view.allowedTransitions.map((t: any) => t.to)).toEqual(['cancelled']);
    expect((await move(o.id, { to: 'processing' })).json().error.code).toBe('COD_NOT_CONFIRMED');

    const confirmUrl = `/v1/me/checkouts/${placed.checkoutId}/cod/confirm`;
    expect((await call('POST', confirmUrl, customer.token, { code: '000000' === sms.params.code ? '111111' : '000000' })).json().error.code).toBe('INVALID_CODE');
    expect((await call('POST', confirmUrl, (await registerUser(app)).token, { code: sms.params.code })).json().error.code).toBe('NOTHING_TO_CONFIRM');
    expect(await ok(await call('POST', confirmUrl, customer.token, { code: lastCode(app, intl(phone)) }))).toEqual({ confirmed: 1 });
    expect((await ok(await move(o.id, { to: 'processing' }))).cod).toMatchObject({ confirmationStatus: 'confirmed', confirmedVia: 'sms_code' });
  });

  it('by phone: each call is recorded; "confirmed" confirms the order', async () => {
    const { orders } = await order({ phone: newPhone() });
    const id = orders[0].id;
    expect((await ok(await callResult(id, 'no_answer'))).cod).toMatchObject({ confirmationStatus: 'pending', callAttempts: 1 });
    await ok(await callResult(id, 'call_back_later', staff, 'Rappeler après 18h'));
    const confirmed = await ok(await callResult(id, 'confirmed', staff));
    expect(confirmed).toMatchObject({ status: 'processing', cod: { confirmationStatus: 'confirmed', confirmedVia: 'phone_call', callAttempts: 3 } });
    expect(confirmed.cod.events.map((e: any) => [e.type, e.reason])).toEqual([
      ['created', null],
      ['code_sent', null],
      ['call', 'no_answer'],
      ['call', 'call_back_later'],
      ['call', 'confirmed'],
      ['confirmed', 'phone_call'],
    ]);
    expect(confirmed.cod.events[3]).toMatchObject({ note: 'Rappeler après 18h', actorType: 'merchant' });
    expect((await callResult(id, 'confirmed')).json().error.code).toBe('COD_ALREADY_DECIDED');
  });

  it('cancels the order (and frees the stock) when the customer declines, gives a wrong number, or cannot be reached', async () => {
    const before = await available();
    const declined = (await order({ phone: newPhone() })).orders[0].id;
    expect(await ok(await callResult(declined, 'declined'))).toMatchObject({ status: 'cancelled', cod: { confirmationStatus: 'declined', outcome: 'cancelled', collectionStatus: 'not_collected' } });

    const wrong = (await order({ phone: newPhone() })).orders[0].id;
    expect(await ok(await callResult(wrong, 'wrong_number'))).toMatchObject({ status: 'cancelled', cod: { confirmationStatus: 'unreachable' } });

    const silent = (await order({ phone: newPhone() })).orders[0].id;
    await ok(await callResult(silent, 'no_answer'));
    await ok(await callResult(silent, 'no_answer'));
    const gaveUp = await ok(await callResult(silent, 'no_answer'));
    expect(gaveUp).toMatchObject({ status: 'cancelled', cod: { confirmationStatus: 'unreachable', callAttempts: 3, maxCallAttempts: 3 } });
    expect(gaveUp.history.at(-1)).toMatchObject({ toStatus: 'cancelled', actorType: 'system', reason: 'Customer unreachable after 3 calls' });
    expect(await available()).toBe(before);
  });
});

describe('delivery attempts and collection', () => {
  it('own delivery, paid at the door: the merchant has the cash', async () => {
    const { id } = await confirmedAndSent();
    const done = await ok(await parcelStatus(id, { status: 'delivered' }));
    expect(done).toMatchObject({
      status: 'delivered',
      paymentStatus: 'successful',
      cod: { outcome: 'delivered', collectionStatus: 'with_merchant', collectedAmountMinor: DZD(5_300), deliveryAttempts: 0 },
    });
  });

  it('a failed delivery needs a reason; reattempts are scheduled until the limit, then the parcel goes back', async () => {
    const { id } = await confirmedAndSent();
    expect((await parcelStatus(id, { status: 'delivery_failed' })).json().error.code).toBe('FAILURE_REASON_REQUIRED');
    expect((await ok(await parcelStatus(id, { status: 'delivery_failed', reason: 'customer_absent' }))).cod).toMatchObject({ deliveryAttempts: 1, lastFailureReason: 'customer_absent' });

    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    expect((await call('POST', `${mUrl(id)}/cod/reattempt`, staff.token, { at: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() })).json().error.code).toBe('INVALID_DATE');
    const scheduled = await ok(await call('POST', `${mUrl(id)}/cod/reattempt`, staff.token, { at: tomorrow, note: 'Le client sera là demain matin' }));
    expect(scheduled.cod.nextAttemptAt).toBe(tomorrow);
    expect((await ok(await parcelStatus(id, { status: 'out_for_delivery' }))).cod.nextAttemptAt).toBeNull();

    await ok(await parcelStatus(id, { status: 'delivery_failed', reason: 'customer_postponed' }));
    // 2 failed attempts = the store's limit: no more reattempts, the parcel must go back.
    expect((await call('POST', `${mUrl(id)}/cod/reattempt`, staff.token, { at: tomorrow })).json().error).toMatchObject({ code: 'COD_MAX_ATTEMPTS', details: { attempts: 2, max: 2 } });
    expect((await parcelStatus(id, { status: 'out_for_delivery' })).json().error.code).toBe('COD_MAX_ATTEMPTS');
    await ok(await parcelStatus(id, { status: 'returning' }));
    await ok(await parcelStatus(id, { status: 'returned' }));
    const back = await ok(await move(id, { to: 'returned', reason: 'Échec de livraison', restock: true }));
    expect(back.cod).toMatchObject({ outcome: 'failed', collectionStatus: 'not_collected', deliveryAttempts: 2 });
    expect(back.cod.events.filter((e: any) => e.type === 'delivery_failed').map((e: any) => e.reason)).toEqual(['customer_absent', 'customer_postponed']);
  });

  it('records a refusal at the door: the parcel comes back, nothing is collected', async () => {
    // Refusals follow the customer: a fresh account, so other scenarios keep a clean record.
    const { id } = await confirmedAndSent(courier, newPhone(), await registerUser(app));
    const refused = await ok(await call('POST', `${mUrl(id)}/shipment/refusal`, staff.token, { reason: 'changed_mind', note: 'A changé d’avis' }));
    expect(refused).toMatchObject({ status: 'shipping', shipment: { status: 'returning' }, cod: { outcome: 'refused', refusalReason: 'changed_mind', collectionStatus: 'not_collected' } });
    await ok(await parcelStatus(id, { status: 'returned' }));
    expect((await ok(await move(id, { to: 'returned', reason: 'Refusé', restock: true }))).cod.outcome).toBe('refused');
  });
});

describe('cash held by couriers', () => {
  it('follows the cash from the courier to the merchant, and checks the courier’s payment adds up', async () => {
    const first = await confirmedAndSent(courier);
    const second = await confirmedAndSent(courier);
    for (const { id } of [first, second]) {
      expect((await ok(await parcelStatus(id, { status: 'delivered' }))).cod).toMatchObject({ collectionStatus: 'with_courier', collectedAmountMinor: DZD(5_500) });
    }
    const summary = await ok(await call('GET', `/v1/merchants/${merchantId}/cod/summary`, owner.token));
    expect(summary.withCourier).toEqual({ count: 2, amountMinor: DZD(11_000) });
    expect(summary.pendingRemittance.map((r: any) => r.orderId).sort()).toEqual([first.id, second.id].sort());
    expect(summary.pendingRemittance[0]).toMatchObject({ courierCode: 'yalidine', amountMinor: DZD(5_500) });
    expect((await call('GET', `/v1/merchants/${merchantId}/cod/summary`, staff.token)).statusCode).toBe(403);

    const remit = (body: object) => call('POST', `/v1/merchants/${merchantId}/cod/remittances`, owner.token, { courierCode: 'yalidine', reference: 'YAL-VIR-2026-41', orderIds: [first.id, second.id], ...body });
    const wrong = await remit({ courierFeesMinor: DZD(400), receivedMinor: DZD(10_700) });
    expect(wrong.json().error).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { collectedMinor: DZD(11_000), expectedMinor: DZD(10_600), receivedMinor: DZD(10_700) } });
    expect((await call('POST', `/v1/merchants/${merchantId}/cod/remittances`, owner.token, { courierCode: 'zr_express', reference: 'X-1', orderIds: [first.id], courierFeesMinor: 0, receivedMinor: DZD(5_500) })).json().error.code).toBe('NOT_WITH_THIS_COURIER');

    const remittance = await ok(await remit({ courierFeesMinor: DZD(400), receivedMinor: DZD(10_600) }), 201);
    expect(remittance).toMatchObject({ collectedMinor: DZD(11_000), courierFeesMinor: DZD(400), receivedMinor: DZD(10_600), orderCount: 2 });
    expect((await merchantView(first.id)).cod).toMatchObject({ collectionStatus: 'with_merchant', remittanceId: remittance.id });
    expect((await remit({ courierFeesMinor: DZD(400), receivedMinor: DZD(10_600) })).json().error.code).toBe('NOT_WITH_THIS_COURIER'); // counted once
    expect((await ok(await call('GET', `/v1/merchants/${merchantId}/cod/remittances`, owner.token)))[0].reference).toBe('YAL-VIR-2026-41');
  });

  it('records refusals and failures reported by a courier API', async () => {
    await db.insert(s.couriers).values({ code: 'sandbox', name: 'Sandbox Courier', country: 'DZ', integration: 'api' }).onConflictDoNothing();
    const secret = 'cod-sandbox-secret';
    const account = await ok(await call('POST', `/v1/merchants/${merchantId}/shipping/courier-accounts`, owner.token, { courierCode: 'sandbox', label: 'API', credentials: { apiKey: 'k', webhookSecret: secret } }), 201);
    const method = (await ok(await call('POST', `/v1/merchants/${merchantId}/shipping/methods`, owner.token, { type: 'courier', name: 'API express', courierCode: 'sandbox', courierAccountId: account.id }), 201)).id;
    await ok(await call('PUT', `/v1/merchants/${merchantId}/shipping/methods/${method}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(450) }));
    const { orders } = await order({ phone: newPhone(), methodId: method, user: await registerUser(app) });
    const id = orders[0].id;
    await ok(await callResult(id, 'confirmed'));
    const tracking = (await ok(await parcel(id), 201)).shipment.trackingNumber;
    const push = (events: object[]) => {
      const body = JSON.stringify({ events });
      return app.inject({ method: 'POST', url: `/webhooks/couriers/${account.id}`, payload: body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sandboxSignature(secret, body) } });
    };
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    await ok(await push([{ id: 'c1', tracking, status: 'picked_up', at: at(1) }, { id: 'c2', tracking, status: 'delivery_attempt_failed', reason: 'customer_absent', at: at(2) }]));
    expect((await merchantView(id)).cod).toMatchObject({ deliveryAttempts: 1, lastFailureReason: 'customer_absent' });
    await ok(await push([{ id: 'c3', tracking, status: 'refused_by_customer', at: at(3) }]));
    expect((await merchantView(id)).cod).toMatchObject({ outcome: 'refused', collectionStatus: 'not_collected' });
  });
});

describe('customer risk signals', () => {
  it('scores the customer’s COD record (by phone, across accounts), shows it to the merchant only, and stops COD after repeated refusals', async () => {
    const phone = newPhone();
    const riskCustomer = await registerUser(app);
    const first = (await order({ phone, user: riskCustomer })).orders[0];
    expect((await merchantView(first.id)).cod.risk).toEqual({ level: 'low', score: 0, reasons: [{ code: 'first_order' }] });
    expect(first.cod.risk).toBeUndefined();

    // Two refusals with this phone (the second from another account using the same phone).
    await ok(await callResult(first.id, 'confirmed'));
    await ok(await parcel(first.id), 201);
    await ok(await parcelStatus(first.id, { status: 'out_for_delivery' }));
    await ok(await call('POST', `${mUrl(first.id)}/shipment/refusal`, staff.token, { reason: 'did_not_order' }));
    const other = await registerUser(app);
    const second = await confirmedAndSent(ownDelivery, phone, other);
    const risky = await merchantView(second.id);
    expect(risky.cod.risk).toEqual({ level: 'high', score: 5, reasons: [{ code: 'previous_refusals', count: 1 }, { code: 'shared_phone', count: 2 }] });
    expect((await ok(await call('GET', `/v1/merchants/${merchantId}/orders`, owner.token))).find((o: any) => o.id === second.id).cod).toEqual({ confirmationStatus: 'confirmed', riskLevel: 'high' });
    await ok(await call('POST', `${mUrl(second.id)}/shipment/refusal`, staff.token, { reason: 'price' }));

    // The store's limit is 2 refusals: no more cash on delivery for this phone, whatever the account.
    for (const user of [riskCustomer, await registerUser(app)]) {
      expect((await placeCod({ phone, user })).json().error).toMatchObject({ code: 'COD_NOT_AVAILABLE', message: expect.stringContaining('pay online') });
    }
    const lookup = await ok(await call('GET', `/v1/admin/cod/risk?phone=${phone}`, admin.token));
    expect(lookup).toMatchObject({ phone: intl(phone), level: 'high', history: { orders: 2, refused: 2 } });
  });

  it('lets ARUMA staff block and unblock a phone, with a reason, keeping the record', async () => {
    const phone = newPhone();
    expect((await call('POST', '/v1/admin/cod/blocks', owner.token, { phone, reason: 'Fraude signalée' })).statusCode).toBe(403);
    const block = await ok(await call('POST', '/v1/admin/cod/blocks', admin.token, { phone, reason: 'Commandes fictives signalées' }), 201);
    expect(block.phone).toBe(intl(phone));
    const buyer = await registerUser(app);
    expect((await placeCod({ phone, user: buyer })).json().error.code).toBe('COD_NOT_AVAILABLE');
    expect((await call('POST', `/v1/admin/cod/blocks/${block.id}/lift`, admin.token, { reason: 'x' })).statusCode).toBe(400);
    await ok(await call('POST', `/v1/admin/cod/blocks/${block.id}/lift`, admin.token, { reason: 'Erreur de signalement' }));
    expect((await placeCod({ phone, user: buyer })).statusCode).toBe(201);
    await expect(db.execute(sql`delete from cod_blocks where id = ${block.id}`)).rejects.toThrow();
  });
});

describe('records that cannot be rewritten', () => {
  it('keeps COD history and amounts at the database level', async () => {
    const [record] = await db.select().from(s.codOrders).where(eq(s.codOrders.collectionStatus, 'with_merchant')).limit(1);
    await expect(db.execute(sql`update cod_orders set amount_due_minor = 1 where order_id = ${record!.orderId}`)).rejects.toThrow();
    await expect(db.execute(sql`update cod_orders set collection_status = 'awaiting' where order_id = ${record!.orderId}`)).rejects.toThrow();
    await expect(db.execute(sql`update cod_orders set confirmation_status = 'pending' where order_id = ${record!.orderId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from cod_orders where order_id = ${record!.orderId}`)).rejects.toThrow();
    await expect(db.execute(sql`update cod_events set note = 'x' where order_id = ${record!.orderId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from cod_remittances`)).rejects.toThrow();
  });
});
