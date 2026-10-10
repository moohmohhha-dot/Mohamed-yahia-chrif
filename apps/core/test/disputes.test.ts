import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { escalateUnanswered, finalizeDueDisputes } from '../src/modules/disputes/index.js';
import { bearer, buildTestApp, caller, dzAddress, multipartFile, PNG, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser, makeStaff } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let admin2: TestUser;
let support: TestUser;
let financeAdmin: TestUser;
let owner: TestUser;
let staff: TestUser;
let customer: TestUser;
let stranger: TestUser;
let otherOwner: TestUser;
let merchantId: string;
let otherMerchantId: string;
let productId: string;
let offerId: string;
let storeId: string;
let methodId: string;

const DZD = (dinars: number) => dinars * 100;
const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};
const code = (res: Awaited<ReturnType<typeof call>>) => res.json().error?.code;
const dbOrder = async (id: string) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;
const dbDispute = async (id: string) => (await db.select().from(s.disputes).where(eq(s.disputes.id, id)))[0]!;
const platformBalance = async (purpose: string) =>
  (await call('GET', '/v1/admin/finance/trial-balance', admin.token)).json().data.platformAccounts.find((a: any) => a.purpose === purpose && a.currency === 'DZD')?.balanceMinor ?? 0;
const merchantBalance = async () => (await call('GET', `/v1/merchants/${merchantId}/finance/balance`, owner.token)).json().data.find((b: any) => b.currency === 'DZD');

/** An order placed, (paid,) and delivered: 5 000 DZD + 300 DZD delivery. */
async function deliveredOrder(opts: { paymentMethod?: 'cash_on_delivery' | 'online'; user?: TestUser } = {}) {
  const user = opts.user ?? customer;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(user.token), 'idempotency-key': randomUUID() },
    payload: { lines: [{ offerId, quantity: 1 }], paymentMethod: opts.paymentMethod ?? 'cash_on_delivery', shippingAddress: dzAddress('DZ-16-C-alger-centre'), delivery: [{ merchantId, methodId }] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data;
  if (data.payment?.redirectUrl) {
    await app.payInSandbox(data.payment.redirectUrl, 'paid');
    await app.flushPaymentEvents();
  }
  const order = data.orders[0];
  for (const to of ['processing', 'preparing', 'shipping', 'delivered']) await ok(await call('POST', `/v1/merchants/${merchantId}/orders/${order.id}/status`, owner.token, { to }));
  return order as { id: string };
}

const me = (path: string, payload?: unknown, user = customer, method: 'POST' | 'GET' = 'POST') => call(method, `/v1/me/disputes${path}`, user.token, payload);
const m = (path: string, payload?: unknown, user = owner, method: 'POST' | 'GET' = 'POST') => call(method, `/v1/merchants/${merchantId}/disputes${path}`, user.token, payload);
const adm = (path: string, payload?: unknown, user = admin, method: 'POST' | 'GET' = 'POST') => call(method, `/v1/admin/disputes${path}`, user.token, payload);
const upload = (url: string, user: TestUser, body = PNG) => {
  const { payload, headers } = multipartFile(body);
  return app.inject({ method: 'POST', url, payload, headers: { ...headers, ...bearer(user.token) } });
};

const customerClaim = (orderId: string, extra: object = {}) =>
  me('', {
    orderId,
    category: 'item_not_received',
    subject: 'Colis jamais reçu',
    description: 'La commande est marquée livrée mais je n’ai rien reçu à mon adresse.',
    requestedRemedy: 'refund',
    requestedAmountMinor: DZD(5_300),
    ...extra,
  });
const decision = (outcome: string, remedy: string, amountMinor?: number) => ({ outcome, remedy, amountMinor, text: 'Après examen des pièces fournies par les deux parties.' });

beforeAll(async () => {
  await app.ready();
  [admin, admin2, support, owner, staff, customer, stranger, otherOwner] = (await Promise.all(Array.from({ length: 8 }, () => registerUser(app)))) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  await makeStaff(db, admin.userId, 'super_admin');
  await makeStaff(db, admin2.userId, 'super_admin');
  await makeStaff(db, support.userId, 'support_admin');
  financeAdmin = await registerUser(app);
  await makeStaff(db, financeAdmin.userId, 'finance_admin');
  const newMerchant = async (user: TestUser, name: string) => {
    const slug = uniqueSlug();
    const id = (
      await call('POST', '/v1/merchants', user.token, {
        type: 'individual',
        slug,
        name,
        country: 'DZ',
        activityCode: 'perfume_retail',
        contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        contactEmail: `${slug}@example.com`,
      })
    ).json().data.id;
    await verifyMerchantViaApi(app, user, admin, id);
    return id as string;
  };
  merchantId = await newMerchant(owner, 'Disputes Test');
  otherMerchantId = await newMerchant(otherOwner, 'Other Shop');
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  const pslug = uniqueSlug('dsp');
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
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 100, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] })).json().data.id;
  methodId = (await ok(await call('POST', `/v1/merchants/${merchantId}/shipping/methods`, owner.token, { type: 'merchant_delivery', name: 'Notre livreur' }), 201)).id;
  await ok(await call('PUT', `/v1/merchants/${merchantId}/shipping/methods/${methodId}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(300) }));
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
  await db.insert(s.featureFlagOverrides).values({ flagKey: 'checkout.online_payment', storeId, enabled: true }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('opening', () => {
  it('a customer opens a dispute about their own order; one live dispute per order', async () => {
    const order = await deliveredOrder();
    expect((await customerClaim(order.id)).statusCode).toBe(201);
    expect(code(await customerClaim(order.id))).toBe('DISPUTE_EXISTS');
    const other = await deliveredOrder();
    expect((await call('POST', '/v1/me/disputes', stranger.token, { orderId: other.id, category: 'damaged', subject: 'Flacon cassé', description: 'Le flacon est arrivé cassé et vide, regardez les photos.' })).statusCode).toBe(404);
    expect(code(await me('', { category: 'damaged', subject: 'Flacon cassé', description: 'Le flacon est arrivé cassé et vide, regardez les photos.' }))).toBe('ORDER_REQUIRED');
    expect(code(await me('', { orderId: other.id, category: 'payout', subject: 'Flacon cassé', description: 'Le flacon est arrivé cassé et vide, regardez les photos.' }))).toBe('INVALID_CATEGORY');
    expect(code(await me('', { orderId: other.id, category: 'damaged', subject: 'Flacon cassé', description: 'Le flacon est arrivé cassé et vide, regardez les photos.', requestedRemedy: 'store_credit' }))).toBe('AMOUNT_REQUIRED');
    expect(code(await me('', { orderId: other.id, category: 'damaged', subject: 'Flacon cassé', description: 'Le flacon est arrivé cassé et vide, regardez les photos.', requestedRemedy: 'merchant_compensation' }))).toBe('INVALID_REMEDY');
  });

  it('a merchant opens against a customer (about one of its orders) or against ARUMA; staff cannot', async () => {
    const order = await deliveredOrder();
    const body = { kind: 'merchant_customer', orderId: order.id, category: 'false_claim', subject: 'Fausse déclaration', description: 'Le client affirme ne rien avoir reçu alors qu’il a signé le bon.' };
    expect((await m('', body, staff)).statusCode).toBe(403);
    const d = await ok(await m('', body), 201);
    expect(d).toMatchObject({ kind: 'merchant_customer', status: 'open', side: 'claimant', customer: expect.any(String), number: expect.stringMatching(/^DS-\d{4}-\d{6}$/) });
    const view = await ok(await me(`/${d.id}`, undefined, customer, 'GET'));
    expect(view.side).toBe('respondent');

    const aruma = await ok(await m('', { kind: 'merchant_aruma', category: 'commission', references: { settlement: 'ST-123' }, subject: 'Commission trop élevée', description: 'La commission prélevée ce mois ne correspond pas au taux du contrat.', requestedRemedy: 'merchant_compensation' }), 201);
    expect(aruma).toMatchObject({ kind: 'merchant_aruma', customer: null, order: null, currency: 'DZD', references: { settlement: 'ST-123' } });
    // Not with another merchant's order, nor as a customer dispute.
    const theirs = await call('POST', `/v1/merchants/${otherMerchantId}/disputes`, otherOwner.token, { ...body, orderId: order.id });
    expect(theirs.statusCode).toBe(404);
    expect((await m('', { ...body, kind: 'customer_merchant' })).statusCode).toBe(400);
  });
});

describe('customer ↔ merchant, end to end', () => {
  it('messages, evidence and documents, internal notes, ARUMA decides a refund, the merchant appeals, another admin upholds it: refunded online', async () => {
    const order = await deliveredOrder({ paymentMethod: 'online' });
    const d = await ok(await customerClaim(order.id), 201);
    expect(d).toMatchObject({ status: 'open', side: 'claimant', requestedAmountMinor: DZD(5_300), respondedAt: null });

    await ok(await me(`/${d.id}/messages`, { body: 'Je n’ai jamais été appelé par le livreur.' }), 201);
    expect((await m(`/${d.id}/messages`, { body: 'Notre livreur a remis le colis.' }, staff)).statusCode).toBe(403);
    const answered = await ok(await m(`/${d.id}/messages`, { body: 'Notre livreur a remis le colis, voici le bon signé.' }), 201);
    expect(answered.respondedAt).not.toBeNull();
    await ok(await upload(`/v1/me/disputes/${d.id}/files?kind=evidence`, customer), 201);
    const doc = await ok(await upload(`/v1/merchants/${merchantId}/disputes/${d.id}/files?kind=document`, owner), 201);
    expect(doc).toMatchObject({ kind: 'document', uploaderType: 'merchant', contentType: 'image/png' });
    expect(doc.storageKey).toBeUndefined();
    expect((await upload(`/v1/me/disputes/${d.id}/files`, customer, Buffer.from('MZ not an image'))).json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await upload(`/v1/me/disputes/${d.id}/files`, stranger)).statusCode).toBe(404);
    const file = await app.inject({ method: 'GET', url: `/v1/me/disputes/${d.id}/files/${doc.id}`, headers: bearer(customer.token) });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);

    // ARUMA: support writes an internal note and adds an internal file; the parties never see them.
    await ok(await adm(`/${d.id}/messages`, { body: 'Vérifier le GPS du livreur.', internal: true }, support), 201);
    const internalFile = await ok(await upload(`/v1/admin/disputes/${d.id}/files?kind=document&internal=true`, support), 201);
    await ok(await adm(`/${d.id}/messages`, { body: 'Nous examinons votre dossier.' }, support), 201);
    expect((await me(`/${d.id}/escalate`, { reason: 'Le vendeur refuse de rembourser.' })).statusCode).toBe(200);
    expect((await adm(`/${d.id}/decision`, decision('claimant', 'refund', DZD(5_300)), financeAdmin)).statusCode).toBe(403); // Finance sends refunds, does not decide disputes
    expect(code(await adm(`/${d.id}/decision`, decision('claimant', 'refund', DZD(9_000))))).toBe('REMEDY_EXCEEDS_ORDER');
    expect(code(await adm(`/${d.id}/decision`, decision('respondent', 'refund', DZD(100))))).toBe('INVALID_REMEDY');
    expect(code(await adm(`/${d.id}/decision`, decision('claimant', 'merchant_compensation', DZD(100))))).toBe('INVALID_REMEDY');
    const decided = await ok(await adm(`/${d.id}/decision`, decision('claimant', 'refund', DZD(5_300))));
    expect(decided).toMatchObject({ status: 'decided', decision: { outcome: 'claimant', remedy: 'refund', amountMinor: DZD(5_300) } });

    const seen = await ok(await me(`/${d.id}`, undefined, customer, 'GET'));
    expect(seen.messages.map((x: any) => x.body)).toEqual(['Je n’ai jamais été appelé par le livreur.', 'Notre livreur a remis le colis, voici le bon signé.', 'Nous examinons votre dossier.']);
    expect(seen.messages[2]).toMatchObject({ authorType: 'platform', authorName: null });
    expect(seen.messages[1]).toMatchObject({ authorType: 'merchant', authorName: 'Disputes Test' }); // the shop, not the employee
    expect(seen.files).toHaveLength(2);
    expect(seen.events.some((e: any) => e.data?.internal)).toBe(false);
    expect(seen.canAppeal).toBe(false); // the customer won
    expect((await app.inject({ method: 'GET', url: `/v1/me/disputes/${d.id}/files/${internalFile.id}`, headers: bearer(customer.token) })).statusCode).toBe(404);
    expect((await ok(await adm(`/${d.id}`, undefined, support, 'GET'))).messages).toHaveLength(4);
    expect(code(await me(`/${d.id}/appeal`, { reason: 'Je veux faire appel quand même.' }))).toBe('FORBIDDEN');

    const merchantView = await ok(await m(`/${d.id}`, undefined, owner, 'GET'));
    expect(merchantView).toMatchObject({ side: 'respondent', canAppeal: true });
    const appealed = await ok(await m(`/${d.id}/appeal`, { reason: 'Le bon de livraison signé prouve la remise.' }));
    expect(appealed.status).toBe('appealed');
    expect(code(await m(`/${d.id}/appeal`, { reason: 'Encore une fois, nous contestons.' }))).toBe('ALREADY_APPEALED');
    // The administrator who decided cannot hear the appeal; the database refuses it too.
    expect((await adm(`/${d.id}/appeal-decision`, { result: 'upheld', text: 'Décision confirmée après nouvel examen complet.' })).statusCode).toBe(403);
    await expect(db.execute(sql`update disputes set appeal_decided_by = decided_by, appeal_decision_text = 'x' where id = ${d.id}`)).rejects.toThrow();

    const final = await ok(await adm(`/${d.id}/appeal-decision`, { result: 'upheld', text: 'Décision confirmée après nouvel examen complet.' }, admin2));
    expect(final).toMatchObject({ status: 'resolved', finalOutcome: 'claimant', appeal: { result: 'upheld', outcome: 'claimant' }, execution: { status: 'done' } });
    // The order stays delivered (nothing came back); its payment is fully refunded.
    expect(await dbOrder(order.id)).toMatchObject({ refundedMinor: BigInt(DZD(5_300)), status: 'delivered', paymentStatus: 'refunded' });
    expect((await dbDispute(d.id)).paymentRefundId).toEqual(expect.any(String));
    expect(final.events.map((e: any) => e.type)).toEqual([
      'opened', 'message', 'message', 'responded', 'file_added', 'file_added', 'message', 'file_added', 'message', 'escalated', 'decided', 'appealed', 'appeal_decided', 'resolved', 'executed',
    ]);
    expect(code(await me(`/${d.id}/messages`, { body: 'Merci.' }))).toBe('DISPUTE_CLOSED');
  });

  it('cash on delivery: the refund waits for the transfer reference', async () => {
    const order = await deliveredOrder();
    const d = await ok(await customerClaim(order.id, { category: 'damaged', requestedAmountMinor: DZD(2_000) }), 201);
    await ok(await adm(`/${d.id}/decision`, decision('partial', 'refund', DZD(2_000))));
    // Partial: both parties may appeal; both accept, so it is final at once.
    await ok(await me(`/${d.id}/accept`));
    expect(code(await me(`/${d.id}/accept`))).toBe('ALREADY_ACCEPTED');
    const accepted = await ok(await m(`/${d.id}/accept`));
    expect(accepted).toMatchObject({ status: 'resolved', execution: { status: 'pending' } });
    expect(code(await adm(`/${d.id}/refund`, {}))).toBe('MANUAL_REFUND_REQUIRED');
    expect((await adm(`/${d.id}/refund`, { externalReference: 'CCP-VIR-55120' }, support)).statusCode).toBe(403);
    const done = await ok(await adm(`/${d.id}/refund`, { externalReference: 'CCP-VIR-55120' }));
    expect(done.execution).toEqual({ status: 'done', reference: 'CCP-VIR-55120' });
    expect((await ok(await me(`/${d.id}`, undefined, customer, 'GET'))).execution.reference).toBeUndefined();
    expect(await dbOrder(order.id)).toMatchObject({ refundedMinor: BigInt(DZD(2_000)), status: 'delivered' });
    expect(code(await adm(`/${d.id}/refund`, { externalReference: 'CCP-VIR-55120' }))).toBe('NOTHING_TO_SEND');
  });

  it('the appeal overturns a refund into store credit; nothing can be rewritten afterwards', async () => {
    const order = await deliveredOrder();
    const d = await ok(await customerClaim(order.id, { category: 'wrong_item', requestedRemedy: 'store_credit', requestedAmountMinor: DZD(5_000) }), 201);
    await ok(await adm(`/${d.id}/decision`, decision('respondent', 'none')));
    const before = (await ok(await call('GET', '/v1/me/store-credit', customer.token))).balances.find((b: any) => b.currency === 'DZD')?.balanceMinor ?? 0;
    await ok(await me(`/${d.id}/messages`, { body: 'J’ajoute la photo du mauvais article.' }), 201);
    await ok(await me(`/${d.id}/appeal`, { reason: 'Voici la photo du mauvais article reçu.' }));
    expect(code(await adm(`/${d.id}/appeal-decision`, { result: 'overturned', text: 'Les photos montrent un autre article.' }, admin2))).toBe('DECISION_REQUIRED');
    const final = await ok(await adm(`/${d.id}/appeal-decision`, { result: 'overturned', ...decision('claimant', 'store_credit', DZD(5_000)), text: 'Les photos montrent un autre article.' }, admin2));
    expect(final).toMatchObject({ status: 'resolved', decision: { outcome: 'respondent' }, finalOutcome: 'claimant', appeal: { result: 'overturned' }, execution: { status: 'done' } });
    const after = (await ok(await call('GET', '/v1/me/store-credit', customer.token))).balances.find((b: any) => b.currency === 'DZD').balanceMinor;
    expect(after - before).toBe(DZD(5_000));

    await expect(db.execute(sql`update disputes set outcome = 'claimant' where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update disputes set remedy_amount_minor = 1 where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update disputes set status = 'open' where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update disputes set appeal_new_outcome = 'respondent' where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update disputes set customer_user_id = ${stranger.userId} where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from disputes where id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update dispute_messages set body = 'x' where dispute_id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from dispute_events where dispute_id = ${d.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from dispute_files`)).rejects.toThrow();
  });
});

describe('deadlines', () => {
  it('goes to ARUMA when the other party does not answer; the decision is final when the appeal window ends', async () => {
    const order = await deliveredOrder();
    const d = await ok(await customerClaim(order.id, { category: 'not_as_described', requestedRemedy: 'none', requestedAmountMinor: undefined }), 201);
    expect(await escalateUnanswered(db, new Date(Date.now() + 73 * 3600_000))).toBeGreaterThanOrEqual(1);
    const view = await ok(await adm(`/${d.id}`, undefined, support, 'GET'));
    expect(view).toMatchObject({ status: 'under_review', escalationReason: 'No answer in time' });
    expect(view.events.at(-1)).toMatchObject({ type: 'escalated', actorType: 'system' });
    await ok(await adm(`/${d.id}/decision`, decision('respondent', 'none')));
    expect(await finalizeDueDisputes(db, { payments: app.payments }, new Date(Date.now() + 6 * 24 * 3600_000))).toBe(0);
    expect(await finalizeDueDisputes(db, { payments: app.payments }, new Date(Date.now() + 8 * 24 * 3600_000))).toBeGreaterThanOrEqual(1);
    expect((await dbDispute(d.id)).status).toBe('resolved');
  });

  it('the claimant can withdraw (settled between the parties); the respondent cannot', async () => {
    const d = await ok(await customerClaim((await deliveredOrder()).id), 201);
    expect((await m(`/${d.id}/withdraw`, { note: 'Réglé à l’amiable' })).statusCode).toBe(403);
    expect((await ok(await me(`/${d.id}/withdraw`, { note: 'Le vendeur m’a remboursé directement.' }))).status).toBe('withdrawn');
    expect(code(await adm(`/${d.id}/decision`, decision('claimant', 'none')))).toBe('INVALID_DISPUTE_STATUS');
  });
});

describe('merchant ↔ ARUMA and merchant ↔ customer', () => {
  it('ARUMA answers, decides compensation, the merchant accepts: paid into the merchant balance, recorded in the ledger', async () => {
    const d = await ok(await m('', { kind: 'merchant_aruma', category: 'fees', subject: 'Frais facturés deux fois', description: 'Les frais de service de septembre apparaissent deux fois sur le relevé.', requestedRemedy: 'merchant_compensation' }), 201);
    const answered = await ok(await adm(`/${d.id}/messages`, { body: 'Nous vérifions le relevé.' }, support), 201);
    expect(answered.respondedAt).not.toBeNull();
    const [expenseBefore, balanceBefore] = [await platformBalance('compensation_expense'), await merchantBalance()];
    // The merchant won and ARUMA never appeals its own decision: final at once.
    const final = await ok(await adm(`/${d.id}/decision`, decision('claimant', 'merchant_compensation', DZD(1_200))));
    expect(final).toMatchObject({ status: 'resolved', execution: { status: 'done' } });
    expect(code(await m(`/${d.id}/appeal`, { reason: 'Nous voulons plus que cela.' }))).toBe('INVALID_DISPUTE_STATUS');
    expect(await platformBalance('compensation_expense')).toBe(expenseBefore + DZD(1_200));
    expect((await merchantBalance()).availableMinor).toBe((balanceBefore?.availableMinor ?? 0) + DZD(1_200));
    const tb = await ok(await call('GET', '/v1/admin/finance/trial-balance', admin.token));
    expect(tb.currencies.every((c: any) => c.balanced)).toBe(true);
  });

  it('merchant against a customer: compensation for a false claim', async () => {
    const order = await deliveredOrder();
    const d = await ok(await m('', { kind: 'merchant_customer', orderId: order.id, category: 'cod_refusal_abuse', subject: 'Refus abusif', description: 'Le client refuse systématiquement les colis à la livraison.', requestedRemedy: 'merchant_compensation' }), 201);
    await ok(await me(`/${d.id}/messages`, { body: 'Je n’étais pas chez moi ce jour-là.' }), 201);
    await ok(await adm(`/${d.id}/decision`, decision('respondent', 'none')));
    expect((await ok(await m(`/${d.id}`, undefined, owner, 'GET'))).canAppeal).toBe(true);
    expect(code(await me(`/${d.id}/accept`))).toBe('FORBIDDEN'); // the customer won: nothing to accept
    expect((await ok(await m(`/${d.id}/accept`))).status).toBe('resolved');
  });
});

describe('access', () => {
  it('lists per party; other merchants, strangers and staff see nothing', async () => {
    const d = await ok(await customerClaim((await deliveredOrder()).id), 201);
    expect((await ok(await me('', undefined, customer, 'GET'))).some((x: any) => x.id === d.id)).toBe(true);
    expect((await ok(await me('', undefined, stranger, 'GET'))).some((x: any) => x.id === d.id)).toBe(false);
    expect((await ok(await m('?status=open', undefined, owner, 'GET'))).some((x: any) => x.id === d.id)).toBe(true);
    expect((await m('', undefined, staff, 'GET')).statusCode).toBe(403);
    expect((await me(`/${d.id}`, undefined, stranger, 'GET')).statusCode).toBe(404);
    expect((await call('GET', `/v1/merchants/${otherMerchantId}/disputes/${d.id}`, otherOwner.token)).statusCode).toBe(404);
    expect((await call('GET', `/v1/merchants/${merchantId}/disputes/${d.id}`, otherOwner.token)).statusCode).toBe(404);
    expect((await adm('', undefined, owner, 'GET')).statusCode).toBe(403);
    expect((await ok(await adm('?kind=customer_merchant', undefined, support, 'GET'))).some((x: any) => x.id === d.id)).toBe(true);
    // A customer cannot post an internal note.
    await ok(await call('POST', `/v1/me/disputes/${d.id}/messages`, customer.token, { body: 'Note interne ?', internal: true }), 201);
    expect((await ok(await adm(`/${d.id}`, undefined, admin, 'GET'))).messages.at(-1).internal).toBe(false);
  });
});
