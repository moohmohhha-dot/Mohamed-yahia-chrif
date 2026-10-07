import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { processSearchQueue } from '../src/modules/search/index.js';
import { normalizeText, queryWords } from '../src/modules/search/normalize.js';
import { rulesInterpreter } from '../src/modules/search/interpret.js';
import { buildTestApp, caller, makeStaff, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

/** This file's own store: its products never show in other test files, and theirs never here. */
const storeSlug = `search-${randomUUID().slice(0, 8)}`;
let storeId: string;
let admin: TestUser;
let content: TestUser;
let ops: TestUser;
let ownerA: TestUser;
let ownerB: TestUser;
let merchantA: { id: string; slug: string };
let merchantB: { id: string; slug: string };
const products: Record<string, string> = {};

const find = async (params: Record<string, string | number | boolean>) => {
  const res = await app.inject({ method: 'GET', url: `/v1/stores/${storeSlug}/search`, query: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
};
const slugs = (data: any) => data.results.map((r: any) => r.slug);
const index = async () => {
  while ((await processSearchQueue(db)) > 0);
};

async function newMerchant(owner: TestUser, name: string) {
  const slug = uniqueSlug();
  const id = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name,
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id as string;
  await verifyMerchantViaApi(app, owner, admin, id);
  await call('PUT', `/v1/admin/stores/${storeSlug}/merchants/${id}`, admin.token, { commissionBps: null });
  return { id, slug };
}

async function product(owner: TestUser, merchantId: string, key: string, input: { names: Record<string, string>; description?: Record<string, string>; categories?: string[]; brand?: string; gender?: string; concentration?: string; price?: number; stock?: number; status?: string }) {
  const slug = `${key}-${randomUUID().slice(0, 6)}`;
  const created = await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
    storeSlug,
    slug,
    brandSlug: input.brand,
    categorySlugs: input.categories ?? [],
    attributes: { gender: input.gender ?? 'unisex', concentration: input.concentration ?? 'EDP' },
    translations: Object.entries(input.names).map(([locale, name]) => ({ locale, name, description: input.description?.[locale] })),
    variants: [{ sku: `${slug}-v`, options: { sizeMl: 100 } }],
  });
  expect(created.statusCode, created.body).toBe(201);
  const p = created.json().data;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${p.id}`, owner.token, { status: input.status ?? 'active' });
  if (input.price !== undefined) {
    const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((x: any) => x.id === p.id).variants[0].id;
    const offer = await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: input.stock ?? 5, prices: [{ currency: 'DZD', amountMinor: input.price * 100 }] });
    expect(offer.statusCode, offer.body).toBe(200);
  }
  products[key] = p.id;
  return { id: p.id as string, slug };
}

beforeAll(async () => {
  await app.ready();
  [admin, content, ops, ownerA, ownerB] = (await Promise.all(Array.from({ length: 5 }, () => registerUser(app)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  await makeStaff(db, admin.userId, 'super_admin');
  await makeStaff(db, content.userId, 'content_admin');
  await makeStaff(db, ops.userId, 'operations_admin');
  const [store] = await db.insert(s.stores).values({ slug: storeSlug, name: 'Search test', vertical: 'perfume', status: 'active', defaultLocale: 'fr', defaultCurrency: 'DZD' }).returning();
  storeId = store!.id;
  await db.insert(s.storeLocales).values(['ar', 'fr', 'en'].map((locale) => ({ storeId, locale })));
  await db.insert(s.storeCurrencies).values({ storeId, currency: 'DZD' });
  await db.insert(s.storeCountries).values({ storeId, country: 'DZ' });
  await db.insert(s.brands).values([
    { storeId, slug: 'maison-sahara', name: 'Maison Sahara' },
    { storeId, slug: 'atlas', name: 'Atlas Parfums' },
  ]);
  const [parent] = await db.insert(s.categories).values({ storeId, slug: 'parfums' }).returning();
  const [oriental] = await db.insert(s.categories).values({ storeId, slug: 'orientaux', parentId: parent!.id }).returning();
  const [floral] = await db.insert(s.categories).values({ storeId, slug: 'floraux', parentId: parent!.id }).returning();
  await db.insert(s.categoryTranslations).values([
    { categoryId: parent!.id, locale: 'fr', name: 'Parfums' },
    { categoryId: parent!.id, locale: 'ar', name: 'العطور' },
    { categoryId: oriental!.id, locale: 'fr', name: 'Orientaux' },
    { categoryId: oriental!.id, locale: 'ar', name: 'شرقية' },
    { categoryId: floral!.id, locale: 'fr', name: 'Floraux' },
    { categoryId: floral!.id, locale: 'en', name: 'Florals' },
  ]);

  merchantA = await newMerchant(ownerA, 'Boutique Alger');
  merchantB = await newMerchant(ownerB, 'Oran Senteurs');
  await product(ownerA, merchantA.id, 'oud', {
    names: { ar: 'عُودٌ مَلَكِي', fr: 'Oud Impérial', en: 'Imperial Oud' },
    description: { fr: 'Bois précieux et ambre, sillage intense.', en: 'Precious woods and amber.' },
    categories: ['orientaux'],
    brand: 'maison-sahara',
    gender: 'men',
    price: 9500,
  });
  await product(ownerA, merchantA.id, 'jasmin', {
    names: { ar: 'زهرة الياسمين', fr: 'Fleur de Jasmin', en: 'Jasmine Flower' },
    categories: ['floraux'],
    brand: 'atlas',
    gender: 'women',
    price: 6900,
    concentration: 'EDT',
  });
  await product(ownerB, merchantB.id, 'musc', {
    names: { ar: 'مسك أبيض', fr: 'Musc Blanc', en: 'White Musk' },
    categories: ['orientaux'],
    brand: 'atlas',
    gender: 'women',
    price: 4500,
    stock: 0,
  });
  await product(ownerB, merchantB.id, 'ambre', { names: { fr: 'Ambre Nomade', ar: 'عنبر الرحالة' }, categories: ['orientaux'], gender: 'unisex', price: 12000 });
  await product(ownerA, merchantA.id, 'draft', { names: { fr: 'Oud Brouillon' }, status: 'draft', price: 1000 });
  await product(ownerA, merchantA.id, 'nooffer', { names: { fr: 'Oud Sans Vendeur' } });
  await index();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('text normalisation', () => {
  it('makes the same word match however it is written', () => {
    expect(normalizeText('العُطُور')).toBe('عطور');
    expect(normalizeText('أُود إمارات آمن')).toBe('اود امارات امن');
    expect(normalizeText('زهرة')).toBe('زهره');
    expect(normalizeText('بالعود للرجال')).toBe('عود رجال');
    expect(normalizeText('عطــــر ٨٠٠٠')).toBe('عطر 8000');
    expect(normalizeText('Boisé Œillet')).toBe('boise oeillet');
    expect(queryWords('un parfum pour la fête')).toEqual(['parfum', 'fete']);
  });

  it('understands prices, gender, rating, stock and sorting in three languages', async () => {
    const r = (q: string) => rulesInterpreter.interpret(q, { locale: 'ar', currency: 'DZD' });
    expect(await r('عطر رجالي أقل من 8000 دج')).toMatchObject({ text: 'عطر', priceMax: 8000, gender: 'men' });
    expect(await r('parfum femme entre 5 000 et 9 000 DA')).toMatchObject({ text: 'parfum', priceMin: 5000, priceMax: 9000, gender: 'women' });
    expect(await r('cheapest unisex perfume in stock')).toMatchObject({ text: 'perfume', sort: 'price_asc', gender: 'unisex', inStock: true });
    expect(await r('oud 4 étoiles et plus')).toMatchObject({ text: 'oud', ratingMin: 4 });
    expect(await r('عود أقل من 9 آلاف')).toMatchObject({ text: 'عود', priceMax: 9000 });
    expect(await r('Bois Marin')).toMatchObject({ text: 'bois marin', understood: [] });
  });
});

describe('index', () => {
  it('shows only sellable products: active, with an offer from an active, verified merchant', async () => {
    const all = await find({ pageSize: 48 });
    expect(slugs(all).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^oud-/), expect.stringMatching(/^jasmin-/), expect.stringMatching(/^musc-/), expect.stringMatching(/^ambre-/)]));
    expect(all.meta.total).toBe(4); // no draft, no product without a seller
  });

  it('follows changes within the indexing run: price, block, suspended merchant', async () => {
    // A product taken off sale disappears.
    await call('POST', `/v1/admin/products/${products.ambre}/block`, admin.token, { reason: 'Contrôle de conformité' });
    await index();
    expect(slugs(await find({ q: 'nomade' }))).toEqual([]); // 'ambre' would still find oud (amber in its description)
    await call('POST', `/v1/admin/products/${products.ambre}/unblock`, admin.token, { reason: 'Conforme' });
    // A suspended merchant's products disappear.
    await call('POST', `/v1/admin/merchants/${merchantB.id}/suspend`, admin.token, { reason: 'Contrôle' });
    await index();
    expect((await find({})).meta.total).toBe(2);
    await call('POST', `/v1/admin/merchants/${merchantB.id}/unsuspend`, admin.token);
    await index();
    expect((await find({})).meta.total).toBe(4);
  });
});

describe('languages, synonyms and typos', () => {
  it('finds a product by its Arabic, French or English name, with or without diacritics, accents, article', async () => {
    for (const q of ['عود', 'العود', 'عُود', 'oud imperial', 'Oud Impérial', 'imperial oud', 'ملكي']) {
      expect(slugs(await find({ q })), q).toEqual([expect.stringMatching(/^oud-/)]);
    }
    // Stems: plural in French, prefix while typing.
    expect(slugs(await find({ q: 'fleurs' }))).toEqual([expect.stringMatching(/^jasmin-/)]);
    expect(slugs(await find({ q: 'jasm' }))).toEqual([expect.stringMatching(/^jasmin-/)]);
    // Brand and category names are searchable too.
    expect((await find({ q: 'atlas' })).meta.total).toBe(2);
    expect((await find({ q: 'شرقية' })).meta.total).toBe(3);
  });

  it('synonyms across languages: an Arabic word finds French names, and ARUMA can add its own', async () => {
    expect(slugs(await find({ q: 'مسك' }))).toEqual([expect.stringMatching(/^musc-/)]); // starter synonym مسك = musc = musk
    expect(slugs(await find({ q: 'agarwood' }))).toEqual([expect.stringMatching(/^oud-/)]);
    expect((await find({ q: 'nomade' })).meta.total).toBe(1);
    expect((await find({ q: 'bedouin' })).meta.total).toBe(0);
    expect((await call('POST', '/v1/admin/search/synonyms', ops.token, { terms: ['bedouin', 'nomade'] })).statusCode).toBe(403);
    const added = await call('POST', '/v1/admin/search/synonyms', content.token, { storeId, terms: ['bedouin', 'nomade', 'رحالة'] });
    expect(added.statusCode).toBe(201);
    expect(slugs(await find({ q: 'bedouin' }))).toEqual([expect.stringMatching(/^ambre-/)]);
    expect((await call('POST', '/v1/admin/search/synonyms', content.token, { terms: ['two words', 'x'] })).statusCode).toBe(400);
    expect((await call('DELETE', `/v1/admin/search/synonyms/${added.json().data.id}`, content.token)).statusCode).toBe(204);
    expect((await find({ q: 'bedouin' })).meta.total).toBe(0);
  });

  it('corrects typos: shows the results for the closest word and says so', async () => {
    const r = await find({ q: 'jasmn' });
    expect(r.query).toMatchObject({ correctedFrom: 'jasmn', words: ['jasmin'] });
    expect(slugs(r)).toEqual([expect.stringMatching(/^jasmin-/)]);
    const ar = await find({ q: 'ياسمن' });
    expect(slugs(ar)).toEqual([expect.stringMatching(/^jasmin-/)]);
    expect((await find({ q: 'xqzv' })).meta.total).toBe(0);
  });
});

describe('filters, facets and sorting', () => {
  it('filters by brand, category (with its sub-categories), merchant, price, stock, gender and rating', async () => {
    expect((await find({ brand: 'atlas' })).meta.total).toBe(2);
    expect((await find({ category: 'parfums' })).meta.total).toBe(4); // parent category includes its children
    expect((await find({ category: 'floraux' })).meta.total).toBe(1);
    expect((await find({ merchant: merchantB.slug })).meta.total).toBe(2);
    expect(slugs(await find({ priceMin: 6000, priceMax: 10000, sort: 'price_asc' }))).toEqual([expect.stringMatching(/^jasmin-/), expect.stringMatching(/^oud-/)]);
    expect((await find({ inStock: true })).meta.total).toBe(3);
    expect((await find({ gender: 'women' })).meta.total).toBe(2);
    await db.update(s.searchDocuments).set({ ratingAvg: 4.5, ratingCount: 12 }).where(eq(s.searchDocuments.productId, products.jasmin!));
    expect(slugs(await find({ ratingMin: 4 }))).toEqual([expect.stringMatching(/^jasmin-/)]);
    expect((await find({ brand: 'atlas', gender: 'women', inStock: true })).meta.total).toBe(1);
    expect((await find({ category: 'unknown-category' })).meta.total).toBe(0);
  });

  it('returns facets for the matched products', async () => {
    const r = await find({ q: 'parfum', locale: 'fr' });
    expect(r.facets.brands).toEqual(expect.arrayContaining([{ slug: 'atlas', name: 'Atlas Parfums', count: 2 }, { slug: 'maison-sahara', name: 'Maison Sahara', count: 1 }]));
    expect(r.facets.categories).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'orientaux', name: 'Orientaux', count: 3 }), expect.objectContaining({ slug: 'parfums', count: 4 })]));
    expect(r.facets.merchants).toEqual(expect.arrayContaining([expect.objectContaining({ slug: merchantA.slug, count: 2 })]));
    expect(r.facets.price).toEqual({ minMinor: 450000, maxMinor: 1200000 });
    expect(r.facets.gender).toEqual(expect.arrayContaining([{ value: 'women', count: 2 }]));
  });

  it('sorts by price, rating, newest and popularity', async () => {
    const prices = (await find({ sort: 'price_desc' })).results.map((r: any) => r.priceFrom.amountMinor);
    expect(prices).toEqual([...prices].sort((a: number, b: number) => b - a));
    expect(slugs(await find({ sort: 'rating' }))[0]).toMatch(/^jasmin-/);
    expect(slugs(await find({ sort: 'newest' }))[0]).toMatch(/^ambre-/);
    await db.update(s.searchDocuments).set({ popularity: 50 }).where(eq(s.searchDocuments.productId, products.musc!));
    expect(slugs(await find({}))[0]).toMatch(/^musc-/); // no words: best sellers first
  });

  it('natural language: "parfum femme moins de 5000 DA" filters by itself; explicit filters win', async () => {
    const r = await find({ q: 'parfum femme moins de 5000 DA', locale: 'fr' });
    expect(r.query.understood.map((u: any) => u.kind).sort()).toEqual(['gender', 'price_max']);
    expect(slugs(r)).toEqual([expect.stringMatching(/^musc-/)]);
    expect((await find({ q: 'عطر رجالي أقل من 10000 دج', locale: 'ar' })).results.map((x: any) => x.name)).toEqual(['عُودٌ مَلَكِي']);
    expect((await find({ q: 'parfum femme moins de 5000 DA', priceMax: 8000 })).meta.total).toBe(2);
    expect((await find({ q: 'parfum femme moins de 5000 DA', understand: false })).meta.total).toBe(0); // the words themselves match nothing
    // Voice: the same, recorded as voice.
    await find({ q: 'عطر نسائي متوفر', source: 'voice', locale: 'ar' });
    const [voice] = await db.select().from(s.searchQueries).where(sql`${s.searchQueries.storeId} = ${storeId} and ${s.searchQueries.source} = 'voice'`);
    expect(voice).toMatchObject({ query: 'عطر نسايي متوفر', results: 1 });
  });

  it('shows names in the shopper language and prices in minor units with the formatted amount', async () => {
    const [oud] = (await find({ q: 'oud', locale: 'en' })).results;
    expect(oud).toMatchObject({ name: 'Imperial Oud', brand: 'Maison Sahara', priceFrom: { currency: 'DZD', amountMinor: 950000, amount: '9500.00' }, inStock: true, sellers: 1 });
    expect((await find({ q: 'oud', locale: 'ar' })).results[0].name).toBe('عُودٌ مَلَكِي');
  });
});

describe('autocomplete and statistics', () => {
  it('suggests completions, products, brands, categories and popular searches as one types', async () => {
    const sug = async (q: string, locale = 'fr') => (await app.inject({ method: 'GET', url: `/v1/stores/${storeSlug}/search/suggest`, query: { q, locale } })).json().data;
    const ja = await sug('jas');
    expect(ja.completions).toContain('jasmin');
    expect(ja.products).toEqual([expect.objectContaining({ name: 'Fleur de Jasmin' })]);
    expect((await sug('atl')).brands).toEqual([{ slug: 'atlas', name: 'Atlas Parfums' }]);
    expect((await sug('flor', 'en')).categories).toEqual([{ slug: 'floraux', name: 'Florals' }]);
    expect((await sug('عو', 'ar')).products[0].name).toBe('عُودٌ مَلَكِي');
    expect((await sug('jasmn')).completions).toContain('jasmin'); // typo while typing
    expect((await sug('ja')).queries).toContain('jasmin'); // popular searches (the corrected "jasmn" is remembered as "jasmin")
    expect((await sug('')).queries.length).toBeGreaterThan(0);
  });

  it('ARUMA sees what is searched and what finds nothing; only search staff manage it', async () => {
    await find({ q: 'vetiver introuvable' });
    const stats = (await call('GET', `/v1/admin/search/analytics?storeId=${storeId}&days=7`, ops.token)).json().data;
    expect(stats.totals.searches).toBeGreaterThan(10);
    expect(stats.totals.voice).toBe(1);
    expect(stats.zeroResults.map((z: any) => z.query)).toContain('vetiver introuvable');
    expect((await call('GET', '/v1/admin/search/status', content.token)).json().data).toMatchObject({ documents: expect.any(Number) });
    expect((await call('POST', '/v1/admin/search/reindex', ops.token, { storeId })).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/search/reindex', content.token, { storeId })).json().data.queued).toBe(6);
    await index();
    expect((await call('GET', '/v1/admin/search/analytics', ownerA.token)).statusCode).toBe(403);
  });

  it('treats hostile text as words', async () => {
    for (const q of ["oud' OR 1=1 --", 'oud:* | !', '<script>', "'; DROP TABLE search_documents; --", '&&&|||!!!(())']) {
      expect((await app.inject({ method: 'GET', url: `/v1/stores/${storeSlug}/search`, query: { q } })).statusCode, q).toBe(200);
    }
    expect((await find({})).meta.total).toBe(4);
  });
});
