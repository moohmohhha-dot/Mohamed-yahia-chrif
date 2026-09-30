import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { buildTestApp, testDatabaseUrl } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);

/** A second vertical app (MB Beauty) must run on the same platform without leaking into MB Parfum. */
beforeAll(async () => {
  await app.ready();
  const [merchant] = await db.select().from(s.merchants).where(eq(s.merchants.slug, 'mb-parfum'));
  const [store] = await db
    .insert(s.stores)
    .values({ slug: 'mb-beauty', name: 'MB Beauty', vertical: 'beauty', status: 'active', defaultLocale: 'fr', defaultCurrency: 'DZD' })
    .returning();
  await db.insert(s.storeLocales).values([{ storeId: store!.id, locale: 'fr' }]);
  await db.insert(s.storeCurrencies).values([{ storeId: store!.id, currency: 'DZD' }]);
  await db.insert(s.storeMerchants).values({ storeId: store!.id, merchantId: merchant!.id });
  // Same slug as an MB Parfum product on purpose: slugs are unique per store, not globally.
  const [product] = await db
    .insert(s.products)
    .values({ storeId: store!.id, slug: 'oud-royal', status: 'active', attributes: { skinType: 'all' } })
    .returning();
  await db.insert(s.productTranslations).values({ productId: product!.id, locale: 'fr', name: 'Crème Oud' });
  const [variant] = await db.insert(s.productVariants).values({ productId: product!.id, sku: 'CREME-OUD' }).returning();
  const [offer] = await db
    .insert(s.offers)
    .values({ storeId: store!.id, variantId: variant!.id, merchantId: merchant!.id, stockQuantity: 5 })
    .returning();
  await db.insert(s.offerPrices).values({ offerId: offer!.id, currency: 'DZD', amountMinor: 250000n });
});

afterAll(async () => {
  await db.delete(s.stores).where(eq(s.stores.slug, 'mb-beauty'));
  await app.close();
  await pool.end();
});

describe('multiple apps on one platform', () => {
  it('serves each store its own catalog, defaults and vertical attributes', async () => {
    const beauty = (await app.inject({ method: 'GET', url: '/v1/stores/mb-beauty/products' })).json();
    expect(beauty.meta).toMatchObject({ locale: 'fr', total: 1 });
    expect(beauty.data[0]).toMatchObject({
      name: 'Crème Oud',
      attributes: { skinType: 'all' },
      priceFrom: { amount: '2500.00' },
      inStock: true,
    });

    const parfum = (await app.inject({ method: 'GET', url: '/v1/stores/mb-parfum/products/oud-royal' })).json();
    expect(parfum.data.name).toBe('عود رويال');
  });

  it('enforces each store’s own languages', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/stores/mb-beauty/products?locale=ar' });
    expect(res.json().error.code).toBe('UNSUPPORTED_LOCALE');
  });
});
