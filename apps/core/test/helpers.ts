import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { schema, type Database } from '@aruma/db';
import { buildPaymentsApp, createPaymentsDb, createSandboxProvider, deliverEvents } from '@aruma/payments';
import { buildApp, type AppOptions } from '../src/app.js';
import { createHttpPaymentsClient } from '../src/modules/payments/index.js';
import { createLocalStorage, createSecretBox, type OutboundMessage } from '../src/modules/platform/index.js';
import { createSandboxCourier } from '../src/modules/shipping/index.js';
import type { StaffRole } from '../src/modules/identity/index.js';
import { codeAt, stepAt } from '../src/modules/identity/totp.js';
import { eq } from 'drizzle-orm';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma_test';

const PAYMENTS_TOKEN = 'core-test-service-token-0123456789abcdef';
/** Fixed test encryption key, so helpers can seal values (e.g. a staff member's MFA secret) like the app does. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const testSecrets = createSecretBox(TEST_ENCRYPTION_KEY);
const EVENTS_SECRET = 'core-test-events-secret-0123456789abcdef';

/**
 * The real Payment Service (apps/payments), running in-process with its sandbox provider on the test
 * database. ARUMA CORE talks to it through its normal HTTP client, and its events come back through the
 * normal signed endpoint, so tests exercise the same path as production.
 */
function buildInProcessPayments() {
  const { db, pool } = createPaymentsDb(testDatabaseUrl);
  const sandbox = createSandboxProvider('http://payments.test', 'sandbox-secret');
  const app = buildPaymentsApp({
    db,
    providers: { sandbox },
    defaultOnlineProvider: 'sandbox',
    publicBaseUrl: 'http://payments.test',
    clients: { 'aruma-core': PAYMENTS_TOKEN },
    sandbox,
  });
  const client = createHttpPaymentsClient({
    baseUrl: 'http://payments.test',
    token: PAYMENTS_TOKEN,
    fetch: async (url, init) => {
      const res = await app.inject({ method: init.method as 'GET', url: url.replace('http://payments.test', ''), headers: init.headers, payload: init.body });
      return { status: res.statusCode, json: async () => res.json() };
    },
  });
  return { db, pool, app, client };
}

/** App wired with throwaway services: random encryption key, temp storage, in-memory messages, in-process payments. */
export function buildTestApp(db: Database, options: AppOptions = {}) {
  const sentMessages: OutboundMessage[] = [];
  const storageDir = mkdtempSync(join(tmpdir(), 'aruma-storage-'));
  const payments = buildInProcessPayments();
  const sandboxCourier = createSandboxCourier();
  const app = buildApp(
    db,
    {
      secrets: testSecrets,
      storage: createLocalStorage(storageDir),
      messages: { send: async (m) => void sentMessages.push(m) },
      payments: payments.client,
      paymentEventsSecret: EVENTS_SECRET,
      storefrontUrl: 'https://mbparfum.test',
      couriers: { sandbox: sandboxCourier },
    },
    { authRateLimitMax: 1000, globalRateLimitMax: 1_000_000, ...options },
  );
  app.addHook('onClose', async () => {
    await payments.app.close();
    await payments.pool.end();
  });
  /** Delivers the Payment Service's pending events to this app (what its background job does). */
  const flushPaymentEvents = () =>
    deliverEvents(payments.db, { 'aruma-core': { url: 'http://core.test/internal/payments/events', secret: EVENTS_SECRET } }, async (_url, body, headers) => {
      const res = await app.inject({ method: 'POST', url: '/internal/payments/events', payload: body, headers });
      return { status: res.statusCode };
    }, new Date(Date.now() + 24 * 3600_000));
  /** The customer's action on the (sandbox) provider page, e.g. paying. */
  const payInSandbox = async (redirectUrl: string, outcome: 'paid' | 'failed' | 'cancelled') => {
    const res = await payments.app.inject({ method: 'POST', url: `${new URL(redirectUrl).pathname}/${outcome}` });
    if (res.statusCode !== 200) throw new Error(`sandbox ${outcome}: ${res.body}`);
  };
  return Object.assign(app, { sentMessages, storageDir, paymentsApp: payments.app, flushPaymentEvents, payInSandbox, eventsSecret: EVENTS_SECRET, sandboxCourier });
}
export type TestApp = ReturnType<typeof buildTestApp>;

export const uniqueEmail = (prefix = 'user') => `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
export const uniqueSlug = (prefix = 'merchant') => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function registerUser(app: FastifyInstance, email = uniqueEmail(), headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers,
    payload: { email, password: 'correct horse battery', displayName: 'Test User', locale: 'ar', country: 'DZ' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const { data } = res.json();
  return { email, token: data.token as string, userId: data.user.id as string };
}
export type TestUser = Awaited<ReturnType<typeof registerUser>>;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Smallest valid PNG header: enough for content-type detection. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

/** Builds a multipart/form-data body with a single `file` field. */
export function multipartFile(body: Buffer, fileName = 'doc.png', contentType = 'image/png') {
  const boundary = `----aruma${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const caller = (app: FastifyInstance) => (method: Method, url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, headers: token ? bearer(token) : {}, payload: payload as object });

/** Takes the latest 6-digit code sent to `to`. */
export function lastCode(app: TestApp, to: string): string {
  const message = [...app.sentMessages].reverse().find((m) => m.to === to);
  if (!message?.params.code) throw new Error(`no code sent to ${to}`);
  return message.params.code;
}

/** Drives a merchant through every required check using the public API, as a real merchant and admin would. */
export async function verifyMerchantViaApi(app: TestApp, owner: TestUser, admin: TestUser, merchantId: string) {
  const call = caller(app);
  const base = `/v1/merchants/${merchantId}`;
  const ok = async (res: Awaited<ReturnType<typeof call>>) => {
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res;
  };
  const upload = async (kind: string) => {
    const { payload, headers } = multipartFile(PNG);
    await ok(await app.inject({ method: 'POST', url: `${base}/documents?kind=${kind}`, payload, headers: { ...headers, ...bearer(owner.token) } }));
  };

  const merchant = (await ok(await call('GET', base, owner.token))).json().data;
  for (const kind of ['phone', 'email'] as const) {
    await ok(await call('POST', `${base}/verifications/${kind}/send-code`, owner.token));
    const to = kind === 'phone' ? merchant.contactPhone : merchant.contactEmail;
    await ok(await call('POST', `${base}/verifications/${kind}/confirm`, owner.token, { code: lastCode(app, to) }));
  }
  await ok(await call('PUT', `${base}/address`, owner.token, { line1: '12 rue Didouche Mourad', city: 'Alger Centre', region: 'Alger', country: 'DZ' }));
  await ok(
    await call('PUT', `${base}/identity`, owner.token, {
      fullName: 'Amina Benali',
      dateOfBirth: '1990-04-12',
      nationality: 'DZ',
      documentType: 'national_id',
      documentNumber: '109901234567890',
    }),
  );
  await upload('id_front');
  await upload('id_back');
  await ok(await call('POST', `${base}/verifications/identity/submit`, owner.token));
  await ok(
    await call('PUT', `${base}/payout-method`, owner.token, {
      type: 'bank_account',
      holderName: 'Amina Benali',
      accountNumber: '00799999001234567890',
      currency: 'DZD',
    }),
  );
  await upload('payout_proof');
  await ok(await call('POST', `${base}/verifications/payout/submit`, owner.token));
  const toApprove = ['identity', 'payout'];

  if (merchant.type === 'business') {
    await ok(
      await call('PUT', `${base}/business`, owner.token, {
        legalName: 'SARL Test',
        legalForm: 'SARL',
        registrationType: 'commercial_register',
        registrationNumber: '16/00-1234567B21',
        taxId: '001216012345678',
      }),
    );
    await upload('commercial_register');
    await upload('tax_id_card');
    await ok(await call('POST', `${base}/verifications/business/submit`, owner.token));
    toApprove.push('business');
  }
  for (const kind of toApprove) {
    await ok(await call('POST', `/v1/admin/merchants/${merchantId}/verifications/${kind}`, admin.token, { decision: 'approve' }));
  }
  return (await ok(await call('GET', `${base}/verification`, owner.token))).json().data;
}

/** A delivery address in Algeria: the Commune id gives the Daïra and Wilaya. */
export const dzAddress = (localityId = 'DZ-31-C-oran', extra: Record<string, string> = {}) => ({
  fullName: 'Yacine Meziane',
  phone: '0661 23 45 67',
  country: 'DZ',
  localityId,
  line1: '5 rue Larbi Ben M’hidi',
  ...extra,
});

/** Gives a merchant a simple way to deliver: its own delivery, anywhere in its country, at this price. */
export async function addMerchantDelivery(app: FastifyInstance, owner: TestUser, merchantId: string, priceMinor = 0) {
  const call = caller(app);
  const method = await call('POST', `/v1/merchants/${merchantId}/shipping/methods`, owner.token, { type: 'merchant_delivery', name: 'Livraison par nos soins' });
  if (method.statusCode !== 201) throw new Error(`shipping method: ${method.body}`);
  const id = method.json().data.id as string;
  const rate = await call('PUT', `/v1/merchants/${merchantId}/shipping/methods/${id}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor, minDays: 1, maxDays: 3 });
  if (rate.statusCode !== 200) throw new Error(`shipping rate: ${rate.body}`);
  return id;
}

/** For each seller of the cart, its cheapest delivery option to this address (what a hurried customer picks). */
export async function cheapestDelivery(app: FastifyInstance, lines: { offerId: string; quantity: number }[], address: { country: string; localityId?: string }) {
  const res = await app.inject({ method: 'POST', url: '/v1/stores/mb-parfum/delivery-options', payload: { lines, country: address.country, localityId: address.localityId } });
  if (res.statusCode !== 200) throw new Error(`delivery options: ${res.body}`);
  return (res.json().data.sellers as { merchantId: string; options: { methodId: string }[] }[])
    .filter((seller) => seller.options.length)
    .map((seller) => ({ merchantId: seller.merchantId, methodId: seller.options[0]!.methodId }));
}

/** The MFA secret given to every test staff member (see `makeStaff`). */
export const STAFF_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * Makes a test user ARUMA staff (directly in the database, like the first super admin on a server), with
 * two-step verification on and their current sessions verified, as after a real sign-in with a code.
 */
export async function makeStaff(db: Database, userId: string, ...roles: StaffRole[]) {
  for (const role of roles) await db.insert(schema.staffRoleGrants).values({ userId, role, reason: 'test' });
  await db
    .insert(schema.userMfa)
    .values({ userId, secretEncrypted: testSecrets.seal(STAFF_TOTP_SECRET), enabledAt: new Date() })
    .onConflictDoNothing();
  await db.update(schema.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(schema.sessions.userId, userId));
}

/** The current authenticator code for a secret (what the person's phone shows). */
export const totpNow = (secret = STAFF_TOTP_SECRET, offsetSteps = 0) => codeAt(secret, stepAt() + offsetSteps);
