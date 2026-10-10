/**
 * Builds search documents. Triggers put changed products in search_queue; `processSearchQueue` (a
 * background job, every few seconds) rebuilds them. `queueAllProducts` re-indexes everything (daily, for
 * popularity, or after a change of the rules).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { normalizeText, STOPWORDS } from './normalize.js';

const POPULARITY_DAYS = 90;
/** Product attributes that become searchable words and filters. */
export const ATTRIBUTE_FACETS = ['gender', 'concentration'] as const;

const flatten = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? Object.values(value).flatMap(flatten) : [];

/** Rebuilds the documents of these products (inside the caller's transaction). */
export async function indexProducts(db: Executor, productIds: string[]) {
  if (!productIds.length) return { indexed: 0, stores: [] as string[] };
  const products = await db
    .select({ product: s.products, storeStatus: s.stores.status, brandSlug: s.brands.slug, brandName: s.brands.name })
    .from(s.products)
    .innerJoin(s.stores, eq(s.stores.id, s.products.storeId))
    .leftJoin(s.brands, eq(s.brands.id, s.products.brandId))
    .where(inArray(s.products.id, productIds));
  if (!products.length) return { indexed: 0, stores: [] };
  const ids = products.map((p) => p.product.id);

  const [translations, categoryRows, offers, ratings, sales, images] = [
    await db.select().from(s.productTranslations).where(inArray(s.productTranslations.productId, ids)),
    // The product's categories with all their parents, and their names.
    await db.execute<{ product_id: string; category_id: string; names: Record<string, string> | null }>(sql`
      with recursive tree as (
        select pc.product_id, c.id, c.parent_id from product_categories pc join categories c on c.id = pc.category_id
        where pc.product_id in ${ids} and c.status = 'active'
        union
        select t.product_id, c.id, c.parent_id from tree t join categories c on c.id = t.parent_id where c.status = 'active'
      )
      select t.product_id, t.id as category_id, (select jsonb_object_agg(ct.locale, ct.name) from category_translations ct where ct.category_id = t.id) as names
      from tree t`),
    // Sellable offers: active, from an active and verified merchant allowed in the store (same rule as the catalog).
    await db
      .select({ productId: s.productVariants.productId, merchantId: s.offers.merchantId, available: s.offers.availableQuantity, currency: s.offerPrices.currency, amountMinor: s.offerPrices.amountMinor })
      .from(s.offers)
      .innerJoin(s.productVariants, and(eq(s.productVariants.id, s.offers.variantId), eq(s.productVariants.isActive, true)))
      .innerJoin(s.offerPrices, eq(s.offerPrices.offerId, s.offers.id))
      .innerJoin(s.merchants, eq(s.merchants.id, s.offers.merchantId))
      .innerJoin(s.storeMerchants, and(eq(s.storeMerchants.storeId, s.offers.storeId), eq(s.storeMerchants.merchantId, s.offers.merchantId)))
      .where(
        and(
          inArray(s.productVariants.productId, ids),
          eq(s.offers.status, 'active'),
          eq(s.merchants.status, 'active'),
          eq(s.merchants.verificationStatus, 'verified'),
          eq(s.storeMerchants.status, 'active'),
        ),
      ),
    await db
      .select({ productId: s.reviews.productId, avg: sql<string>`avg(${s.reviews.rating})::numeric(3,2)::text`, n: sql<number>`count(*)::int` })
      .from(s.reviews)
      .where(and(inArray(s.reviews.productId, ids), eq(s.reviews.type, 'product'), eq(s.reviews.status, 'published')))
      .groupBy(s.reviews.productId),
    await db.execute<{ product_id: string; units: number }>(sql`
      select v.product_id, sum(l.quantity)::int as units
      from order_lines l join orders o on o.id = l.order_id join product_variants v on v.id = l.variant_id
      where v.product_id in ${ids} and o.status <> 'cancelled' and o.placed_at > now() - make_interval(days => ${POPULARITY_DAYS})
      group by v.product_id`),
    await db.select().from(s.productImages).where(inArray(s.productImages.productId, ids)).orderBy(s.productImages.position),
  ];

  for (const { product: p, storeStatus, brandSlug, brandName } of products) {
    const names: Record<string, string> = {};
    const descriptions: Record<string, string> = {};
    for (const t of translations.filter((t) => t.productId === p.id)) {
      names[t.locale] = t.name;
      if (t.description) descriptions[t.locale] = t.description;
    }
    const categories = categoryRows.rows.filter((c) => c.product_id === p.id);
    const own = offers.filter((o) => o.productId === p.id);
    const minPrices: Record<string, number> = {};
    for (const o of own) minPrices[o.currency] = Math.min(minPrices[o.currency] ?? Number.MAX_SAFE_INTEGER, Number(o.amountMinor));
    const rating = ratings.find((r) => r.productId === p.id);
    const image = images.find((i) => i.productId === p.id);
    const visible = p.status === 'active' && !p.blockedAt && storeStatus === 'active' && own.length > 0;

    const categoryNames = categories.flatMap((c) => Object.values(c.names ?? {}));
    const attributeWords = [...ATTRIBUTE_FACETS.flatMap((k) => flatten(p.attributes[k])), ...flatten(p.attributes.notes)];
    const nameNorm = normalizeText([...Object.values(names), brandName ?? '', ...categoryNames].join(' '));
    const lang = (locale: string) => normalizeText(`${names[locale] ?? ''} ${descriptions[locale] ?? ''}`);
    const tsv = sql`
      setweight(to_tsvector('simple', ${normalizeText(Object.values(names).join(' '))}), 'A') ||
      setweight(to_tsvector('simple', ${normalizeText([brandName ?? '', ...categoryNames].join(' '))}), 'B') ||
      setweight(to_tsvector('simple', ${normalizeText([...Object.values(descriptions), ...attributeWords].join(' '))}), 'C') ||
      setweight(to_tsvector('arabic', ${lang('ar')}), 'B') ||
      setweight(to_tsvector('french', ${lang('fr')}), 'B') ||
      setweight(to_tsvector('english', ${lang('en')}), 'B')`;
    const row = {
      productId: p.id,
      storeId: p.storeId,
      visible,
      slug: p.slug,
      names,
      image: image ? { url: image.url, alt: image.alt } : null,
      brandId: p.brandId,
      brandSlug: brandSlug ?? null,
      brandName: brandName ?? null,
      categoryIds: [...new Set(categories.map((c) => c.category_id))],
      merchantIds: [...new Set(own.map((o) => o.merchantId))],
      attributes: Object.fromEntries(ATTRIBUTE_FACETS.filter((k) => typeof p.attributes[k] === 'string').map((k) => [k, normalizeText(String(p.attributes[k]))])),
      minPrices,
      inStock: own.some((o) => o.available > 0),
      ratingAvg: rating ? Number(rating.avg) : null,
      ratingCount: rating?.n ?? 0,
      popularity: sales.rows.find((r) => r.product_id === p.id)?.units ?? 0,
      nameNorm,
      tsv,
      publishedAt: p.createdAt,
      indexedAt: new Date(),
    };
    const { productId: _id, ...update } = row;
    await db.insert(s.searchDocuments).values(row).onConflictDoUpdate({ target: s.searchDocuments.productId, set: update });
  }
  return { indexed: products.length, stores: [...new Set(products.map((p) => p.product.storeId))] };
}

/** The vocabulary of a store (words of visible products), for typo correction and autocomplete. */
export async function rebuildTerms(db: Executor, storeId: string) {
  await db.delete(s.searchTerms).where(eq(s.searchTerms.storeId, storeId));
  await db.execute(sql`
    insert into search_terms (store_id, term, docs)
    select ${storeId}::uuid, w, count(distinct product_id)::int
    from search_documents, unnest(string_to_array(name_norm, ' ')) as w
    where store_id = ${storeId} and visible and length(w) between 2 and 96 and w not in ${[...STOPWORDS]}
    group by w`);
}

/** Takes up to `limit` queued products and rebuilds them (and the vocabulary of their stores). */
export async function processSearchQueue(db: Database, limit = 500) {
  return db.transaction(async (tx) => {
    const taken = await tx.execute<{ product_id: string }>(sql`
      delete from search_queue where product_id in (
        select product_id from search_queue order by queued_at limit ${limit} for update skip locked
      ) returning product_id`);
    const result = await indexProducts(tx, taken.rows.map((r) => r.product_id));
    for (const storeId of result.stores) await rebuildTerms(tx, storeId);
    return result.indexed;
  });
}

/** Re-indexes every product of a store (or all stores): popularity refresh, new rules, after a restore. */
export async function queueAllProducts(db: Executor, storeId?: string) {
  const res = await db.execute(sql`
    insert into search_queue (product_id) select id from products ${storeId ? sql`where store_id = ${storeId}` : sql``}
    on conflict do nothing`);
  return res.rowCount ?? 0;
}

export async function searchStatus(db: Database) {
  const [docs] = await db
    .select({ total: sql<number>`count(*)::int`, visible: sql<number>`count(*) filter (where ${s.searchDocuments.visible})::int`, lastIndexedAt: sql<string | null>`max(${s.searchDocuments.indexedAt})::text` })
    .from(s.searchDocuments);
  const [queue] = await db.select({ queued: sql<number>`count(*)::int` }).from(s.searchQueue);
  return { documents: docs?.total ?? 0, visible: docs?.visible ?? 0, lastIndexedAt: docs?.lastIndexedAt ?? null, queued: queue?.queued ?? 0 };
}

