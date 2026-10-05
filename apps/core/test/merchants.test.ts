import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { bearer, buildTestApp, registerUser, testDatabaseUrl, verifyMerchantViaApi } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);

type Req = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; token?: string; payload?: unknown };
const call = ({ method, url, token, payload }: Req) =>
  app.inject({ method, url, headers: token ? bearer(token) : {}, payload: payload as object });

let owner: Awaited<ReturnType<typeof registerUser>>;
let staff: Awaited<ReturnType<typeof registerUser>>;
let outsider: Awaited<ReturnType<typeof registerUser>>;
let admin: Awaited<ReturnType<typeof registerUser>>;
let merchantId: string;
let oud50VariantId: string;
const createdMerchantIds: string[] = [];

beforeAll(async () => {
  await app.ready();
  [owner, staff, outsider, admin] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  const [variant] = await db.select().from(s.productVariants).where(eq(s.productVariants.sku, 'OUD-ROYAL-50ML'));
  oud50VariantId = variant!.id;
});

afterAll(async () => {
  // Merchants with stock history cannot be deleted (append-only records), so detach the test merchant
  // from the store instead: other test files then see the original MB Parfum catalog.
  if (createdMerchantIds.length) {
    await db.update(s.storeMerchants).set({ status: 'archived' }).where(inArray(s.storeMerchants.merchantId, createdMerchantIds));
  }
  await app.close();
  await pool.end();
});

const offerPayload = (prices: { currency: string; amountMinor: number }[]) => ({
  variantId: oud50VariantId,
  stockQuantity: 3,
  prices,
});

describe('merchant lifecycle: create → staff → verify → sell (details in merchant-verification.test.ts)', () => {
  it('lets any user create a merchant and become its owner', async () => {
    const res = await call({
      method: 'POST',
      url: '/v1/merchants',
      token: owner.token,
      payload: {
        type: 'business',
        slug: 'parfums-el-bahdja',
        name: 'Parfums El Bahdja',
        country: 'dz',
        activityCode: 'perfume_retail',
        contactPhone: '+213555000000',
        contactEmail: 'contact@el-bahdja.example',
      },
    });
    expect(res.statusCode).toBe(201);
    const merchant = res.json().data;
    expect(merchant).toMatchObject({ status: 'draft', verificationStatus: 'unverified', country: 'DZ' });
    merchantId = merchant.id;
    createdMerchantIds.push(merchantId);

    const mine = await call({ method: 'GET', url: '/v1/me/merchants', token: owner.token });
    expect(mine.json().data).toEqual([expect.objectContaining({ role: 'owner' })]);
  });

  it('rejects duplicate slugs and hides merchants from non-members', async () => {
    const dup = await call({
      method: 'POST',
      url: '/v1/merchants',
      token: outsider.token,
      payload: { type: 'individual', slug: 'parfums-el-bahdja', name: 'X', country: 'DZ', activityCode: 'perfume_retail' },
    });
    expect(dup.json().error.code).toBe('SLUG_TAKEN');
    expect((await call({ method: 'GET', url: `/v1/merchants/${merchantId}`, token: outsider.token })).statusCode).toBe(404);
    expect((await call({ method: 'POST', url: '/v1/merchants', payload: { slug: 'x', name: 'x' } })).statusCode).toBe(401);
  });

  it('manages staff with role rules', async () => {
    const add = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/staff`,
      token: owner.token,
      payload: { email: staff.email, role: 'staff' },
    });
    expect(add.statusCode).toBe(200);

    // Staff cannot manage staff; nobody can change the owner.
    const byStaff = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/staff`,
      token: staff.token,
      payload: { email: outsider.email, role: 'staff' },
    });
    expect(byStaff.statusCode).toBe(403);
    const ownerChange = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/staff`,
      token: owner.token,
      payload: { email: owner.email, role: 'staff' },
    });
    expect(ownerChange.json().error.code).toBe('OWNER_IMMUTABLE');

    // Add then remove the outsider.
    await call({ method: 'PUT', url: `/v1/merchants/${merchantId}/staff`, token: owner.token, payload: { email: outsider.email, role: 'manager' } });
    const list = await call({ method: 'GET', url: `/v1/merchants/${merchantId}/staff`, token: staff.token });
    expect(list.json().data.map((m: { role: string }) => m.role).sort()).toEqual(['manager', 'owner', 'staff']);
    const removed = await call({ method: 'DELETE', url: `/v1/merchants/${merchantId}/staff/${outsider.userId}`, token: owner.token });
    expect(removed.statusCode).toBe(204);
  });

  it('refuses offers before verification', async () => {
    const res = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: staff.token,
      payload: offerPayload([{ currency: 'DZD', amountMinor: 800000 }]),
    });
    expect(res.json().error.code).toBe('MERCHANT_NOT_VERIFIED');
  });

  it('becomes verified once every required check is approved', async () => {
    const overview = await verifyMerchantViaApi(app, owner, admin, merchantId);
    expect(overview.status).toBe('verified');
    const merchant = (await call({ method: 'GET', url: `/v1/merchants/${merchantId}`, token: owner.token })).json().data;
    expect(merchant).toMatchObject({ verificationStatus: 'verified', status: 'active' });
  });

  it('requires the platform to allow the merchant in the store', async () => {
    const res = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: staff.token,
      payload: offerPayload([{ currency: 'DZD', amountMinor: 800000 }]),
    });
    expect(res.json().error.code).toBe('NOT_ALLOWED_IN_STORE');

    const attach = await call({
      method: 'PUT',
      url: `/v1/admin/stores/mb-parfum/merchants/${merchantId}`,
      token: admin.token,
      payload: { commissionBps: 1200 },
    });
    expect(attach.json().data).toMatchObject({ commissionBps: 1200, status: 'active' });
  });

  it('validates offer currencies', async () => {
    const res = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: staff.token,
      payload: offerPayload([{ currency: 'GBP', amountMinor: 1000 }]),
    });
    expect(res.json().error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  it('publishes a competing offer that the storefront picks when it is cheaper', async () => {
    const res = await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: staff.token,
      payload: offerPayload([{ currency: 'DZD', amountMinor: 800000 }]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ onHandQuantity: 3, availableQuantity: 3, prices: [{ currency: 'DZD', amountMinor: 800000 }] });

    const product = (await call({ method: 'GET', url: '/v1/stores/mb-parfum/products/oud-royal' })).json().data;
    const v50 = product.variants.find((v: { id: string }) => v.id === oud50VariantId);
    expect(v50).toMatchObject({ offerCount: 2, price: { amount: '8000.00' }, offer: { merchant: { slug: 'parfums-el-bahdja' } } });

    // No EUR price from this merchant → in EUR the MB Parfum offer is the only one.
    const eur = (await call({ method: 'GET', url: '/v1/stores/mb-parfum/products/oud-royal?currency=EUR' })).json().data;
    expect(eur.variants.find((v: { id: string }) => v.id === oud50VariantId)).toMatchObject({
      offerCount: 1,
      offer: { merchant: { slug: 'mb-parfum' } },
    });
  });

  it('prefers an in-stock offer and hides archived offers', async () => {
    // Out of stock but cheaper → the in-stock MB Parfum offer wins.
    await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: owner.token,
      payload: { ...offerPayload([{ currency: 'DZD', amountMinor: 700000 }]), stockQuantity: 0 },
    });
    let v50 = (await call({ method: 'GET', url: '/v1/stores/mb-parfum/products/oud-royal' })).json().data.variants[0];
    expect(v50).toMatchObject({ offer: { merchant: { slug: 'mb-parfum' } }, price: { amount: '8500.00' } });

    await call({
      method: 'PUT',
      url: `/v1/merchants/${merchantId}/offers`,
      token: owner.token,
      payload: { ...offerPayload([{ currency: 'DZD', amountMinor: 700000 }]), status: 'archived' },
    });
    v50 = (await call({ method: 'GET', url: '/v1/stores/mb-parfum/products/oud-royal' })).json().data.variants[0];
    expect(v50.offerCount).toBe(1);

    const offers = await call({ method: 'GET', url: `/v1/merchants/${merchantId}/offers`, token: staff.token });
    expect(offers.json().data).toHaveLength(1);
  });
});

describe('feature flags', () => {
  it('returns defaults and applies per-store overrides', async () => {
    const url = '/v1/stores/mb-parfum/features';
    expect((await call({ method: 'GET', url })).json().data).toEqual({
      'checkout.cash_on_delivery': true,
      'checkout.online_payment': false,
      'shipping.pickup_points': false,
      'reviews.media': false,
    });
    const [store] = await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum'));
    await db.insert(s.featureFlagOverrides).values({ flagKey: 'checkout.online_payment', storeId: store!.id, enabled: true });
    expect((await call({ method: 'GET', url })).json().data['checkout.online_payment']).toBe(true);
    await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, store!.id));
  });
});
