import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { releaseMaturedBalances } from '../src/modules/finance/index.js';
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
  type TestUser, makeStaff } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);
const startedAt = new Date(Date.now() - 1000);

let admin: TestUser;
let owner: TestUser;
let staff: TestUser;
let customer: TestUser;
let merchantId: string;
let productId: string;
let offerId: string;
let storeId: string;

const DZD = (dinars: number) => dinars * 100; // minor units (centimes)
const address = dzAddress('DZ-09-C-blida', { fullName: 'Sara Ait', phone: '+213661000111', line1: '9 rue Hassiba' });
const placeOrder = async (paymentMethod: 'online' | 'cash_on_delivery', quantity = 1) => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(customer.token), 'idempotency-key': randomUUID() },
    payload: { lines: [{ offerId, quantity }], paymentMethod, shippingAddress: address, delivery: await cheapestDelivery(app, [{ offerId, quantity }], address) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data as { checkoutId: string; orders: any[]; payment: any };
};
const move = (orderId: string, body: object) => call('POST', `/v1/merchants/${merchantId}/orders/${orderId}/status`, owner.token, body);
const deliver = async (orderId: string) => {
  for (const to of ['processing', 'preparing', 'shipping', 'delivered']) {
    const res = await move(orderId, { to });
    expect(res.statusCode, res.body).toBe(200);
  }
};
const balance = async () => (await call('GET', `/v1/merchants/${merchantId}/finance/balance`, owner.token)).json().data.find((b: any) => b.currency === 'DZD');
const platformNow = async (purpose: string): Promise<number> =>
  (await call('GET', '/v1/admin/finance/trial-balance', admin.token)).json().data.platformAccounts.find((a: any) => a.purpose === purpose && a.currency === 'DZD')?.balanceMinor ?? 0;
/** Platform balances are shared by every test file: measure what this file's orders changed. */
const platformAtStart: Record<string, number> = {};
const platform = async (purpose: string) => (await platformNow(purpose)) - (platformAtStart[purpose] ?? 0);
const refund = (orderId: string, amountMinor: number, extra: object = {}) =>
  app.inject({ method: 'POST', url: `/v1/admin/orders/${orderId}/refunds`, headers: { ...bearer(admin.token), 'idempotency-key': randomUUID() }, payload: { amountMinor, reason: 'Retour partiel', ...extra } });
const payOnline = async (data: { payment: any }) => {
  await app.payInSandbox(data.payment.redirectUrl, 'paid');
  await app.flushPaymentEvents();
};
const inEightDays = () => new Date(Date.now() + 8 * 24 * 3600_000);

beforeAll(async () => {
  await app.ready();
  [admin, owner, staff, customer] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await makeStaff(db, admin.userId, 'super_admin');
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Finance Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  // No merchant-specific rate: the platform rule (8 %) applies.
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  await addMerchantDelivery(app, owner, merchantId);
  const pslug = uniqueSlug('fin');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'عود ملكي' }],
      variants: [{ sku: `${pslug}-100`, options: { sizeMl: 100 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 50, prices: [{ currency: 'DZD', amountMinor: DZD(10_000) }] })).json().data.id;
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
  await db.insert(s.featureFlagOverrides).values({ flagKey: 'checkout.online_payment', storeId, enabled: true }).onConflictDoNothing();
  // Other test files' orders may have matured: release them now so this file counts only its own.
  await releaseMaturedBalances(db, inEightDays());
  for (const purpose of ['provider_clearing', 'order_funds_held', 'commission_revenue', 'provider_fees_expense', 'bank']) {
    platformAtStart[purpose] = await platformNow(purpose);
  }
});

afterAll(async () => {
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('commission: 8 % by default, configurable, frozen in each order', () => {
  it('starts at 8 % from the rules table, not from code', async () => {
    const rules = (await call('GET', '/v1/admin/finance/rules', admin.token)).json().data;
    expect(rules.current).toEqual({ platformCommissionBps: 800, holdDays: 7, orderFeeMinor: 0 });
    const stores = (await call('GET', `/v1/merchants/${merchantId}/stores`, owner.token)).json().data;
    expect(stores).toEqual([expect.objectContaining({ storeSlug: 'mb-parfum', commissionBps: 800, commissionSource: 'rules' })]);
  });

  it('applies a new rule to new orders only, and a merchant rate above the rules', async () => {
    const before = (await placeOrder('cash_on_delivery')).orders[0];
    expect(before.commissionBps).toBeUndefined(); // customers do not see it
    expect((await db.select().from(s.orders).where(eq(s.orders.id, before.id)))[0]!.commissionBps).toBe(800);

    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await call('POST', '/v1/admin/finance/commission-rules', owner.token, { bps: 1000, effectiveFrom: future, reason: 'x' })).statusCode).toBe(403);
    const created = await call('POST', '/v1/admin/finance/commission-rules', admin.token, { storeId, bps: 1000, effectiveFrom: future, reason: 'MB Parfum rate from next hour' });
    expect(created.statusCode).toBe(201);
    expect((await placeOrder('cash_on_delivery')).orders[0].id).toBeDefined(); // still 8 % now

    await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 500 });
    const special = (await placeOrder('cash_on_delivery')).orders[0];
    expect((await db.select().from(s.orders).where(eq(s.orders.id, special.id)))[0]!.commissionBps).toBe(500);
    await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });

    // Cancel these setup orders (stock comes back; nothing reaches the ledger).
    for (const o of [before, special]) await call('POST', `/v1/me/orders/${o.id}/cancel`, customer.token, {});
    const pending = (await call('GET', '/v1/me/orders?status=new', customer.token)).json().data;
    for (const o of pending) await call('POST', `/v1/me/orders/${o.id}/cancel`, customer.token, {});
  });
});

describe('the example: order 10 000 DZD → commission 800 DZD, merchant due 9 200 DZD', () => {
  let onlineOrder: any;

  it('online payment: the money is held, nothing is owed to the merchant yet', async () => {
    const data = await placeOrder('online');
    onlineOrder = data.orders[0];
    await payOnline(data);
    expect(await platform('provider_clearing')).toBe(DZD(10_000));
    expect(await platform('order_funds_held')).toBe(DZD(10_000));
    expect(await balance()).toBeUndefined(); // no merchant entry yet
  });

  it('delivery: 9 200 pending for the merchant, 800 commission for ARUMA', async () => {
    await deliver(onlineOrder.id);
    expect(await balance()).toMatchObject({ pendingMinor: DZD(9_200), availableMinor: 0, settledMinor: 0, lifetime: { salesMinor: DZD(10_000), commissionMinor: DZD(800) } });
    expect(await platform('commission_revenue')).toBe(DZD(800));
    expect(await platform('order_funds_held')).toBe(0);
  });

  it('after the 7-day hold, the 9 200 become available', async () => {
    expect(await releaseMaturedBalances(db)).toBe(0); // too early
    expect(await releaseMaturedBalances(db, inEightDays())).toBe(1);
    expect(await balance()).toMatchObject({ pendingMinor: 0, availableMinor: DZD(9_200) });
  });

  it('a partial refund of 1 000 is shared: 920 from the merchant, 80 of commission', async () => {
    const res = await refund(onlineOrder.id, DZD(1_000));
    expect(res.json().data).toMatchObject({ refundedMinor: DZD(1_000), paymentStatus: 'successful' });
    expect(await balance()).toMatchObject({ availableMinor: DZD(8_280), lifetime: { refundsMinor: DZD(1_000), commissionMinor: DZD(720) } });
    expect(await platform('commission_revenue')).toBe(DZD(720));
    expect(await platform('provider_clearing')).toBe(DZD(9_000));
  });

  it('cash on delivery: the merchant collected the cash and owes ARUMA its 800', async () => {
    const order = (await placeOrder('cash_on_delivery')).orders[0];
    await deliver(order.id);
    expect(await balance()).toMatchObject({ pendingMinor: -DZD(800), availableMinor: DZD(8_280) });
    await releaseMaturedBalances(db, inEightDays());
    expect(await balance()).toMatchObject({ pendingMinor: 0, availableMinor: DZD(7_480) });
  });
});

describe('settlement and payout', () => {
  let payout: any;

  it('settles the available balance into a payout instruction with a masked destination', async () => {
    const res = await call('POST', '/v1/admin/finance/settlements', admin.token, { merchantId, currency: 'DZD' });
    expect(res.statusCode, res.body).toBe(201);
    const { settlement } = res.json().data;
    payout = res.json().data.payout;
    expect(settlement).toMatchObject({ amountMinor: DZD(7_480), currency: 'DZD' });
    expect(settlement.number).toMatch(/^ST-\d{4}-\d{6}$/);
    expect(settlement.breakdown).toMatchObject({ salesMinor: DZD(20_000), commissionMinor: DZD(1_600), refundsMinor: DZD(1_000) });
    expect(payout).toMatchObject({ status: 'requested', amountMinor: DZD(7_480), destination: { last4: '7890', type: 'bank_account' } });
    expect(JSON.stringify(payout)).not.toContain('00799999001234567890');
    expect(await balance()).toMatchObject({ availableMinor: 0, settledMinor: DZD(7_480) });

    const again = await call('POST', '/v1/admin/finance/settlements', admin.token, { merchantId, currency: 'DZD' });
    expect(again.json().error.code).toBe('NOTHING_TO_SETTLE');
  });

  it('follows the real transfer: sent, then paid only with the bank reference', async () => {
    const url = `/v1/admin/finance/payouts/${payout.id}/status`;
    expect((await call('POST', url, admin.token, { status: 'paid', externalReference: 'x' })).json().error.code).toBe('INVALID_PAYOUT_TRANSITION');
    expect((await call('POST', url, owner.token, { status: 'sent' })).statusCode).toBe(403);
    expect((await call('POST', url, admin.token, { status: 'sent' })).json().data.status).toBe('sent');
    expect((await call('POST', url, admin.token, { status: 'paid' })).json().error.code).toBe('EXTERNAL_REFERENCE_REQUIRED');
    const paid = await call('POST', url, admin.token, { status: 'paid', externalReference: 'VIR-BNA-2026-000123' });
    expect(paid.json().data).toMatchObject({ status: 'paid', externalReference: 'VIR-BNA-2026-000123' });
    expect(await balance()).toMatchObject({ totalOwedMinor: 0, lifetime: { paidOutMinor: DZD(7_480) } });
    const merchantView = (await call('GET', `/v1/merchants/${merchantId}/finance/payouts`, owner.token)).json().data;
    expect(merchantView[0]).toMatchObject({ status: 'paid', externalReference: 'VIR-BNA-2026-000123' });
  });

  it('records the provider paying ARUMA, minus its fees, and the books close', async () => {
    const res = await call('POST', '/v1/admin/finance/provider-settlements', admin.token, {
      provider: 'chargily',
      reference: 'CHG-SETTLE-001',
      currency: 'DZD',
      grossMinor: DZD(9_000),
      feesMinor: DZD(90),
    });
    expect(res.statusCode).toBe(201);
    expect(await platform('provider_clearing')).toBe(0);
    expect(await platform('provider_fees_expense')).toBe(DZD(90));
    // Bank: +8 910 from the provider, −7 480 paid to the merchant = 1 430 = commission 1 520 − fees 90.
    expect(await platform('bank')).toBe(DZD(1_430));
    expect(await platform('commission_revenue')).toBe(DZD(1_520));
    const tb = (await call('GET', '/v1/admin/finance/trial-balance', admin.token)).json().data;
    expect(tb.currencies.every((c: any) => c.balanced)).toBe(true);
  });

  it('a failed payout gives the money back to the available balance', async () => {
    const data = await placeOrder('online');
    await payOnline(data);
    await deliver(data.orders[0].id);
    await releaseMaturedBalances(db, inEightDays());
    const { payout: p } = (await call('POST', '/v1/admin/finance/settlements', admin.token, { merchantId, currency: 'DZD' })).json().data;
    await call('POST', `/v1/admin/finance/payouts/${p.id}/status`, admin.token, { status: 'sent' });
    expect((await call('POST', `/v1/admin/finance/payouts/${p.id}/status`, admin.token, { status: 'failed' })).json().error.code).toBe('REASON_REQUIRED');
    await call('POST', `/v1/admin/finance/payouts/${p.id}/status`, admin.token, { status: 'failed', reason: 'RIB clôturé' });
    expect(await balance()).toMatchObject({ availableMinor: DZD(9_200), settledMinor: 0 });
  });
});

describe('what merchants can see and do', () => {
  it('owners and managers read their finances; staff and other merchants cannot; nobody but admins can act', async () => {
    expect((await call('GET', `/v1/merchants/${merchantId}/finance/balance`, staff.token)).statusCode).toBe(403);
    const statement = (await call('GET', `/v1/merchants/${merchantId}/finance/statement`, owner.token)).json().data;
    expect(statement.some((l: any) => l.kind === 'order_delivered' && l.amountMinor === DZD(9_200) && l.orderNumber)).toBe(true);
    expect((await call('POST', '/v1/admin/finance/settlements', owner.token, { merchantId, currency: 'DZD' })).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/finance/release', owner.token)).statusCode).toBe(403);
  });
});

describe('an auditable ledger', () => {
  it('rejects unbalanced entries and any edit or deletion, at the database level', async () => {
    const [account] = await db.select().from(s.ledgerAccounts).limit(1);
    const unbalanced = db.transaction(async (tx) => {
      const [e] = await tx.insert(s.journalEntries).values({ kind: 'adjustment', sourceType: 'test', sourceId: randomUUID(), currency: 'DZD', description: 'forged' }).returning();
      await tx.insert(s.journalLines).values({ entryId: e!.id, accountId: account!.id, debitMinor: 100n });
    });
    await expect(unbalanced).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/not balanced/) }) });
    const refused = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await expect(db.execute(sql`update journal_lines set credit_minor = credit_minor + 1`)).rejects.toMatchObject(refused);
    await expect(db.execute(sql`delete from journal_entries`)).rejects.toMatchObject(refused);
    await expect(db.execute(sql`update commission_rules set bps = 0`)).rejects.toMatchObject(refused);
  });

  it('posts each business event once, even if events are delivered again', async () => {
    const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.merchantId, merchantId));
    await app.flushPaymentEvents();
    expect(await db.select().from(s.journalEntries).where(eq(s.journalEntries.merchantId, merchantId))).toHaveLength(entries.length);
  });
});

describe('reconciliation', () => {
  it('matches the ledger with orders and the Payment Service, and reports what does not match', async () => {
    const period = () => ({ from: startedAt.toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
    const clean = (await call('POST', '/v1/admin/finance/reconciliation', admin.token, period())).json().data;
    expect(clean.discrepancies).toEqual([]);
    // Received: two online payments and one cash on delivery, 10 000 each.
    expect(clean).toMatchObject({ balanced: true, summary: { receivedMinor: DZD(30_000), refundedMinor: DZD(1_000) } });

    // A paid online order cancelled without refunding the customer must be caught.
    const data = await placeOrder('online');
    await payOnline(data);
    await move(data.orders[0].id, { to: 'cancelled', reason: 'Plus en stock' });
    const dirty = (await call('POST', '/v1/admin/finance/reconciliation', admin.token, period())).json().data;
    expect(dirty.balanced).toBe(false);
    expect(dirty.discrepancies).toEqual([expect.objectContaining({ check: 'cancelled_paid_not_refunded', reference: data.orders[0].number })]);

    await refund(data.orders[0].id, DZD(10_000));
    const fixed = (await call('POST', '/v1/admin/finance/reconciliation', admin.token, period())).json().data;
    expect(fixed).toMatchObject({ balanced: true, discrepancies: [] });
  });
});
