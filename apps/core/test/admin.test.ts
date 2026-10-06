import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES, type StaffRole } from '../src/modules/identity/index.js';
import { buildTestApp, caller, makeStaff, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let superAdmin: TestUser;
let superAdmin2: TestUser;
const as: Partial<Record<StaffRole, TestUser>> = {};
let customer: TestUser;
let owner: TestUser;
let merchantId: string;
let productId: string;
let productSlug: string;
const flagKey = `test.admin_${randomUUID().slice(0, 8)}`;
/** A store of this test file only, so its products never show in other test files' MB Parfum listings. */
const storeSlug = `admin-test-${randomUUID().slice(0, 8)}`;

const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};
const code = (res: Awaited<ReturnType<typeof call>>) => res.json().error?.code;
const why = { reason: 'Contrôle de routine ARUMA' };

beforeAll(async () => {
  await app.ready();
  [superAdmin, superAdmin2, customer, owner] = (await Promise.all(Array.from({ length: 4 }, () => registerUser(app)))) as [TestUser, TestUser, TestUser, TestUser];
  await makeStaff(db, superAdmin.userId, 'super_admin');
  await makeStaff(db, superAdmin2.userId, 'super_admin');
  for (const role of STAFF_ROLES.filter((r) => r !== 'super_admin')) {
    as[role] = await registerUser(app);
    await makeStaff(db, as[role]!.userId, role);
  }
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Admin Test Shop',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, superAdmin, merchantId);
  const [store] = await db.insert(s.stores).values({ slug: storeSlug, name: 'Admin test store', vertical: 'perfume', status: 'active', defaultLocale: 'ar', defaultCurrency: 'DZD' }).returning();
  await db.insert(s.storeLocales).values(['ar', 'fr'].map((locale) => ({ storeId: store!.id, locale })));
  await db.insert(s.storeCurrencies).values({ storeId: store!.id, currency: 'DZD' });
  await db.insert(s.storeCountries).values({ storeId: store!.id, country: 'DZ' });
  await ok(await call('PUT', `/v1/admin/stores/${storeSlug}/merchants/${merchantId}`, superAdmin.token, { commissionBps: null }));
  productSlug = uniqueSlug('adm');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug,
      slug: productSlug,
      translations: [{ locale: 'ar', name: 'ورد' }, { locale: 'fr', name: 'Rose de Taïf' }],
      variants: [{ sku: `${productSlug}-50`, options: { sizeMl: 50 } }],
    })
  ).json().data.id;
  await ok(await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' }));
  await db.insert(s.featureFlags).values({ key: flagKey, description: 'Admin test flag', enabledByDefault: false });
});

afterAll(async () => {
  await db.delete(s.featureFlags).where(eq(s.featureFlags.key, flagKey));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('roles and permissions', () => {
  it('every permission belongs to the super admin; each other role has a bounded set', () => {
    expect([...ROLE_PERMISSIONS.super_admin].sort()).toEqual([...PERMISSIONS].sort());
    // Who may change who is staff, and the feature switches: super admins only.
    for (const role of STAFF_ROLES.filter((r) => r !== 'super_admin')) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('staff.manage');
      expect(ROLE_PERMISSIONS[role]).not.toContain('flags.manage');
    }
    // Money leaves ARUMA only through Finance; Support decides but does not pay.
    expect(STAFF_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('refunds.execute'))).toEqual(['super_admin', 'finance_admin']);
    expect(STAFF_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('payouts.manage'))).toEqual(['super_admin', 'finance_admin']);
    expect(STAFF_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('security.read'))).toEqual(['super_admin', 'security_admin']);
  });

  it('the panel knows who is staff and what they may do; customers and merchants get nothing', async () => {
    const me = await ok(await call('GET', '/v1/admin/me', as.finance_admin!.token));
    expect(me).toMatchObject({ roles: ['finance_admin'] });
    expect(me.permissions).toContain('payouts.manage');
    expect(me.permissions).not.toContain('catalog.moderate');
    expect((await call('GET', '/v1/admin/me', customer.token)).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/me', owner.token)).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/me')).statusCode).toBe(401);
    expect((await call('GET', '/v1/admin/overview', owner.token)).statusCode).toBe(403);
  });

  it('each role reaches its own sections and nothing else', async () => {
    const routes: [string, string, StaffRole[]][] = [
      ['GET', '/v1/admin/users', ['finance_admin', 'support_admin', 'security_admin', 'operations_admin']],
      ['GET', '/v1/admin/staff', ['security_admin']],
      ['GET', '/v1/admin/finance/trial-balance', ['finance_admin']],
      ['GET', '/v1/admin/finance/settlements', ['finance_admin']],
      ['GET', '/v1/admin/payments', ['finance_admin', 'support_admin', 'security_admin', 'operations_admin']],
      ['GET', '/v1/admin/products', ['support_admin', 'content_admin', 'operations_admin']],
      ['GET', '/v1/admin/inventory', ['support_admin', 'operations_admin']],
      ['GET', '/v1/admin/reviews', ['content_admin']],
      ['GET', '/v1/admin/returns', ['finance_admin', 'support_admin', 'operations_admin']],
      ['GET', '/v1/admin/disputes', ['finance_admin', 'support_admin', 'operations_admin']],
      ['GET', '/v1/admin/cod/blocks', ['security_admin']],
      ['GET', '/v1/admin/audit-log', ['security_admin']],
      ['GET', '/v1/admin/analytics', ['finance_admin', 'content_admin', 'operations_admin']],
      ['GET', '/v1/admin/couriers', ['support_admin', 'operations_admin']],
      ['GET', '/v1/admin/merchants', ['finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin']],
      ['GET', '/v1/admin/feature-flags', ['finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin']],
    ];
    for (const [method, url, allowed] of routes) {
      for (const role of STAFF_ROLES.filter((r) => r !== 'super_admin')) {
        const status = (await call(method as 'GET', url, as[role]!.token)).statusCode;
        expect(status, `${role} ${url}`).toBe(allowed.includes(role) ? 200 : 403);
      }
      expect((await call(method as 'GET', url, superAdmin.token)).statusCode, `super_admin ${url}`).toBe(200);
    }
  });

  it('the overview only shows the queues a role can act on', async () => {
    const keys = async (role: StaffRole) => (await ok(await call('GET', '/v1/admin/overview', as[role]!.token))).queues.map((q: any) => q.key);
    expect(await keys('finance_admin')).toEqual(expect.arrayContaining(['refundsToSend', 'payoutsToSend']));
    expect(await keys('finance_admin')).not.toContain('reviewsPending');
    expect(await keys('content_admin')).toEqual(['reviewsPending', 'reviewReports', 'blockedProducts']);
    const overview = await ok(await call('GET', '/v1/admin/overview', as.content_admin!.token));
    expect(overview.numbers.users).toBeUndefined(); // content admins do not see people
    expect(overview.numbers.sales7d).toEqual(expect.any(Array));
  });
});

describe('staff roles', () => {
  it('a super admin grants and revokes roles with a reason; the change applies at once and is kept in the history', async () => {
    const newcomer = await registerUser(app);
    expect((await call('GET', '/v1/admin/payments', newcomer.token)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/users/${newcomer.userId}/staff-roles`, as.security_admin!.token, { role: 'finance_admin', ...why })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/users/${newcomer.userId}/staff-roles`, superAdmin.token, { role: 'finance_admin', reason: 'x' })).statusCode).toBe(400);
    await ok(await call('POST', `/v1/admin/users/${newcomer.userId}/staff-roles`, superAdmin.token, { role: 'finance_admin', reason: 'Recrutée comme comptable' }), 201);
    expect(code(await call('POST', `/v1/admin/users/${newcomer.userId}/staff-roles`, superAdmin.token, { role: 'finance_admin', reason: 'Recrutée comme comptable' }))).toBe('ROLE_ALREADY_HELD');
    expect((await call('GET', '/v1/admin/payments', newcomer.token)).statusCode).toBe(200);

    await ok(await call('POST', `/v1/admin/users/${newcomer.userId}/staff-roles/finance_admin/revoke`, superAdmin.token, { reason: 'Fin de contrat' }));
    expect((await call('GET', '/v1/admin/payments', newcomer.token)).statusCode).toBe(403);
    const staff = await ok(await call('GET', '/v1/admin/staff', as.security_admin!.token));
    expect(staff.history.find((g: any) => g.userId === newcomer.userId)).toMatchObject({ role: 'finance_admin', reason: 'Recrutée comme comptable', revokeReason: 'Fin de contrat', grantedByName: 'Test User', revokedByName: 'Test User' });
    expect(staff.active.some((g: any) => g.userId === newcomer.userId)).toBe(false);

    const log = await ok(await call('GET', `/v1/admin/audit-log?action=staff.role&entityId=${newcomer.userId}`, as.security_admin!.token));
    expect(log.map((e: any) => e.action)).toEqual(['staff.role.revoked', 'staff.role.granted']);
  });

  it('a super admin cannot remove their own super admin role; grants cannot be rewritten or deleted', async () => {
    expect((await call('POST', `/v1/admin/users/${superAdmin.userId}/staff-roles/super_admin/revoke`, superAdmin.token, why)).statusCode).toBe(403);
    const [grant] = await db.select().from(s.staffRoleGrants).where(eq(s.staffRoleGrants.userId, superAdmin.userId));
    await expect(db.execute(sql`update staff_role_grants set role = 'finance_admin' where id = ${grant!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from staff_role_grants where id = ${grant!.id}`)).rejects.toThrow();
  });
});

describe('users', () => {
  it('finds people, suspends them (signed out everywhere, cannot sign in) and reactivates them', async () => {
    const person = await registerUser(app);
    const found = await ok(await call('GET', `/v1/admin/users?q=${encodeURIComponent(person.email)}`, as.support_admin!.token));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: person.userId, status: 'active', staffRoles: [] });
    const detail = await ok(await call('GET', `/v1/admin/users/${person.userId}`, as.support_admin!.token));
    expect(detail.activeSessions).toBe(1);
    expect('staffHistory' in detail || 'storeCredit' in detail).toBe(false); // staff history: security; balances: finance

    expect((await call('POST', `/v1/admin/users/${person.userId}/suspend`, as.support_admin!.token, why)).statusCode).toBe(403);
    const suspended = await ok(await call('POST', `/v1/admin/users/${person.userId}/suspend`, as.security_admin!.token, { reason: 'Fraude à la livraison' }));
    expect(suspended).toEqual({ status: 'suspended', sessionsEnded: 1 });
    expect((await call('GET', '/v1/me', person.token)).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: person.email, password: 'correct horse battery' } });
    expect(login.statusCode).toBe(403);
    await ok(await call('POST', `/v1/admin/users/${person.userId}/reactivate`, as.security_admin!.token, { reason: 'Vérification faite, erreur' }));
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: person.email, password: 'correct horse battery' } })).statusCode).toBe(200);
  });

  it('staff accounts are only touched by super admins; nobody acts on their own account', async () => {
    expect((await call('POST', `/v1/admin/users/${as.finance_admin!.userId}/suspend`, as.security_admin!.token, why)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/users/${as.security_admin!.userId}/sessions/end`, as.security_admin!.token, why)).statusCode).toBe(403);
    const ended = await ok(await call('POST', `/v1/admin/users/${as.content_admin!.userId}/sessions/end`, superAdmin.token, why));
    expect(ended.sessionsEnded).toBe(1);
    as.content_admin!.token = (await ok(await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: as.content_admin!.email, password: 'correct horse battery' } }))).token;
  });
});

describe('catalog moderation', () => {
  it('a content admin takes a product off sale; the merchant sees why and cannot republish it; unblocking restores it', async () => {
    const shown = () => app.inject({ method: 'GET', url: `/v1/stores/${storeSlug}/products/${productSlug}` });
    expect((await shown()).statusCode).toBe(200);
    const list = await ok(await call('GET', `/v1/admin/products?q=${encodeURIComponent('Rose de Taïf')}`, as.content_admin!.token));
    expect(list[0]).toMatchObject({ id: productId, status: 'active', merchantName: 'Admin Test Shop', blocked: null, names: { fr: 'Rose de Taïf' } });

    expect((await call('POST', `/v1/admin/products/${productId}/block`, as.support_admin!.token, why)).statusCode).toBe(403);
    const blocked = await ok(await call('POST', `/v1/admin/products/${productId}/block`, as.content_admin!.token, { reason: 'Contrefaçon signalée par la marque' }));
    expect(blocked).toMatchObject({ status: 'archived', blocked: { reason: 'Contrefaçon signalée par la marque', previousStatus: 'active' } });
    expect(blocked.history[0]).toMatchObject({ action: 'catalog.product.blocked' });
    expect((await shown()).statusCode).toBe(404);

    const republish = await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
    expect(code(republish)).toBe('PRODUCT_BLOCKED');
    const mine = (await ok(await call('GET', `/v1/merchants/${merchantId}/products`, owner.token))).find((p: any) => p.id === productId);
    expect(mine.blocked).toMatchObject({ reason: 'Contrefaçon signalée par la marque' });
    await expect(db.execute(sql`update products set status = 'active' where id = ${productId}`)).rejects.toThrow();

    const restored = await ok(await call('POST', `/v1/admin/products/${productId}/unblock`, as.content_admin!.token, { reason: 'Facture de la marque fournie' }));
    expect(restored).toMatchObject({ status: 'active', blocked: null });
    expect((await shown()).statusCode).toBe(200);
  });

  it('staff never act on a merchant they belong to', async () => {
    // The merchant's owner is also a content admin: another staff member must decide.
    await makeStaff(db, owner.userId, 'content_admin');
    const res = await call('POST', `/v1/admin/products/${productId}/block`, owner.token, why);
    expect(code(res)).toBe('CONFLICT_OF_INTEREST');
    await makeStaff(db, owner.userId, 'operations_admin');
    expect(code(await call('POST', `/v1/admin/merchants/${merchantId}/suspend`, owner.token, why))).toBe('CONFLICT_OF_INTEREST');
    await db.execute(sql`update staff_role_grants set revoked_at = now(), revoke_reason = 'test' where user_id = ${owner.userId} and revoked_at is null`);
  });

  it('lists offers and stock across merchants', async () => {
    const variantId = (await ok(await call('GET', `/v1/merchants/${merchantId}/products`, owner.token))).find((p: any) => p.id === productId).variants[0].id;
    await ok(await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 3, prices: [{ currency: 'DZD', amountMinor: 650000 }] }));
    const offers = await ok(await call('GET', `/v1/admin/offers?merchantId=${merchantId}`, as.operations_admin!.token));
    expect(offers[0]).toMatchObject({ merchantName: 'Admin Test Shop', available: 3, prices: [{ currency: 'DZD', amountMinor: 650000 }], productNames: { fr: 'Rose de Taïf' } });
    const low = await ok(await call('GET', `/v1/admin/inventory?merchantId=${merchantId}&low=true`, as.operations_admin!.token));
    expect(low[0]).toMatchObject({ onHand: 3, low: true });
  });
});

describe('platform', () => {
  it('feature flags: everyone on staff reads them; only super admins switch them, with a reason, per store or for all', async () => {
    const store = (await ok(await call('GET', '/v1/admin/stores', as.operations_admin!.token))).find((x: any) => x.slug === storeSlug);
    expect((await call('PUT', `/v1/admin/feature-flags/${flagKey}`, as.operations_admin!.token, { enabledByDefault: true, ...why })).statusCode).toBe(403);
    const features = async () => (await app.inject({ method: 'GET', url: `/v1/stores/${storeSlug}/features` })).json().data[flagKey];
    expect(await features()).toBe(false);
    await ok(await call('PUT', `/v1/admin/feature-flags/${flagKey}/stores/${store.id}`, superAdmin.token, { enabled: true, reason: 'Essai sur une boutique' }));
    expect(await features()).toBe(true);
    const flags = await ok(await call('PUT', `/v1/admin/feature-flags/${flagKey}/stores/${store.id}`, superAdmin.token, { enabled: null, reason: 'Fin de l’essai' }));
    expect(flags.find((f: any) => f.key === flagKey).overrides).toEqual([]);
    await ok(await call('PUT', `/v1/admin/feature-flags/${flagKey}`, superAdmin.token, { enabledByDefault: true, reason: 'Ouverture à tous' }));
    expect(await features()).toBe(true);
    const log = await ok(await call('GET', `/v1/admin/audit-log?entityType=feature_flag&entityId=${flagKey}`, superAdmin.token));
    expect(log.map((e: any) => e.metadata.reason)).toEqual(['Ouverture à tous', 'Fin de l’essai', 'Essai sur une boutique']);
  });

  it('analytics give one row per day; payments are listed with amounts due', async () => {
    const a = await ok(await call('GET', '/v1/admin/analytics?days=7', as.operations_admin!.token));
    expect(a.days).toHaveLength(7);
    expect(a.days.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
    expect(a.days.reduce((sum: number, d: any) => sum + d.users, 0)).toBeGreaterThan(0);
    const p = await ok(await call('GET', '/v1/admin/payments?pageSize=5', as.finance_admin!.token));
    expect(p.summary).toEqual(expect.any(Array));
    expect(p.payments.length).toBeLessThanOrEqual(5);
  });
});
