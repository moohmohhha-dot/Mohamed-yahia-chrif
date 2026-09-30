import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { buildApp } from '../src/app.js';
import { bearer, registerUser, testDatabaseUrl, uniqueEmail } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildApp(db, { authRateLimitMax: 1000 });

beforeAll(() => app.ready());
afterAll(async () => {
  await app.close();
  await pool.end();
});

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { email, password } });

describe('registration', () => {
  it('creates a user with a password account, a session, an audit entry and an event', async () => {
    const email = uniqueEmail();
    const { token, userId } = await registerUser(app, email.toUpperCase());
    expect(token).toMatch(/^aru_/);

    const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
    expect(user).toMatchObject({ email, role: 'user', locale: 'ar', country: 'DZ' });
    const accounts = await db.select().from(s.accounts).where(eq(s.accounts.userId, userId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.passwordHash).toMatch(/^scrypt\$/);
    expect(accounts[0]!.passwordHash).not.toContain('correct horse');

    const [session] = await db.select().from(s.sessions).where(eq(s.sessions.userId, userId));
    expect(session!.tokenHash).not.toBe(token);

    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, userId));
    expect(audits.map((a) => a.action)).toContain('identity.user.registered');
    const events = await db
      .select()
      .from(s.domainEvents)
      .where(and(eq(s.domainEvents.aggregateId, userId), eq(s.domainEvents.type, 'identity.user.registered')));
    expect(events).toHaveLength(1);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const { email } = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: email.toUpperCase(), password: 'another password', displayName: 'X' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects short passwords and invalid emails', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: 'short', displayName: 'X' },
    });
    expect(weak.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: 'long enough password', displayName: 'X' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('login and sessions', () => {
  it('logs in with the right password only, with the same error for unknown emails', async () => {
    const { email } = await registerUser(app);
    const wrong = await login(email, 'wrong password');
    const unknown = await login(uniqueEmail(), 'wrong password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());

    const ok = await login(email, 'correct horse battery');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user.email).toBe(email);
  });

  it('protects /v1/me and rejects bad tokens', async () => {
    const { token, email } = await registerUser(app);
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('aru_nope') })).statusCode).toBe(401);
    // A stale token must not break public pages.
    const pub = await app.inject({ method: 'GET', url: '/v1/stores/mb-parfum', headers: bearer('aru_nope') });
    expect(pub.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({ email, emailVerified: false });
  });

  it('tracks devices, lists sessions and revokes them', async () => {
    const { email, token: webToken } = await registerUser(app);
    const phone = { 'x-device-id': 'phone-123', 'x-client-platform': 'android' };
    const first = (await login(email, 'correct horse battery', phone)).json().data.token;
    await login(email, 'correct horse battery', phone); // same device → no duplicate device row

    const list = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(webToken) });
    const sessions = list.json().data;
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    expect(sessions.filter((x: { platform: string }) => x.platform === 'android')).toHaveLength(2);

    const [user] = await db.select().from(s.users).where(eq(s.users.email, email));
    const devices = await db.select().from(s.devices).where(eq(s.devices.userId, user!.id));
    expect(devices).toHaveLength(2);

    // Revoke the phone session from the web session.
    const me = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(first) });
    const phoneSessionId = me.json().data.find((x: { current: boolean }) => x.current).id;
    const del = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${phoneSessionId}`, headers: bearer(webToken) });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(first) })).statusCode).toBe(401);
  });

  it('cannot revoke another user’s session', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const bSessions = (await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(b.token) })).json().data;
    const res = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${bSessions[0].id}`, headers: bearer(a.token) });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(b.token) })).statusCode).toBe(200);
  });

  it('logout invalidates the token', async () => {
    const { token } = await registerUser(app);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('blocks suspended users', async () => {
    const { email, token, userId } = await registerUser(app);
    await db.update(s.users).set({ status: 'suspended' }).where(eq(s.users.id, userId));
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode).toBe(401);
    expect((await login(email, 'correct horse battery')).statusCode).toBe(403);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per IP', async () => {
    const limited = buildApp(db, { authRateLimitMax: 2 });
    await limited.ready();
    const attempt = () =>
      limited.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: uniqueEmail(), password: 'x' } });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    await limited.close();
  });
});
