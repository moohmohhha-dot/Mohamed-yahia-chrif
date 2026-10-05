import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { escalateOverdueReturns } from '../src/modules/returns/index.js';
import { bearer, buildTestApp, caller, dzAddress, multipartFile, PNG, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let owner: TestUser;
let staff: TestUser;
let customer: TestUser;
let stranger: TestUser;
let merchantId: string;
let productId: string;
let offerId: string;
let storeId: string;
let methodId: string;

const DZD = (dinars: number) => dinars * 100;
const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};
const stock = async () => (await db.select().from(s.offers).where(eq(s.offers.id, offerId)))[0]!;
const dbOrder = async (id: string) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;

/** An order placed, (paid,) and delivered: 5 000 DZD per item + 300 DZD delivery. */
async function deliveredOrder(opts: { paymentMethod?: 'cash_on_delivery' | 'online'; quantity?: number; user?: TestUser; useStoreCredit?: boolean } = {}) {
  const user = opts.user ?? customer;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(user.token), 'idempotency-key': randomUUID() },
    payload: {
      lines: [{ offerId, quantity: opts.quantity ?? 1 }],
      paymentMethod: opts.paymentMethod ?? 'cash_on_delivery',
      shippingAddress: dzAddress('DZ-16-C-alger-centre'),
      delivery: [{ merchantId, methodId }],
      useStoreCredit: opts.useStoreCredit,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data;
  if (data.payment?.redirectUrl) {
    await app.payInSandbox(data.payment.redirectUrl, 'paid');
    await app.flushPaymentEvents();
  }
  const order = data.orders[0];
  for (const to of ['processing', 'preparing', 'shipping', 'delivered']) await ok(await call('POST', `/v1/merchants/${merchantId}/orders/${order.id}/status`, owner.token, { to }));
  return ok(await call('GET', `/v1/me/orders/${order.id}`, user.token));
}

const me = (path: string, user = customer, payload?: unknown, method: 'POST' | 'GET' = 'POST') => call(method, `/v1/me${path}`, user.token, payload);
const mUrl = (returnId: string) => `/v1/merchants/${merchantId}/returns/${returnId}`;
const merchant = (returnId: string, path: string, payload?: unknown, user = owner) => call('POST', `${mUrl(returnId)}${path}`, user.token, payload);
const upload = (url: string, user: TestUser, body = PNG) => {
  const { payload, headers } = multipartFile(body);
  return app.inject({ method: 'POST', url, payload, headers: { ...headers, ...bearer(user.token) } });
};

/** A return requested (submitted) for the order's first line. */
async function requestReturn(order: any, input: { reason?: string; resolution?: string; quantity?: number; user?: TestUser } = {}) {
  const user = input.user ?? customer;
  const ret = await ok(
    await me(`/orders/${order.id}/returns`, user, {
      lines: [{ orderLineId: order.lines[0].id, quantity: input.quantity ?? 1 }],
      reason: input.reason ?? 'damaged',
      description: 'Le flacon est arrivé fissuré, le parfum a coulé.',
      resolution: input.resolution ?? 'refund',
    }),
    201,
  );
  if (['damaged', 'defective', 'wrong_item', 'not_as_described', 'missing_parts', 'counterfeit_suspected'].includes(input.reason ?? 'damaged')) {
    await ok(await upload(`/v1/me/returns/${ret.id}/evidence`, user), 201);
  }
  return ok(await me(`/returns/${ret.id}/submit`, user));
}

/** Approved with drop-off, received and inspected (passed, back on sale). */
async function throughInspection(ret: any, inspection: object = {}) {
  await ok(await merchant(ret.id, '/respond', { decision: 'approve', returnMethod: 'drop_off' }));
  await ok(await merchant(ret.id, '/receive', {}, staff));
  return call('POST', `${mUrl(ret.id)}/inspection`, owner.token, { result: 'passed', lines: ret.lines.map((l: any) => ({ returnLineId: l.id, restock: true })), ...inspection });
}

beforeAll(async () => {
  await app.ready();
  [admin, owner, staff, customer, stranger] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Returns Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  const pslug = uniqueSlug('ret');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'عنبر' }, { locale: 'fr', name: 'Ambre' }],
      variants: [{ sku: `${pslug}-50`, options: { sizeMl: 50 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 100, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] })).json().data.id;
  methodId = (await ok(await call('POST', `/v1/merchants/${merchantId}/shipping/methods`, owner.token, { type: 'merchant_delivery', name: 'Notre livreur' }), 201)).id;
  await ok(await call('PUT', `/v1/merchants/${merchantId}/shipping/methods/${methodId}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(300) }));
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
  await db.insert(s.featureFlagOverrides).values({ flagKey: 'checkout.online_payment', storeId, enabled: true }).onConflictDoNothing();
});

afterAll(async () => {
  vi.useRealTimers();
  await call('DELETE', `/v1/admin/returns-policy?storeId=${storeId}`, admin.token);
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('return request', () => {
  it('is for delivered orders, within the window, for items bought and not already returned', async () => {
    const order = await deliveredOrder({ quantity: 2 });
    const ask = (body: object, user = customer) =>
      me(`/orders/${order.id}/returns`, user, { lines: [{ orderLineId: order.lines[0].id, quantity: 1 }], reason: 'changed_mind', description: 'Je préfère une autre odeur.', resolution: 'refund', ...body });
    expect((await ask({}, stranger)).statusCode).toBe(404);
    expect((await ask({ lines: [{ orderLineId: order.lines[0].id, quantity: 3 }] })).json().error).toMatchObject({ code: 'QUANTITY_EXCEEDS_ORDER', details: { available: 2 } });
    const first = await ok(await ask({ lines: [{ orderLineId: order.lines[0].id, quantity: 2 }] }), 201);
    expect(first).toMatchObject({ status: 'draft', number: expect.stringMatching(/^RT-\d{4}-\d{6}$/), itemsValueMinor: DZD(10_000) });
    expect(first.customer).toBeUndefined();
    expect((await ask({})).json().error.code).toBe('QUANTITY_EXCEEDS_ORDER'); // both items are already in a return
    await ok(await me(`/returns/${first.id}/cancel`));
    await ok(await ask({}), 201); // cancelled returns free the items

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 8 * 24 * 3600_000 });
    const late = await ask({});
    vi.useRealTimers();
    expect(late.json().error).toMatchObject({ code: 'RETURN_WINDOW_CLOSED' });

  });

  it('needs evidence when the merchant is said to be at fault; files are checked, encrypted and only shown to the parties', async () => {
    const order = await deliveredOrder();
    const ret = await ok(
      await me(`/orders/${order.id}/returns`, customer, { lines: [{ orderLineId: order.lines[0].id, quantity: 1 }], reason: 'damaged', description: 'Le flacon est arrivé cassé.', resolution: 'refund' }),
      201,
    );
    expect((await me(`/returns/${ret.id}/submit`)).json().error.code).toBe('EVIDENCE_REQUIRED');
    expect((await upload(`/v1/me/returns/${ret.id}/evidence`, customer, Buffer.from('not an image at all'))).json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const file = await ok(await upload(`/v1/me/returns/${ret.id}/evidence`, customer), 201);
    expect(file).toMatchObject({ role: 'customer', contentType: 'image/png' });
    expect(file.storageKey).toBeUndefined();
    expect((await call('GET', `${mUrl(ret.id)}`, owner.token)).statusCode).toBe(404); // drafts stay with the customer

    const submitted = await ok(await me(`/returns/${ret.id}/submit`));
    expect(submitted).toMatchObject({ status: 'requested', evidence: [{ id: file.id, role: 'customer' }] });
    expect(new Date(submitted.responseDueAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

    const download = await app.inject({ method: 'GET', url: `${mUrl(ret.id)}/evidence/${file.id}`, headers: bearer(staff.token) });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG)).toBe(true);
    const [stored] = await db.select().from(s.returnEvidence).where(eq(s.returnEvidence.id, file.id));
    expect(stored!.storageKey).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/v1/me/returns/${ret.id}/evidence/${file.id}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
  });
});

describe('merchant response and ARUMA review', () => {
  it('rejection → escalation → ARUMA approves; drop-off, inspection and a cash-on-delivery refund sent by transfer', async () => {
    const order = await deliveredOrder();
    const before = await stock();
    const ret = await requestReturn(order);
    expect(ret.itemsValueMinor).toBe(DZD(5_300)); // everything comes back because of the merchant: delivery too

    expect((await merchant(ret.id, '/respond', { decision: 'reject', note: 'x' }, staff)).statusCode).toBe(403);
    expect((await merchant(ret.id, '/respond', { decision: 'reject' })).json().error.code).toBe('REASON_REQUIRED');
    const rejected = await ok(await merchant(ret.id, '/respond', { decision: 'reject', note: 'Le flacon était intact à l’envoi' }));
    expect(rejected).toMatchObject({ status: 'rejected', merchantNote: 'Le flacon était intact à l’envoi', finalDecision: false });

    const escalated = await ok(await me(`/returns/${ret.id}/escalate`, customer, { reason: 'Les photos montrent le flacon cassé à l’ouverture.' }));
    expect(escalated.status).toBe('under_review');
    expect((await call('POST', `/v1/admin/returns/${ret.id}/decision`, owner.token, { decision: 'approve', note: 'ok ok' })).statusCode).toBe(403);
    const approved = await ok(await call('POST', `/v1/admin/returns/${ret.id}/decision`, admin.token, { decision: 'approve', returnMethod: 'drop_off', note: 'Photos probantes' }));
    expect(approved).toMatchObject({ status: 'approved', resolution: 'refund', approvedAmountMinor: DZD(5_300), finalDecision: true });

    await ok(await merchant(ret.id, '/receive', { note: 'Déposé en boutique' }, staff));
    const done = await ok(await call('POST', `${mUrl(ret.id)}/inspection`, owner.token, { result: 'passed', lines: [{ returnLineId: ret.lines[0].id, restock: false }] }));
    // Cash on delivery: the money goes back by transfer, recorded by ARUMA with its reference.
    expect(done).toMatchObject({ status: 'refund_pending', finalAmountMinor: DZD(5_300) });
    expect((await stock()).onHandQuantity).toBe(before.onHandQuantity); // damaged: not back on sale
    expect((await call('POST', `/v1/admin/returns/${ret.id}/refund`, admin.token, {})).json().error.code).toBe('MANUAL_REFUND_REQUIRED');
    const refunded = await ok(await call('POST', `/v1/admin/returns/${ret.id}/refund`, admin.token, { externalReference: 'CCP-VIR-88812' }));
    expect(refunded).toMatchObject({ status: 'completed', refundReference: 'CCP-VIR-88812' });
    expect(await dbOrder(order.id)).toMatchObject({ status: 'refunded', refundedMinor: BigInt(DZD(5_300)) });

    const mine = await ok(await me(`/returns/${ret.id}`, customer, undefined, 'GET'));
    expect(mine.refundReference).toBeUndefined();
    expect(mine.events.map((e: any) => e.type)).toEqual(['created', 'evidence_added', 'submitted', 'merchant_rejected', 'escalated', 'admin_approved', 'received', 'inspected', 'note', 'refund_recorded']);
    expect(mine.events.filter((e: any) => e.actorType === 'merchant').every((e: any) => e.actorName === null)).toBe(true);
  });

  it('goes to ARUMA when the merchant does not answer in time; ARUMA’s rejection is final', async () => {
    const ret = await requestReturn(await deliveredOrder());
    expect(await escalateOverdueReturns(db, new Date(Date.now() + 49 * 3600_000))).toBeGreaterThanOrEqual(1);
    const view = await ok(await call('GET', `/v1/admin/returns/${ret.id}`, admin.token));
    expect(view).toMatchObject({ status: 'under_review', escalationReason: 'The merchant did not answer in time' });
    expect(view.events.at(-1)).toMatchObject({ type: 'escalated', actorType: 'system' });
    await ok(await call('POST', `/v1/admin/returns/${ret.id}/decision`, admin.token, { decision: 'reject', note: 'Hors conditions de retour' }));
    expect((await me(`/returns/${ret.id}/escalate`, customer, { reason: 'Je conteste encore cette décision.' })).json().error.code).toBe('FINAL_DECISION');
  });
});

describe('pickup, inspection and partial refund', () => {
  it('the courier collects the item; the inspection finds a missing part: partial refund, paid back online automatically', async () => {
    const order = await deliveredOrder({ paymentMethod: 'online', quantity: 2 });
    const ret = await requestReturn(order, { reason: 'missing_parts' });
    expect(ret.itemsValueMinor).toBe(DZD(5_000)); // one of two items: no delivery refund
    await ok(await merchant(ret.id, '/respond', { decision: 'approve', returnMethod: 'pickup', note: 'Nous passons récupérer le colis' }));
    const pickup = (await ok(await merchant(ret.id, '/pickup', { courierCode: 'yalidine', trackingNumber: `YAL-R-${randomUUID().slice(0, 8)}` }, staff))).pickup;
    expect(pickup).toMatchObject({ status: 'pending', courierCode: 'yalidine', destination: { type: 'merchant_location' } });
    expect((await ok(await merchant(ret.id, '/pickup/status', { status: 'in_transit', location: 'Alger Centre' }, staff))).status).toBe('in_transit');
    expect((await ok(await merchant(ret.id, '/pickup/status', { status: 'delivered' }, staff))).status).toBe('received');
    expect((await call('GET', `/v1/merchants/${merchantId}/orders/${order.id}`, owner.token)).json().data.shipment.status).toBe('delivered'); // the order's own parcel is untouched

    const inspect = (body: object) => call('POST', `${mUrl(ret.id)}/inspection`, owner.token, { result: 'passed', lines: [{ returnLineId: ret.lines[0].id, restock: false }], ...body });
    expect((await inspect({ amountMinor: DZD(6_000) })).json().error.code).toBe('AMOUNT_EXCEEDS_APPROVED');
    expect((await inspect({ amountMinor: DZD(4_000) })).json().error.code).toBe('PARTIAL_REASON_REQUIRED');
    const done = await ok(await inspect({ amountMinor: DZD(4_000), partialReason: 'Le bouchon manque mais le flacon est utilisable' }));
    expect(done).toMatchObject({ status: 'completed', finalAmountMinor: DZD(4_000), partialReason: 'Le bouchon manque mais le flacon est utilisable' });
    expect(await dbOrder(order.id)).toMatchObject({ status: 'delivered', refundedMinor: BigInt(DZD(4_000)), paymentStatus: 'successful' });
    const [entry] = await db.select().from(s.journalEntries).where(sql`${s.journalEntries.orderId} = ${order.id} and ${s.journalEntries.kind} = 'refund'`);
    // Shares in proportion to the whole order (10 300 DZD with 800 of commission): 4 000 × 800 / 10 300 = 310.68.
    expect(entry!.metadata).toMatchObject({ amount: DZD(4_000), commissionShare: 31_068, merchantShare: 368_932 });
  });

  it('a failed inspection can be escalated; ARUMA can still resolve it, partially', async () => {
    const ret = await requestReturn(await deliveredOrder(), { reason: 'defective' });
    const failed = await throughInspection(ret, { result: 'failed' });
    expect(failed.json().error.code).toBe('REASON_REQUIRED');
    const inspected = await ok(await call('POST', `${mUrl(ret.id)}/inspection`, owner.token, { result: 'failed', lines: [{ returnLineId: ret.lines[0].id, restock: false }], note: 'Le flacon a été utilisé à moitié' }));
    expect(inspected.status).toBe('inspection_failed');
    await ok(await upload(`${mUrl(ret.id)}/evidence`, owner), 201);
    await ok(await me(`/returns/${ret.id}/escalate`, customer, { reason: 'Le vaporisateur ne fonctionnait pas dès le début.' }));
    const decided = await ok(
      await call('POST', `/v1/admin/returns/${ret.id}/decision`, admin.token, { decision: 'approve', amountMinor: DZD(2_500), partialReason: 'Moitié utilisée', note: 'Geste commercial partagé' }),
    );
    // Store credit instead of the refund the customer asked for is not allowed (only what was asked, or a refund).
    expect(decided).toMatchObject({ status: 'refund_pending', resolution: 'refund', finalAmountMinor: DZD(2_500), evidence: [{ role: 'customer' }, { role: 'merchant' }] });
  });
});

describe('store credit', () => {
  let balance = 0;

  it('a change-of-mind return resolved with store credit (minus the store’s return fee)', async () => {
    await ok(await call('PUT', `/v1/admin/returns-policy?storeId=${storeId}`, admin.token, { windowDays: 7, merchantResponseHours: 48, escalationDays: 7, allowChangeOfMind: true, changeOfMindFeeMinor: DZD(500) }));
    balance = (await ok(await me('/store-credit', customer, undefined, 'GET'))).balances.find((b: any) => b.currency === 'DZD')?.balanceMinor ?? 0;
    const ret = await requestReturn(await deliveredOrder(), { reason: 'changed_mind', resolution: 'store_credit' });
    expect((await merchant(ret.id, '/respond', { decision: 'approve', resolution: 'replacement', returnMethod: 'drop_off' })).json().error.code).toBe('RESOLUTION_NOT_ALLOWED');
    const before = await stock();
    const done = await ok(await throughInspection(ret));
    expect(done).toMatchObject({ status: 'completed', approvedAmountMinor: DZD(4_500), finalAmountMinor: DZD(4_500) });
    expect((await stock()).onHandQuantity).toBe(before.onHandQuantity + 1); // unopened: back on sale
    const credit = await ok(await me('/store-credit', customer, undefined, 'GET'));
    expect(credit.balances).toEqual([{ currency: 'DZD', balanceMinor: balance + DZD(4_500) }]);
    expect(credit.movements[0]).toMatchObject({ kind: 'issued', amountMinor: DZD(4_500) });
    balance += DZD(4_500);
  });

  it('pays part of the next order; the cash to collect is the rest; a cancelled order gives the credit back', async () => {
    const order = await deliveredOrder({ useStoreCredit: true, quantity: 2 }); // 10 300 DZD
    expect(order).toMatchObject({ totalMinor: DZD(10_300), creditAppliedMinor: balance, amountToPayMinor: DZD(10_300) - balance });
    expect((await ok(await me('/store-credit', customer, undefined, 'GET'))).balances[0].balanceMinor).toBe(0);
    const intent = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0]!;
    expect(intent.paymentStatus).toBe('successful');

    // Credit back: a new credit, then an order cancelled before delivery.
    const ret = await requestReturn(await deliveredOrder(), { reason: 'changed_mind', resolution: 'store_credit' });
    await ok(await throughInspection(ret));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stores/mb-parfum/orders',
      headers: { ...bearer(customer.token), 'idempotency-key': randomUUID() },
      payload: { lines: [{ offerId, quantity: 1 }], paymentMethod: 'cash_on_delivery', shippingAddress: dzAddress(), delivery: [{ merchantId, methodId }], useStoreCredit: true },
    });
    const pending = res.json().data.orders[0];
    expect(pending.creditAppliedMinor).toBe(DZD(4_500));
    await ok(await me(`/orders/${pending.id}/cancel`, customer, {}));
    const credit = await ok(await me('/store-credit', customer, undefined, 'GET'));
    expect(credit.balances[0].balanceMinor).toBe(DZD(4_500));
    expect(credit.movements.map((m: any) => m.kind).slice(0, 3)).toEqual(['restored', 'used', 'issued']);
  });

  it('keeps customers’ balances equal to the ledger, and the ledger balanced', async () => {
    const run = await ok(await call('POST', '/v1/admin/finance/reconciliation', admin.token, { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() }), 201);
    expect(run.discrepancies.filter((d: any) => d.check.startsWith('store_credit') || d.check === 'cancelled_credit_not_restored')).toEqual([]);
    const tb = await ok(await call('GET', '/v1/admin/finance/trial-balance', admin.token));
    expect(tb.currencies.every((c: any) => c.balanced)).toBe(true);
  });
});

describe('replacement', () => {
  it('sends a free replacement order; when nothing is left, ARUMA resolves with a refund instead', async () => {
    const ret = await requestReturn(await deliveredOrder(), { reason: 'wrong_item', resolution: 'replacement' });
    const done = await ok(await throughInspection(ret));
    expect(done).toMatchObject({ status: 'completed', resolution: 'replacement', replacementOrder: { status: 'new' } });
    const replacement = await dbOrder(done.replacementOrder.id);
    expect(replacement).toMatchObject({ totalMinor: 0n, paymentStatus: 'successful', replacementForOrderId: done.orderId });
    for (const to of ['processing', 'preparing', 'shipping', 'delivered']) await ok(await call('POST', `/v1/merchants/${merchantId}/orders/${replacement.id}/status`, owner.token, { to }));

    // Out of stock: the replacement cannot be created.
    const empty = await requestReturn(await deliveredOrder(), { reason: 'wrong_item', resolution: 'replacement' });
    const variantId = (await stock()).variantId;
    await ok(await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 0, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] }));
    const out = await throughInspection(empty, { lines: empty.lines.map((l: any) => ({ returnLineId: l.id, restock: false })) });
    expect(out.json().error.code).toBe('OUT_OF_STOCK');
    await ok(await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 100, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] }));
    const resolved = await ok(await call('POST', `/v1/admin/returns/${empty.id}/decision`, admin.token, { decision: 'approve', resolution: 'refund', note: 'Plus de stock : remboursement' }));
    expect(resolved).toMatchObject({ status: 'refund_pending', resolution: 'refund' });
  });
});

describe('records', () => {
  it('cannot be rewritten or deleted', async () => {
    const [ret] = await db.select().from(s.returnRequests).limit(1);
    await expect(db.execute(sql`update return_events set note = 'x' where return_id = ${ret!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from return_requests where id = ${ret!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from return_evidence`)).rejects.toThrow();
    await expect(db.execute(sql`delete from store_credit_transactions`)).rejects.toThrow();
    await expect(db.execute(sql`update store_credit_accounts set balance_minor = balance_minor + 100000`)).rejects.toThrow();
  });

  it('lists returns for the merchant (without drafts) and for ARUMA', async () => {
    const list = await ok(await call('GET', `/v1/merchants/${merchantId}/returns`, staff.token));
    expect(list.length).toBeGreaterThan(5);
    expect(list.every((r: any) => r.status !== 'draft')).toBe(true);
    expect((await call('GET', `/v1/merchants/${merchantId}/returns`, stranger.token)).statusCode).toBe(404);
    expect((await ok(await call('GET', '/v1/admin/returns?status=under_review', admin.token))).every((r: any) => r.status === 'under_review')).toBe(true);
  });
});
