/**
 * Security checks across every layer, run before each release (see docs/SECURITY.md):
 * headers, input handling, injection, authorization of every admin route, sessions, lockout, rate
 * limits, two-step verification, encryption and configuration. Attacks here target only this test app.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { loadConfig, productionProblems } from '../src/config.js';
import { createLocalStorage, createSecretBox, rotateEncryption } from '../src/modules/platform/index.js';
import { codeAt, stepAt } from '../src/modules/identity/totp.js';
import {
  buildTestApp,
  caller,
  makeStaff,
  registerUser,
  STAFF_TOTP_SECRET,
  TEST_ENCRYPTION_KEY,
  testDatabaseUrl,
  totpNow,
  uniqueEmail,
  uniqueSlug,
  verifyMerchantViaApi,
  type TestUser,
} from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);
const routes: RouteOptions[] = [];
app.addHook('onRoute', (r) => void routes.push(r));

let customer: TestUser;
let security: TestUser;
let superAdmin: TestUser;
const code = (res: { json: () => any }) => res.json().error?.code;
const login = (email: string, password = 'correct horse battery') => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

beforeAll(async () => {
  await app.ready();
  customer = await registerUser(app);
  security = await registerUser(app);
  await makeStaff(db, security.userId, 'security_admin');
  superAdmin = await registerUser(app);
  await makeStaff(db, superAdmin.userId, 'super_admin');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HTTP layer', () => {
  it('sends strict security headers on every response, and nothing that allows cross-site use', async () => {
    for (const url of ['/health', '/v1/does-not-exist', '/v1/stores/mb-parfum']) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: 'https://evil.example' } });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      // No CORS: another site's scripts cannot read API answers.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    const me = await call('GET', '/v1/me', customer.token);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.headers['content-type']).toContain('application/json');
  });

  it('CSRF: only the Authorization header signs a request in; cookies are ignored', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `token=${customer.token}; session=${customer.token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses prototype pollution, oversized bodies and wrong content types', async () => {
    const poisoned = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":"a@b.dz","password":"x","__proto__":{"admin":true}}' });
    expect(poisoned.statusCode).toBe(400);
    const ctor = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"constructor":{"prototype":{"admin":true}}}' });
    expect(ctor.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    const big = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.dz', password: 'x'.repeat(1_100_000) }) });
    expect(big.statusCode).toBe(413);
    const xml = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/xml' }, payload: '<x/>' });
    expect(xml.statusCode).toBe(415);
  });

  it('validates every input: unknown values, wrong types and malformed ids are refused before any query', async () => {
    expect((await call('GET', '/v1/admin/users/not-a-uuid', security.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/admin/users?status=hacker', security.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/admin/users?pageSize=100000', security.token)).statusCode).toBe(400);
    expect((await call('GET', `/v1/merchants/${randomUUID()}/disputes/../../admin/users`, customer.token)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('injection and XSS', () => {
  const payloads = ["' OR '1'='1", "'; DROP TABLE users; --", '1; SELECT pg_sleep(5)', "\\'; --", '%_%', '${7*7}', '<script>alert(1)</script>', "admin'--", '"; DELETE FROM orders; --'];

  it('SQL: hostile text in searches and filters is only data (parameterised queries)', async () => {
    const [{ before }] = (await db.select({ before: sql<number>`count(*)::int` }).from(s.users)) as [{ before: number }];
    for (const p of payloads) {
      const q = encodeURIComponent(p);
      for (const url of [`/v1/admin/users?q=${q}`, `/v1/admin/audit-log?action=${q}`, `/v1/stores/mb-parfum/products?q=${q}`]) {
        const started = Date.now();
        const res = await call('GET', url, security.token);
        expect([200, 400], `${url} → ${res.body}`).toContain(res.statusCode);
        expect(Date.now() - started).toBeLessThan(3000); // pg_sleep never ran
      }
    }
    const [{ after }] = (await db.select({ after: sql<number>`count(*)::int` }).from(s.users)) as [{ after: number }];
    expect(after).toBeGreaterThanOrEqual(before); // nothing was deleted
    // Stored as typed, returned as typed.
    const hostile = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail(), password: 'correct horse battery', displayName: "Robert'); DROP TABLE users;--" } });
    expect(hostile.json().data.user.displayName).toBe("Robert'); DROP TABLE users;--");
  });

  it('XSS: the API returns text as JSON (never HTML) and the apps never inject HTML', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail(), password: 'correct horse battery', displayName: '<img src=x onerror=alert(1)>' } });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().data.user.displayName).toBe('<img src=x onerror=alert(1)>'); // React shows it as text
    const appsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (n === 'node_modules' || n === 'dist') return [];
        return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(n) ? [p] : [];
      });
    const offenders = ['admin/src', 'merchant-center/src', 'core/src', 'payments/src']
      .flatMap((d) => walk(join(appsDir, d)))
      .filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(|sql\.raw\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('authorization', () => {
  it('every admin route: anonymous → 401, customer → 403 (recorded), staff without two-step verification → MFA_REQUIRED', async () => {
    const staffNoMfa = await registerUser(app);
    await db.insert(s.staffRoleGrants).values({ userId: staffNoMfa.userId, role: 'super_admin', reason: 'test: no MFA' });
    const admin = routes.filter((r) => r.url.startsWith('/v1/admin'));
    expect(admin.length).toBeGreaterThan(60);
    for (const r of admin) {
      const url = r.url.replace(/:(\w+)/g, (_, name: string) => (/Slug|code|key|kind|role|country|activityCode/.test(name) ? 'x' : randomUUID()));
      for (const method of [r.method].flat().filter((m) => m !== 'HEAD')) {
        const inject = (token?: string) => app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
        expect((await inject()).statusCode, `${method} ${r.url} anonymous`).toBe(401);
        if (r.url === '/v1/admin/me') continue;
        expect((await inject(customer.token)).statusCode, `${method} ${r.url} customer`).toBe(403);
        expect(code(await inject(staffNoMfa.token)), `${method} ${r.url} staff without MFA`).toBe('MFA_REQUIRED');
      }
    }
    const denied = await db.select().from(s.auditLogs).where(sql`${s.auditLogs.actorUserId} = ${customer.userId} and ${s.auditLogs.action} = 'security.access_denied'`);
    expect(denied.length).toBeGreaterThan(60);
  });
});

describe('sessions and passwords', () => {
  it('refuses weak passwords: too short, common, or built on the email', async () => {
    for (const password of ['short9', 'password123', 'azertyuiop', 'aaaaaaaaaaaa']) {
      expect(code(await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail(), password, displayName: 'X' } }))).toMatch(/WEAK_PASSWORD|VALIDATION_ERROR/);
    }
    const email = `yacine.${randomUUID().slice(0, 6)}@example.com`;
    expect(code(await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: `${email.split('@')[0]}2026!`, displayName: 'X' } }))).toBe('WEAK_PASSWORD');
  });

  it('a new password ends every other session', async () => {
    const user = await registerUser(app);
    const other = (await login(user.email)).json().data.token;
    expect(code(await call('POST', '/v1/me/password', user.token, { currentPassword: 'wrong password!!', newPassword: 'a brand new passphrase' }))).toBe('UNAUTHORIZED');
    const res = await call('POST', '/v1/me/password', user.token, { currentPassword: 'correct horse battery', newPassword: 'a brand new passphrase' });
    expect(res.json().data.otherSessionsEnded).toBe(1);
    expect((await call('GET', '/v1/me', other)).statusCode).toBe(401);
    expect((await call('GET', '/v1/me', user.token)).statusCode).toBe(200);
    expect((await login(user.email, 'a brand new passphrase')).statusCode).toBe(200);
  });

  it('staff sessions end after 12 hours, or 30 minutes without activity; customers keep theirs', async () => {
    const staff = await registerUser(app);
    await makeStaff(db, staff.userId, 'support_admin');
    const ok = () => call('GET', '/v1/admin/me', staff.token);
    expect((await ok()).statusCode).toBe(200);
    await db.update(s.sessions).set({ lastUsedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(s.sessions.userId, staff.userId));
    expect((await ok()).statusCode).toBe(401);

    const again = await registerUser(app);
    await makeStaff(db, again.userId, 'support_admin');
    await db.update(s.sessions).set({ createdAt: new Date(Date.now() - 13 * 3600_000) }).where(eq(s.sessions.userId, again.userId));
    expect((await call('GET', '/v1/admin/me', again.token)).statusCode).toBe(401);

    const shopper = await registerUser(app);
    await db.update(s.sessions).set({ lastUsedAt: new Date(Date.now() - 3 * 24 * 3600_000), createdAt: new Date(Date.now() - 5 * 24 * 3600_000) }).where(eq(s.sessions.userId, shopper.userId));
    expect((await call('GET', '/v1/me', shopper.token)).statusCode).toBe(200);
  });

  it('locks an account for 15 minutes after 10 wrong passwords, even for the right one; security sees it', async () => {
    const victim = await registerUser(app);
    for (let i = 0; i < 10; i++) expect((await login(victim.email, `wrong password ${i}`)).statusCode).toBe(401);
    const res = await login(victim.email);
    expect(res.statusCode).toBe(429);
    expect(code(res)).toBe('ACCOUNT_LOCKED');
    const { alerts } = (await call('GET', '/v1/admin/security/alerts', security.token)).json().data;
    expect(alerts).toContainEqual(expect.objectContaining({ code: 'account_locked', severity: 'high', subject: victim.userId }));
    expect((await call('GET', '/v1/admin/security/alerts', customer.token)).statusCode).toBe(403);
  });

  it('rate limits sign-in per IP and every route globally (health checks and internal calls aside)', async () => {
    const limited = buildTestApp(db, { authRateLimitMax: 3, globalRateLimitMax: 8 });
    await limited.ready();
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.com', password: 'whatever!!' } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
      // Each route has its own budget per IP.
      const statuses = [];
      for (let i = 0; i < 10; i++) statuses.push((await limited.inject({ method: 'GET', url: '/v1/stores/mb-parfum' })).statusCode);
      expect(statuses).toContain(429);
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('two-step verification (MFA)', () => {
  it('setup, sign-in with a code, no replay, limited attempts, single-use recovery codes, encrypted secret', async () => {
    const user = await registerUser(app);
    const { secret, otpauthUri } = (await call('POST', '/v1/me/mfa/setup', user.token)).json().data;
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(code(await call('POST', '/v1/me/mfa/enable', user.token, { code: '000000' }))).toBe('INVALID_CODE');
    const other = (await login(user.email)).json().data.token;
    const { recoveryCodes } = (await call('POST', '/v1/me/mfa/enable', user.token, { code: codeAt(secret, stepAt()) })).json().data;
    expect(recoveryCodes).toHaveLength(10);
    expect((await call('GET', '/v1/me', other)).statusCode).toBe(401); // other devices signed out
    const [row] = await db.select().from(s.userMfa).where(eq(s.userMfa.userId, user.userId));
    expect(row!.secretEncrypted).not.toContain(secret);

    // Password alone gives no session.
    const step1 = (await login(user.email)).json().data;
    expect(step1).toMatchObject({ mfaRequired: true });
    expect(step1.token).toBeUndefined();
    const second = (code_: string, token = step1.challengeToken) => app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challengeToken: token, code: code_ } });
    // The code already used to turn it on cannot be used again.
    expect(code(await second(codeAt(secret, stepAt())))).toBe('INVALID_CODE');
    const session = (await second(codeAt(secret, stepAt() + 1))).json().data;
    expect(session.token).toMatch(/^aru_/);
    expect((await call('GET', '/v1/me/mfa', session.token)).json().data).toMatchObject({ enabled: true, sessionVerified: true, recoveryCodesLeft: 10 });

    // Five wrong codes end the challenge.
    const step2 = (await login(user.email)).json().data;
    for (let i = 0; i < 5; i++) expect(code(await second('123456', step2.challengeToken))).toBe('INVALID_CODE');
    expect(code(await second(codeAt(secret, stepAt() + 1), step2.challengeToken))).toBe('CHALLENGE_EXPIRED');

    // A recovery code works once.
    const step3 = (await login(user.email)).json().data;
    expect((await second(recoveryCodes[0].toLowerCase(), step3.challengeToken)).statusCode).toBe(200);
    const step4 = (await login(user.email)).json().data;
    expect(code(await second(recoveryCodes[0], step4.challengeToken))).toBe('INVALID_CODE');
    const failures = await db.select().from(s.auditLogs).where(sql`${s.auditLogs.entityId} = ${user.userId} and ${s.auditLogs.action} = 'identity.mfa.failed'`);
    expect(failures.length).toBeGreaterThanOrEqual(7);

    // Turning it off needs the password and a code.
    expect(code(await call('POST', '/v1/me/mfa/disable', session.token, { password: 'wrong password!!', code: recoveryCodes[1] }))).toBe('UNAUTHORIZED');
    expect((await call('POST', '/v1/me/mfa/disable', session.token, { password: 'correct horse battery', code: recoveryCodes[1] })).statusCode).toBe(204);
    expect((await login(user.email)).json().data.token).toMatch(/^aru_/);
  });

  it('staff cannot turn it off; a lost phone is reset by security, which signs the person out', async () => {
    const staff = await registerUser(app);
    await makeStaff(db, staff.userId, 'finance_admin');
    expect(code(await call('POST', '/v1/me/mfa/disable', staff.token, { password: 'correct horse battery', code: totpNow() }))).toBe('MFA_REQUIRED_FOR_STAFF');
    const user = await registerUser(app);
    const { secret } = (await call('POST', '/v1/me/mfa/setup', user.token)).json().data;
    await call('POST', '/v1/me/mfa/enable', user.token, { code: codeAt(secret, stepAt()) });
    expect((await call('POST', `/v1/admin/users/${user.userId}/mfa/reset`, security.token, { reason: 'Téléphone perdu, identité vérifiée par appel vidéo' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/me', user.token)).statusCode).toBe(401);
    expect((await login(user.email)).json().data.token).toMatch(/^aru_/);
    // A staff member's reset needs a super admin.
    expect((await call('POST', `/v1/admin/users/${staff.userId}/mfa/reset`, security.token, { reason: 'Téléphone perdu, identité vérifiée' })).statusCode).toBe(403);
    expect(STAFF_TOTP_SECRET).toHaveLength(32);
  });
});

describe('encryption, files and configuration', () => {
  it('rotates the encryption key: old values still open, everything is re-sealed with the new key', async () => {
    const owner = await registerUser(app);
    const slug = uniqueSlug();
    const merchantId = (
      await call('POST', '/v1/merchants', owner.token, { type: 'individual', slug, name: 'Rotation', country: 'DZ', activityCode: 'perfume_retail', contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, contactEmail: `${slug}@example.com` })
    ).json().data.id;
    await verifyMerchantViaApi(app, owner, superAdmin, merchantId);

    const newKey = randomBytes(32).toString('base64');
    const rotating = createSecretBox(newKey, [TEST_ENCRYPTION_KEY]);
    const newOnly = createSecretBox(newKey);
    const storage = createLocalStorage(app.storageDir);
    // Run inside a transaction that is rolled back: other test files keep using the test key.
    await db
      .transaction(async (tx) => {
        const report = await rotateEncryption(tx, rotating, storage);
        expect(report.values.resealed).toBeGreaterThan(0);
        expect(report.files.resealed).toBeGreaterThanOrEqual(3); // ID front, back, account proof
        const [identity] = await tx.select().from(s.merchantIdentities).where(eq(s.merchantIdentities.merchantId, merchantId));
        expect(newOnly.open(identity!.documentNumberEncrypted)).toBe('109901234567890');
        const docs = await tx.select().from(s.merchantDocuments).where(eq(s.merchantDocuments.merchantId, merchantId));
        for (const d of docs) expect(newOnly.openBytes(await storage.get(d.storageKey)).length).toBeGreaterThan(0);
        const again = await rotateEncryption(tx, rotating, storage);
        expect(again.values.resealed).toBe(0); // idempotent
        throw new Error('rollback');
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback') throw e;
      });
    // A value sealed with a key that is not configured cannot be opened (no silent fallback).
    expect(() => newOnly.open(createSecretBox(randomBytes(32).toString('base64')).seal('x'))).toThrow(/unknown key/);
    // Tampering is detected (AES-GCM authentication).
    const sealed = Buffer.from(newOnly.seal('secret'), 'base64');
    sealed[sealed.length - 1]! ^= 1;
    expect(() => newOnly.open(sealed.toString('base64'))).toThrow();
  });

  it('stores files only inside the storage folder', async () => {
    const storage = createLocalStorage(mkdtempSync(join(tmpdir(), 'aruma-sec-')));
    await expect(storage.put('../escape.txt', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(storage.get('../../etc/passwd')).rejects.toThrow('Invalid storage key');
  });

  it('refuses to start in production with unsafe settings', () => {
    const base = {
      DATABASE_URL: 'postgres://aruma:x@db.internal:5432/aruma',
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      PAYMENTS_SERVICE_TOKEN: randomBytes(32).toString('hex'),
      PAYMENTS_EVENTS_SECRET: randomBytes(32).toString('hex'),
      NODE_ENV: 'production',
    };
    expect(() => loadConfig({ ...base, STAFF_MFA_REQUIRED: 'false' })).toThrow(/STAFF_MFA_REQUIRED/);
    const problems = productionProblems({ ...loadConfig({ ...base, NODE_ENV: 'development' }), NODE_ENV: 'production' });
    expect(problems.join(' ')).toMatch(/HSTS/);
    expect(problems.join(' ')).toMatch(/TLS/);
    expect(problems.join(' ')).toMatch(/STOREFRONT_URL/);
    const safe = loadConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}?sslmode=verify-full`, HSTS: 'true', STOREFRONT_URL: 'https://mbparfum.dz' });
    expect(safe.STAFF_MFA_REQUIRED).toBe(true);
  });
});
