import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createPaymentsDb } from '../src/db/client.js';
import * as t from '../src/db/schema.js';
import { deliverEvents, signEvent } from '../src/events.js';
import { auth, buildTestPaymentsApp, CHARGILY_SECRET, startChargilyMock, testDatabaseUrl } from './helpers.js';

const { db, pool } = createPaymentsDb(testDatabaseUrl);
let chargily: Awaited<ReturnType<typeof startChargilyMock>>;
let app: ReturnType<typeof buildTestPaymentsApp>;
let chargilyApp: ReturnType<typeof buildTestPaymentsApp>;

beforeAll(async () => {
  chargily = await startChargilyMock();
  app = buildTestPaymentsApp(db, chargily.baseUrl, 'sandbox');
  chargilyApp = buildTestPaymentsApp(db, chargily.baseUrl, 'chargily');
  await app.ready();
  await chargilyApp.ready();
});
afterAll(async () => {
  await app.close();
  await chargilyApp.close();
  await chargily.close();
  await pool.end();
});

const post = (a = app, url: string, payload?: object, key: string | null = null) =>
  a.inject({ method: 'POST', url, payload: payload as object, headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}) } });
const get = (url: string, a = app) => a.inject({ method: 'GET', url, headers: auth });
const intentBody = (overrides: Record<string, unknown> = {}) => ({
  referenceType: 'checkout',
  referenceId: randomUUID(),
  method: 'online',
  amountMinor: 1_200_000,
  currency: 'DZD',
  returnUrl: 'https://mbparfum.example/checkout/done',
  locale: 'ar',
  ...overrides,
});
const create = async (overrides: Record<string, unknown> = {}, a = app) => {
  const res = await post(a, '/v1/payment-intents', intentBody(overrides), randomUUID());
  expect(res.statusCode).toBe(201);
  return res.json().data;
};
const providerIdOf = async (intentId: string) => {
  const rows = await db.select().from(t.paymentAttempts).where(eq(t.paymentAttempts.intentId, intentId)).orderBy(asc(t.paymentAttempts.number));
  return rows.at(-1)!.providerPaymentId!;
};
const sandboxPay = async (intentId: string, outcome: 'paid' | 'failed' | 'cancelled', amountMinor?: number) =>
  app.inject({ method: 'POST', url: `/sandbox/checkouts/${await providerIdOf(intentId)}/${outcome}${amountMinor ? `?amountMinor=${amountMinor}` : ''}` });
const eventsFor = async (intentId: string) =>
  (await db.select().from(t.outboundEvents).orderBy(asc(t.outboundEvents.createdAt))).filter((e) => (e.payload as any).intent.id === intentId).map((e) => e.type);

describe('access', () => {
  it('requires the service token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/payment-intents', payload: intentBody(), headers: { 'idempotency-key': randomUUID() } });
    expect(res.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: `/v1/payment-intents/${randomUUID()}`, headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
  });
});

describe('online payment', () => {
  it('creates a pending payment with a redirect URL, idempotently', async () => {
    const key = randomUUID();
    const body = intentBody();
    const first = (await post(app, '/v1/payment-intents', body, key)).json().data;
    expect(first).toMatchObject({ status: 'pending', method: 'online', provider: 'sandbox', amountMinor: 1_200_000 });
    expect(first.redirectUrl).toMatch(/^http:\/\/payments\.test\/sandbox\/checkouts\/sbx_/);
    const again = (await post(app, '/v1/payment-intents', body, key)).json().data;
    expect(again.id).toBe(first.id);
    expect(again.attempts).toHaveLength(1);
    const reused = await post(app, '/v1/payment-intents', { ...body, amountMinor: 5 }, key);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await post(app, '/v1/payment-intents', body)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('becomes successful through a verified webhook and announces it', async () => {
    const intent = await create();
    const res = await sandboxPay(intent.id, 'paid');
    expect(res.statusCode).toBe(200);
    const after = (await get(`/v1/payment-intents/${intent.id}`)).json().data;
    expect(after).toMatchObject({ status: 'successful', redirectUrl: null });
    expect(after.history.map((h: any) => [h.from, h.to, h.source])).toEqual([
      [null, 'pending', 'api'],
      ['pending', 'successful', 'webhook'],
    ]);
    expect(await eventsFor(intent.id)).toEqual(['payment.succeeded']);
  });

  it('ignores replayed webhooks and rejects forged ones', async () => {
    const intent = await create();
    const providerId = await providerIdOf(intent.id);
    const hook = app.sandbox.complete(providerId, 'paid')!;
    expect((await app.inject({ method: 'POST', url: '/webhooks/sandbox', payload: hook.body, headers: hook.headers })).json().data).toEqual({ duplicate: false });
    expect((await app.inject({ method: 'POST', url: '/webhooks/sandbox', payload: hook.body, headers: hook.headers })).json().data).toEqual({ duplicate: true });

    const forged = await app.inject({ method: 'POST', url: '/webhooks/sandbox', payload: hook.body, headers: { ...hook.headers, 'x-sandbox-signature': 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(401);
    const [stored] = await db.select().from(t.webhookEvents).where(eq(t.webhookEvents.signatureValid, 0));
    expect(stored!.error).toBe('Invalid signature');
    expect(await eventsFor(intent.id)).toEqual(['payment.succeeded']);
  });

  it('never trusts the webhook: a wrong amount at the provider fails the payment and flags it', async () => {
    const intent = await create();
    await sandboxPay(intent.id, 'paid', 100);
    const after = (await get(`/v1/payment-intents/${intent.id}`)).json().data;
    expect(after).toMatchObject({ status: 'failed', failureReason: 'AMOUNT_MISMATCH' });
    expect(await eventsFor(intent.id)).toEqual(['payment.needs_review', 'payment.failed']);
  });

  it('retries after a failure with a new attempt', async () => {
    const intent = await create();
    await sandboxPay(intent.id, 'failed');
    expect((await get(`/v1/payment-intents/${intent.id}`)).json().data.status).toBe('failed');
    const retried = (await post(app, `/v1/payment-intents/${intent.id}/retry`)).json().data;
    expect(retried).toMatchObject({ status: 'pending' });
    expect(retried.attempts.map((a: any) => a.status)).toEqual(['failed', 'pending']);
    expect(retried.redirectUrl).toBeTruthy();
    await sandboxPay(intent.id, 'paid');
    expect((await get(`/v1/payment-intents/${intent.id}`)).json().data.status).toBe('successful');
    expect((await post(app, `/v1/payment-intents/${intent.id}/retry`)).json().error.code).toBe('NOT_RETRYABLE');
  });

  it('records a payment that arrives after cancellation, so the money is not lost', async () => {
    const intent = await create();
    const cancelled = (await post(app, `/v1/payment-intents/${intent.id}/cancel`, { reason: 'Checkout expired' })).json().data;
    expect(cancelled.status).toBe('cancelled');
    await sandboxPay(intent.id, 'paid');
    expect((await get(`/v1/payment-intents/${intent.id}`)).json().data.status).toBe('successful');
    const [succeeded] = (await db.select().from(t.outboundEvents)).filter((e) => (e.payload as any).intent.id === intent.id && e.type === 'payment.succeeded');
    expect((succeeded!.payload as any).lateAfterCancel).toBe(true);
  });

  it('can be verified on demand (e.g. when the customer comes back)', async () => {
    const intent = await create();
    app.sandbox.complete(await providerIdOf(intent.id), 'paid'); // the webhook is "lost"
    expect((await get(`/v1/payment-intents/${intent.id}`)).json().data.status).toBe('pending');
    expect((await post(app, `/v1/payment-intents/${intent.id}/verify`)).json().data.status).toBe('successful');
  });
});

describe('refunds', () => {
  it('refunds partially then fully through the provider, idempotently, never more than paid', async () => {
    const intent = await create();
    await sandboxPay(intent.id, 'paid');
    const key = randomUUID();
    const partial = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 200_000, reason: 'Broken bottle', requestedBy: 'admin:1' }, key);
    expect(partial.statusCode).toBe(201);
    expect(partial.json().data.intent).toMatchObject({ status: 'successful', refundedMinor: 200_000 });
    const replay = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 200_000, reason: 'Broken bottle', requestedBy: 'admin:1' }, key);
    expect(replay.json().data.intent.refundedMinor).toBe(200_000);

    const tooMuch = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 1_000_001, reason: 'x', requestedBy: 'admin:1' }, randomUUID());
    expect(tooMuch.json().error).toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT', details: { refundableMinor: 1_000_000 } });

    const rest = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 1_000_000, reason: 'Order returned', requestedBy: 'admin:1' }, randomUUID());
    expect(rest.json().data.intent).toMatchObject({ status: 'refunded', refundedMinor: 1_200_000 });
    expect(rest.json().data.intent.refunds.map((r: any) => [r.method, r.status])).toEqual([
      ['provider', 'successful'],
      ['provider', 'successful'],
    ]);
    expect(await eventsFor(intent.id)).toEqual(['payment.succeeded', 'payment.refund_succeeded', 'payment.refunded', 'payment.refund_succeeded']);
  });

  it('cannot refund an unpaid payment', async () => {
    const intent = await create();
    const res = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 100, reason: 'x', requestedBy: 'a' }, randomUUID());
    expect(res.json().error.code).toBe('NOT_REFUNDABLE');
  });
});

describe('cash on delivery', () => {
  it('is paid when the cash is collected, for the exact amount', async () => {
    const intent = await create({ method: 'cash_on_delivery', referenceType: 'order' });
    expect(intent).toMatchObject({ status: 'pending', provider: 'cash_on_delivery', redirectUrl: null, attempts: [] });
    const wrong = await post(app, `/v1/payment-intents/${intent.id}/cash-collected`, { amountMinor: 1_000_000, collectedBy: 'merchant:x' });
    expect(wrong.json().error.code).toBe('AMOUNT_MISMATCH');
    const ok = await post(app, `/v1/payment-intents/${intent.id}/cash-collected`, { amountMinor: 1_200_000, collectedBy: 'merchant:x' });
    expect(ok.json().data.status).toBe('successful');
  });

  it('is refunded outside ARUMA, recorded with its proof', async () => {
    const intent = await create({ method: 'cash_on_delivery', referenceType: 'order' });
    await post(app, `/v1/payment-intents/${intent.id}/cash-collected`, { amountMinor: 1_200_000, collectedBy: 'merchant:x' });
    const noProof = await post(app, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 1_200_000, reason: 'Return', requestedBy: 'admin:1' }, randomUUID());
    expect(noProof.json().error.code).toBe('EXTERNAL_REFERENCE_REQUIRED');
    const done = await post(
      app,
      `/v1/payment-intents/${intent.id}/refunds`,
      { amountMinor: 1_200_000, reason: 'Return', requestedBy: 'admin:1', externalReference: 'CCP-VIR-2026-0042' },
      randomUUID(),
    );
    expect(done.json().data.intent).toMatchObject({ status: 'refunded', refunds: [{ method: 'manual', externalReference: 'CCP-VIR-2026-0042' }] });
  });
});

describe('Chargily adapter (against a local mock of its API)', () => {
  it('creates a checkout exactly as the official SDK does', async () => {
    const intent = await create({ amountMinor: 850_000, providerOptions: { paymentMethod: 'cib' }, locale: 'fr' }, chargilyApp);
    expect(intent).toMatchObject({ provider: 'chargily', status: 'pending' });
    expect(intent.redirectUrl).toMatch(/^https:\/\/pay\.chargily\.net\/test\/checkout\//);
    const call = chargily.requests.at(-1)!;
    expect(call).toMatchObject({ method: 'POST', url: '/test/api/v2/checkouts', auth: `Bearer ${CHARGILY_SECRET}` });
    expect(call.body).toMatchObject({
      amount: 8500, // whole dinars
      currency: 'dzd',
      success_url: 'https://mbparfum.example/checkout/done',
      webhook_endpoint: 'http://payments.test/webhooks/chargily',
      locale: 'fr',
      payment_method: 'cib',
      metadata: { aruma_intent_id: intent.id },
    });
  });

  it('verifies the "signature" header and re-reads the checkout before marking it paid', async () => {
    const intent = await create({ amountMinor: 850_000 }, chargilyApp);
    const hook = chargily.settle(await providerIdOf(intent.id), 'paid');
    const forged = await chargilyApp.inject({ method: 'POST', url: '/webhooks/chargily', payload: hook.body, headers: { ...hook.headers, signature: 'a'.repeat(64) } });
    expect(forged.statusCode).toBe(401);
    const before = chargily.requests.length;
    const ok = await chargilyApp.inject({ method: 'POST', url: '/webhooks/chargily', payload: hook.body, headers: hook.headers });
    expect(ok.statusCode).toBe(200);
    expect(chargily.requests.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET /test/api/v2/checkouts/${await providerIdOf(intent.id)}`]);
    expect((await get(`/v1/payment-intents/${intent.id}`, chargilyApp)).json().data.status).toBe('successful');
  });

  it('maps a canceled checkout to a failed payment that can be retried', async () => {
    const intent = await create({ amountMinor: 850_000 }, chargilyApp);
    const hook = chargily.settle(await providerIdOf(intent.id), 'canceled');
    await chargilyApp.inject({ method: 'POST', url: '/webhooks/chargily', payload: hook.body, headers: hook.headers });
    expect((await get(`/v1/payment-intents/${intent.id}`, chargilyApp)).json().data).toMatchObject({ status: 'failed', failureReason: 'Provider: canceled' });
  });

  it('refuses amounts with centimes, and refunds manually (no refund API)', async () => {
    const res = await post(chargilyApp, '/v1/payment-intents', intentBody({ amountMinor: 850_050 }), randomUUID());
    expect(res.json().data).toMatchObject({ status: 'failed' });

    const intent = await create({ amountMinor: 850_000 }, chargilyApp);
    const hook = chargily.settle(await providerIdOf(intent.id), 'paid');
    await chargilyApp.inject({ method: 'POST', url: '/webhooks/chargily', payload: hook.body, headers: hook.headers });
    const refund = await post(chargilyApp, `/v1/payment-intents/${intent.id}/refunds`, { amountMinor: 850_000, reason: 'x', requestedBy: 'admin:1' }, randomUUID());
    expect(refund.json().error.code).toBe('EXTERNAL_REFERENCE_REQUIRED');
  });

  it('marks the payment failed (retryable) when Chargily is unreachable', async () => {
    const broken = buildTestPaymentsApp(db, 'http://127.0.0.1:1/test/api/v2', 'chargily');
    const intent = (await post(broken, '/v1/payment-intents', intentBody(), randomUUID())).json().data;
    expect(intent).toMatchObject({ status: 'failed', redirectUrl: null });
    expect(intent.attempts[0].failureReason).toMatch(/unreachable/);
    await broken.close();
  });
});

describe('events to ARUMA CORE', () => {
  it('signs each delivery, retries failures with backoff and keeps order', async () => {
    const received: { body: string; headers: Record<string, string> }[] = [];
    let fail = true;
    const transport = async (_url: string, body: string, headers: Record<string, string>) => {
      if (fail) return { status: 503 };
      received.push({ body, headers });
      return { status: 200 };
    };
    const targets = { 'aruma-core': { url: 'http://core.test/internal/payments/events', secret: 'events-secret' } };
    expect(await deliverEvents(db, targets, transport)).toBe(0);
    const [stuck] = await db.select().from(t.outboundEvents).orderBy(asc(t.outboundEvents.createdAt)).limit(1);
    expect(stuck!.attempts).toBe(1);
    expect(stuck!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    fail = false;
    const delivered = await deliverEvents(db, targets, transport, new Date(Date.now() + 3600_000));
    expect(delivered).toBeGreaterThan(5);
    const first = received[0]!;
    expect(first.headers['x-aruma-signature']).toBe(signEvent('events-secret', Number(first.headers['x-aruma-timestamp']), first.body));
    expect(JSON.parse(first.body).id).toBe(stuck!.id);
  });
});

describe('database guards', () => {
  it('keeps amounts, history and refunds tamper-proof', async () => {
    const intent = await create();
    const refused = (m: RegExp) => ({ cause: expect.objectContaining({ message: expect.stringMatching(m) }) });
    await expect(db.execute(sql`update payments.payment_intents set amount_minor = 1 where id = ${intent.id}`)).rejects.toMatchObject(refused(/cannot change/));
    await expect(db.execute(sql`delete from payments.status_history where intent_id = ${intent.id}`)).rejects.toMatchObject(refused(/append-only/));
    await expect(db.execute(sql`delete from payments.payment_intents where id = ${intent.id}`)).rejects.toMatchObject(refused(/append-only/));
  });

  it('stores no card data: only provider ids, amounts and statuses', async () => {
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'payments'`);
    const names = columns.rows.map((c) => c.column_name);
    expect(names.filter((n) => /card|pan|cvv|cvc|expiry|expiration/i.test(n))).toEqual([]);
  });
});
