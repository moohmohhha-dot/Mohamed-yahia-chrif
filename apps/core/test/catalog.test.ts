import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@aruma/db';
import { buildTestApp, testDatabaseUrl } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);

beforeAll(() => app.ready());
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('stores', () => {
  it('returns MB Parfum with its locales and currencies', async () => {
    const res = await get('/v1/stores/mb-parfum');
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data).toMatchObject({ slug: 'mb-parfum', defaultLocale: 'ar', defaultCurrency: 'DZD', vertical: 'perfume' });
    expect(data.locales.map((l: { code: string }) => l.code).sort()).toEqual(['ar', 'en', 'fr']);
    expect(data.locales.find((l: { code: string }) => l.code === 'ar').direction).toBe('rtl');
  });

  it('returns 404 for an unknown store', async () => {
    const res = await get('/v1/stores/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('catalog', () => {
  it('lists products in the store defaults (Arabic, DZD)', async () => {
    const res = await get('/v1/stores/mb-parfum/products');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ locale: 'ar', currency: 'DZD', total: 3, page: 1 });
    const oud = body.data.find((p: { slug: string }) => p.slug === 'oud-royal');
    expect(oud.name).toBe('عود رويال');
    expect(oud.priceFrom).toEqual({ currency: 'DZD', amountMinor: 850000, amount: '8500.00' });
    expect(oud.inStock).toBe(true);
    const marin = body.data.find((p: { slug: string }) => p.slug === 'bois-marin');
    expect(marin.inStock).toBe(false);
  });

  it('switches language and currency', async () => {
    const res = await get('/v1/stores/mb-parfum/products?locale=fr&currency=eur');
    const oud = res.json().data.find((p: { slug: string }) => p.slug === 'oud-royal');
    expect(oud.name).toBe('Oud Royal');
    expect(oud.priceFrom.amount).toBe('59.00');
  });

  it('filters by category and paginates', async () => {
    const res = await get('/v1/stores/mb-parfum/products?category=floral');
    expect(res.json().data.map((p: { slug: string }) => p.slug)).toEqual(['fleur-de-jasmin']);

    const page = await get('/v1/stores/mb-parfum/products?pageSize=2&page=2');
    expect(page.json().data).toHaveLength(1);
    expect(page.json().meta.totalPages).toBe(2);
  });

  it('rejects unsupported locale, currency and bad paging', async () => {
    expect((await get('/v1/stores/mb-parfum/products?locale=de')).json().error.code).toBe('UNSUPPORTED_LOCALE');
    expect((await get('/v1/stores/mb-parfum/products?currency=GBP')).json().error.code).toBe('UNSUPPORTED_CURRENCY');
    const res = await get('/v1/stores/mb-parfum/products?pageSize=500');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown category', async () => {
    expect((await get('/v1/stores/mb-parfum/products?category=nope')).statusCode).toBe(404);
  });

  it('returns product details with variants priced in the requested currency', async () => {
    const res = await get('/v1/stores/mb-parfum/products/oud-royal?locale=en&currency=USD');
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.name).toBe('Oud Royal');
    expect(data.attributes.concentration).toBe('EDP');
    expect(data.categories).toEqual(['oriental']);
    expect(data.variants.map((v: { options: { sizeMl: number } }) => v.options.sizeMl)).toEqual([50, 100]);
    expect(data.variants[1].price).toEqual({ currency: 'USD', amountMinor: 10400, amount: '104.00' });
  });

  it('returns 404 for an unknown product', async () => {
    expect((await get('/v1/stores/mb-parfum/products/nope')).statusCode).toBe(404);
  });

  it('lists translated categories', async () => {
    const res = await get('/v1/stores/mb-parfum/categories?locale=en');
    expect(res.json().data.map((c: { name: string }) => c.name)).toEqual(['Oriental', 'Floral', 'Fresh']);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    expect((await get('/v2/whatever')).json().error.code).toBe('NOT_FOUND');
  });
});
