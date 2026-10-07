/**
 * Search: words in Arabic, French or English (with synonyms across the three), typo correction,
 * filters (brand, category with its sub-categories, merchant, price, rating, stock, gender,
 * concentration), facets, sorting, autocomplete. Only sellable products of the store are returned.
 */
import { and, asc, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { StoreContext } from '../stores/index.js';
import { rulesInterpreter, type Interpretation, type QueryInterpreter, type SortKey } from './interpret.js';
import { isArabic, normalizeText, queryWords } from './normalize.js';

export type SearchInput = {
  q?: string;
  locale: string;
  currency: { code: string; minorUnits: number };
  brands?: string[];
  categories?: string[];
  merchants?: string[];
  priceMin?: number; // major units
  priceMax?: number;
  ratingMin?: number;
  inStock?: boolean;
  gender?: string;
  concentration?: string;
  sort?: SortKey;
  page: number;
  pageSize: number;
  /** typed | voice: voice queries are spoken sentences, interpreted the same way. */
  source?: 'typed' | 'voice';
  /** Understand prices, gender, sorting… written in the query (default on). */
  understand?: boolean;
  /** Record the query in the search statistics (default on; off for searches made by the AI assistant). */
  log?: boolean;
};

const d = s.searchDocuments;
const uuidArray = (ids: string[]) => sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]`;

// --- Synonyms (cached a minute per store; cleared when ARUMA edits them) --------------------------------
const synonymCache = new Map<string, { at: number; map: Map<string, string[]> }>();
export const clearSynonymCache = () => synonymCache.clear();

async function synonymsOf(db: Database, storeId: string) {
  const hit = synonymCache.get(storeId);
  if (hit && Date.now() - hit.at < 60_000) return hit.map;
  const groups = await db.select({ terms: s.searchSynonyms.terms }).from(s.searchSynonyms).where(or(isNull(s.searchSynonyms.storeId), eq(s.searchSynonyms.storeId, storeId)));
  const map = new Map<string, string[]>();
  for (const g of groups) {
    const terms = [...new Set(g.terms.map(normalizeText).filter((t) => t && !t.includes(' ')))];
    for (const t of terms) map.set(t, [...new Set([...(map.get(t) ?? []), ...terms])]);
  }
  synonymCache.set(storeId, { at: Date.now(), map });
  return map;
}

function expand(word: string, synonyms: Map<string, string[]>) {
  // Arabic: also try without the feminine ending (عطريه → عطري).
  const found = synonyms.get(word) ?? (isArabic(word) && word.endsWith('ه') ? synonyms.get(word.slice(0, -1)) : undefined);
  return [...new Set([word, ...(found ?? [])])];
}

/** One word matches its prefix, its stem in each language, or any synonym. */
function tsQuery(words: string[], synonyms: Map<string, string[]>) {
  const alt = (a: string) => sql`(to_tsquery('simple', ${`${a}:*`}) || plainto_tsquery('arabic', ${a}) || plainto_tsquery('french', ${a}) || plainto_tsquery('english', ${a}))`;
  return sql.join(words.map((w) => sql`(${sql.join(expand(w, synonyms).map(alt), sql` || `)})`), sql` && `);
}

// --- Filters ---------------------------------------------------------------------------------------------

async function idsBySlug(db: Database, table: 'categories' | 'merchants', storeId: string, slugs: string[]) {
  if (table === 'categories') {
    return (await db.select({ id: s.categories.id, slug: s.categories.slug }).from(s.categories).where(and(eq(s.categories.storeId, storeId), sql`${s.categories.slug} in ${slugs}`))).map((r) => r.id);
  }
  return (await db.select({ id: s.merchants.id }).from(s.merchants).where(sql`${s.merchants.slug} in ${slugs}`)).map((r) => r.id);
}

type Resolved = { where: SQL[]; price: SQL };
async function filters(db: Database, store: StoreContext, input: SearchInput, nl: Interpretation): Promise<Resolved> {
  const cur = input.currency.code;
  const price = sql`(${d.minPrices}->>${cur})::bigint`;
  const toMinor = (v: number) => Math.round(v * 10 ** input.currency.minorUnits);
  const where: SQL[] = [eq(d.storeId, store.id), eq(d.visible, true), sql`${d.minPrices} ? ${cur}`];
  if (input.brands?.length) where.push(sql`${d.brandSlug} in ${input.brands}`);
  if (input.categories?.length) {
    const ids = await idsBySlug(db, 'categories', store.id, input.categories);
    where.push(ids.length ? sql`${d.categoryIds} && ${uuidArray(ids)}` : sql`false`);
  }
  if (input.merchants?.length) {
    const ids = await idsBySlug(db, 'merchants', store.id, input.merchants);
    where.push(ids.length ? sql`${d.merchantIds} && ${uuidArray(ids)}` : sql`false`);
  }
  const priceMin = input.priceMin ?? nl.priceMin;
  const priceMax = input.priceMax ?? nl.priceMax;
  if (priceMin !== undefined) where.push(sql`${price} >= ${toMinor(priceMin)}`);
  if (priceMax !== undefined) where.push(sql`${price} <= ${toMinor(priceMax)}`);
  const ratingMin = input.ratingMin ?? nl.ratingMin;
  if (ratingMin !== undefined) where.push(sql`${d.ratingAvg} >= ${ratingMin}`);
  if (input.inStock ?? nl.inStock) where.push(eq(d.inStock, true));
  const gender = input.gender ?? nl.gender;
  if (gender) where.push(sql`${d.attributes}->>'gender' = ${normalizeText(gender)}`);
  const concentration = input.concentration ?? nl.concentration;
  if (concentration) where.push(sql`${d.attributes}->>'concentration' = ${normalizeText(concentration)}`);
  return { where, price };
}

const nameIn = (names: Record<string, string>, locale: string, fallback: string) => names[locale] ?? names[fallback] ?? Object.values(names)[0] ?? '';

// --- Search ----------------------------------------------------------------------------------------------

async function run(db: Database, store: StoreContext, input: SearchInput, words: string[], nl: Interpretation, synonyms: Map<string, string[]>) {
  const { where, price } = await filters(db, store, input, nl);
  const tsq = words.length ? tsQuery(words, synonyms) : null;
  if (tsq) where.push(sql`${d.tsv} @@ (${tsq})`);
  const all = and(...where);
  const sort: SortKey = input.sort ?? nl.sort ?? (words.length ? 'relevance' : 'popular');
  const score = tsq
    ? sql`ts_rank_cd(${d.tsv}, (${tsq}), 32) + 0.3 * similarity(${d.nameNorm}, ${words.join(' ')}) + 0.02 * ln(1 + ${d.popularity})`
    : sql`ln(1 + ${d.popularity})`;
  const order: Record<SortKey, SQL[]> = {
    relevance: [sql`${score} desc`, desc(d.popularity)],
    price_asc: [sql`${price} asc`],
    price_desc: [sql`${price} desc`],
    rating: [sql`${d.ratingAvg} desc nulls last`, desc(d.ratingCount)],
    newest: [desc(d.publishedAt)],
    popular: [desc(d.popularity), sql`${d.ratingAvg} desc nulls last`],
  };
  const [rows, [{ total }]] = [
    await db
      .select({ doc: d, price: sql<string>`${price}::text` })
      .from(d)
      .where(all)
      .orderBy(...order[sort], asc(d.slug))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    (await db.select({ total: sql<number>`count(*)::int` }).from(d).where(all)) as [{ total: number }],
  ];
  return { rows, total, sort, all, price };
}

async function facets(db: Database, store: StoreContext, all: SQL | undefined, price: SQL, locale: string) {
  const [brands, categories, merchants, range, ratings, genders] = [
    await db
      .select({ slug: d.brandSlug, name: d.brandName, count: sql<number>`count(*)::int` })
      .from(d)
      .where(and(all, sql`${d.brandSlug} is not null`))
      .groupBy(d.brandSlug, d.brandName)
      .orderBy(desc(sql`count(*)`))
      .limit(30),
    await db.execute<{ slug: string; names: Record<string, string> | null; count: number }>(sql`
      select c.slug, (select jsonb_object_agg(t.locale, t.name) from category_translations t where t.category_id = c.id) as names, count(*)::int as count
      from search_documents, unnest(category_ids) as cid join categories c on c.id = cid
      where ${all} group by c.id, c.slug order by count desc limit 30`),
    await db.execute<{ slug: string; name: string; count: number }>(sql`
      select m.slug, m.name, count(*)::int as count
      from search_documents, unnest(merchant_ids) as mid join merchants m on m.id = mid
      where ${all} group by m.id order by count desc limit 30`),
    await db.select({ min: sql<string | null>`min(${price})::text`, max: sql<string | null>`max(${price})::text` }).from(d).where(all),
    await db
      .select({ four: sql<number>`count(*) filter (where ${d.ratingAvg} >= 4)::int`, three: sql<number>`count(*) filter (where ${d.ratingAvg} >= 3)::int` })
      .from(d)
      .where(all),
    await db
      .select({ value: sql<string>`${d.attributes}->>'gender'`, count: sql<number>`count(*)::int` })
      .from(d)
      .where(and(all, sql`${d.attributes} ? 'gender'`))
      .groupBy(sql`${d.attributes}->>'gender'`),
  ];
  return {
    brands: brands.map((b) => ({ slug: b.slug!, name: b.name!, count: b.count })),
    categories: categories.rows.map((c) => ({ slug: c.slug, name: nameIn(c.names ?? {}, locale, store.defaultLocale) || c.slug, count: c.count })),
    merchants: merchants.rows,
    price: { minMinor: range[0]?.min ? Number(range[0].min) : null, maxMinor: range[0]?.max ? Number(range[0].max) : null },
    rating: { atLeast4: ratings[0]?.four ?? 0, atLeast3: ratings[0]?.three ?? 0 },
    gender: genders.map((g) => ({ value: g.value, count: g.count })),
  };
}

/** For words that match nothing, the closest word of the store's vocabulary (trigram similarity). */
async function corrections(db: Database, storeId: string, words: string[], synonyms: Map<string, string[]>) {
  const out: string[] = [];
  let changed = false;
  for (const w of words) {
    const [known] = await db.select({ t: s.searchTerms.term }).from(s.searchTerms).where(and(eq(s.searchTerms.storeId, storeId), eq(s.searchTerms.term, w)));
    if (known || synonyms.has(w) || /^\d+$/.test(w)) {
      out.push(w);
      continue;
    }
    const [best] = await db
      .select({ term: s.searchTerms.term })
      .from(s.searchTerms)
      .where(and(eq(s.searchTerms.storeId, storeId), sql`similarity(${s.searchTerms.term}, ${w}) > 0.25`))
      .orderBy(desc(sql`similarity(${s.searchTerms.term}, ${w})`), desc(s.searchTerms.docs))
      .limit(1);
    out.push(best?.term ?? w);
    changed ||= Boolean(best);
  }
  return changed ? out : null;
}

export async function search(db: Database, store: StoreContext, input: SearchInput, interpreter: QueryInterpreter = rulesInterpreter) {
  const raw = (input.q ?? '').trim().slice(0, 200);
  const nl: Interpretation = input.understand === false || !raw ? { text: raw, understood: [] } : await interpreter.interpret(raw, { locale: input.locale, currency: input.currency.code });
  const synonyms = await synonymsOf(db, store.id);
  let words = queryWords(nl.text);
  let result = await run(db, store, input, words, nl, synonyms);
  let correctedFrom: string | null = null;
  let suggestion: string | null = null;
  if (words.length) {
    const fixed = await corrections(db, store.id, words, synonyms);
    if (fixed && result.total === 0) {
      // Nothing found: search the corrected words and say so ("Showing results for …").
      const retry = await run(db, store, input, fixed, nl, synonyms);
      if (retry.total > 0) {
        correctedFrom = words.join(' ');
        words = fixed;
        result = retry;
      }
    } else if (fixed && result.total < 3) {
      // Few results: offer the correction only if it finds more ("Did you mean …?").
      const other = await run(db, store, { ...input, page: 1, pageSize: 1 }, fixed, nl, synonyms);
      if (other.total > result.total) suggestion = fixed.join(' ');
    }
  }
  if (raw && input.page === 1 && input.log !== false) {
    // A corrected query is remembered corrected, so popular suggestions never repeat a typo.
    const logged = correctedFrom ? normalizeText(raw).replace(correctedFrom, words.join(' ')) : normalizeText(raw);
    await db.insert(s.searchQueries).values({ storeId: store.id, query: logged.slice(0, 200), locale: input.locale, results: result.total, source: input.source ?? 'typed' });
  }
  return {
    query: {
      text: raw,
      words,
      correctedFrom,
      suggestion,
      understood: nl.understood,
      sort: result.sort,
    },
    results: result.rows.map(({ doc, price }) => toCard(doc, price, store, input)),
    facets: await facets(db, store, result.all, result.price, input.locale),
    meta: { total: result.total, page: input.page, pageSize: input.pageSize, totalPages: Math.ceil(result.total / input.pageSize), locale: input.locale, currency: input.currency.code },
  };
}

type Doc = typeof s.searchDocuments.$inferSelect;
function toCard(doc: Doc, price: string, store: StoreContext, input: Pick<SearchInput, 'locale' | 'currency'>) {
  const minorUnits = input.currency.minorUnits;
  return {
    id: doc.productId,
    slug: doc.slug,
    name: nameIn(doc.names, input.locale, store.defaultLocale),
    brand: doc.brandName,
    image: doc.image,
    priceFrom: { currency: input.currency.code, amountMinor: Number(price), amount: (Number(price) / 10 ** minorUnits).toFixed(minorUnits) },
    rating: { average: doc.ratingAvg, count: doc.ratingCount },
    inStock: doc.inStock,
    sellers: doc.merchantIds.length,
    attributes: doc.attributes,
  };
}
export type ProductCard = ReturnType<typeof toCard>;

/**
 * Product cards (as in search results) for the given products, in the given order, leaving out what a
 * customer cannot buy now (hidden, or no price in the currency). Used by recommendations and the assistant.
 */
export async function productCards(db: Database, store: StoreContext, productIds: string[], input: Pick<SearchInput, 'locale' | 'currency'>): Promise<ProductCard[]> {
  if (productIds.length === 0) return [];
  const price = sql`(${d.minPrices}->>${input.currency.code})::bigint`;
  const rows = await db
    .select({ doc: d, price: sql<string>`${price}::text` })
    .from(d)
    .where(and(eq(d.storeId, store.id), eq(d.visible, true), sql`${price} is not null`, sql`${d.productId} = any(${uuidArray(productIds)})`));
  const byId = new Map(rows.map((r) => [r.doc.productId, toCard(r.doc, r.price, store, input)]));
  return productIds.map((id) => byId.get(id)).filter((c): c is ProductCard => Boolean(c));
}

// --- Autocomplete --------------------------------------------------------------------------------------

export async function suggest(db: Database, store: StoreContext, q: string, locale: string) {
  const norm = normalizeText(q.slice(0, 100));
  const words = norm.split(' ').filter(Boolean);
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const popular = await db
    .select({ query: s.searchQueries.query, n: sql<number>`count(*)::int` })
    .from(s.searchQueries)
    .where(and(eq(s.searchQueries.storeId, store.id), gt(s.searchQueries.results, 0), gt(s.searchQueries.createdAt, since), norm ? sql`${s.searchQueries.query} like ${`${norm}%`}` : undefined))
    .groupBy(s.searchQueries.query)
    .orderBy(desc(sql`count(*)`))
    .limit(5);
  if (!words.length) return { queries: popular.map((p) => p.query), completions: [], products: [], brands: [], categories: [] };

  const last = words[words.length - 1]!;
  const head = words.slice(0, -1);
  const prefixQuery = sql.join(words.map((w) => sql`to_tsquery('simple', ${`${w}:*`})`), sql` && `);
  let terms = await db
    .select({ term: s.searchTerms.term })
    .from(s.searchTerms)
    .where(and(eq(s.searchTerms.storeId, store.id), sql`${s.searchTerms.term} like ${`${last}%`}`))
    .orderBy(desc(s.searchTerms.docs), asc(s.searchTerms.term))
    .limit(6);
  if (!terms.length && last.length >= 3) {
    // A typo while typing: the closest words.
    terms = await db
      .select({ term: s.searchTerms.term })
      .from(s.searchTerms)
      .where(and(eq(s.searchTerms.storeId, store.id), sql`similarity(${s.searchTerms.term}, ${last}) > 0.3`))
      .orderBy(desc(sql`similarity(${s.searchTerms.term}, ${last})`))
      .limit(4);
  }
  const visible = and(eq(d.storeId, store.id), eq(d.visible, true));
  const products = await db
    .select({ slug: d.slug, names: d.names, image: d.image })
    .from(d)
    .where(and(visible, sql`${d.tsv} @@ (${prefixQuery})`))
    .orderBy(desc(d.popularity), sql`${d.ratingAvg} desc nulls last`)
    .limit(5);
  const brands = await db
    .selectDistinct({ slug: d.brandSlug, name: d.brandName })
    .from(d)
    .where(and(visible, sql`${d.brandName} is not null`))
    .limit(200);
  const categories = await db.execute<{ slug: string; names: Record<string, string> }>(sql`
    select c.slug, jsonb_object_agg(t.locale, t.name) as names from categories c join category_translations t on t.category_id = c.id
    where c.store_id = ${store.id} and c.status = 'active' group by c.slug`);
  const startsWith = (text: string) => normalizeText(text).split(' ').some((w) => w.startsWith(last)) || normalizeText(text).startsWith(norm);
  return {
    queries: popular.map((p) => p.query),
    completions: terms.map((t) => [...head, t.term].join(' ')),
    products: products.map((p) => ({ slug: p.slug, name: nameIn(p.names, locale, store.defaultLocale), image: p.image })),
    brands: brands.filter((b) => b.name && startsWith(b.name)).slice(0, 5).map((b) => ({ slug: b.slug!, name: b.name! })),
    categories: categories.rows
      .filter((c) => Object.values(c.names).some(startsWith))
      .slice(0, 5)
      .map((c) => ({ slug: c.slug, name: nameIn(c.names, locale, store.defaultLocale) })),
  };
}

// --- ARUMA: synonyms and analytics -------------------------------------------------------------------

export async function searchAnalytics(db: Database, storeId: string | undefined, days: number) {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const scope = and(gt(s.searchQueries.createdAt, since), storeId ? eq(s.searchQueries.storeId, storeId) : undefined);
  const [totals] = await db
    .select({
      searches: sql<number>`count(*)::int`,
      zero: sql<number>`count(*) filter (where ${s.searchQueries.results} = 0)::int`,
      voice: sql<number>`count(*) filter (where ${s.searchQueries.source} = 'voice')::int`,
    })
    .from(s.searchQueries)
    .where(scope);
  const top = (zeroOnly: boolean) =>
    db
      .select({ query: s.searchQueries.query, count: sql<number>`count(*)::int`, lastResults: sql<number>`(array_agg(${s.searchQueries.results} order by ${s.searchQueries.createdAt} desc))[1]` })
      .from(s.searchQueries)
      .where(and(scope, zeroOnly ? eq(s.searchQueries.results, 0) : undefined))
      .groupBy(s.searchQueries.query)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
  return { since, totals: totals ?? { searches: 0, zero: 0, voice: 0 }, topQueries: await top(false), zeroResults: await top(true) };
}

/** Search history is kept 180 days (statistics only, no personal data). */
export async function purgeOldQueries(db: Database) {
  await db.delete(s.searchQueries).where(sql`${s.searchQueries.createdAt} < now() - interval '180 days'`);
}
