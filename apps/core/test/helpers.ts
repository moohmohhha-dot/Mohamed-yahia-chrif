import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@aruma/db';
import { buildApp, type AppOptions } from '../src/app.js';
import { createLocalStorage, createSecretBox, type OutboundMessage } from '../src/modules/platform/index.js';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma_test';

/** App wired with throwaway services: random encryption key, temp storage, and an in-memory message outbox. */
export function buildTestApp(db: Database, options: AppOptions = {}) {
  const sentMessages: OutboundMessage[] = [];
  const storageDir = mkdtempSync(join(tmpdir(), 'aruma-storage-'));
  const app = buildApp(
    db,
    {
      secrets: createSecretBox(randomBytes(32).toString('base64')),
      storage: createLocalStorage(storageDir),
      messages: { send: async (m) => void sentMessages.push(m) },
    },
    { authRateLimitMax: 1000, ...options },
  );
  return Object.assign(app, { sentMessages, storageDir });
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
