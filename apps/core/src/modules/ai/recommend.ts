/**
 * Recommendations and bundles — statistics, no AI needed:
 * - similar: same categories, brand, gender and concentration, close in price, popular first;
 * - bought together: products bought in the same checkout (last 180 days, not cancelled), only when at
 *   least 2 different checkouts did it (one person's basket is never revealed);
 * - bundle: the product plus what is bought with it (or, without enough sales yet, a similar product of
 *   the same brand), with the total. No discount is invented: prices are the merchants' own.
 * Only products a customer can buy now are returned (search index: visible, priced in the currency).
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { productCards, type ProductCard } from '../search/index.js';
import type { StoreContext } from '../stores/index.js';

type View = { locale: string; currency: { code: string; minorUnits: number } };
const d = s.searchDocuments;
const uuids = (ids: string[]) => sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]`;

/** The product's search document (visible products only). */
export async function productDoc(db: Database, store: StoreContext, slug: string) {
  const [doc] = await db.select().from(d).where(and(eq(d.storeId, store.id), eq(d.slug, slug), eq(d.visible, true)));
  if (!doc) throw notFound('Product');
  return doc;
}

export async function similarProducts(db: Database, store: StoreContext, doc: typeof d.$inferSelect, view: View, limit = 8): Promise<ProductCard[]> {
  const price = sql`(${d.minPrices}->>${view.currency.code})::bigint`;
  const own = Number(doc.minPrices[view.currency.code] ?? 0);
  const attr = (k: string) => (doc.attributes as Record<string, unknown>)[k] ?? null;
  const shared = doc.categoryIds.length ? sql`cardinality(array(select unnest(${d.categoryIds}) intersect select unnest(${uuids(doc.categoryIds)})))` : sql`0`;
  const score = sql`
    3 * ${shared}
    + case when ${d.brandId} is not distinct from ${doc.brandId} and ${d.brandId} is not null then 2 else 0 end
    + case when ${d.attributes}->>'gender' = ${attr('gender')} then 2 else 0 end
    + case when ${d.attributes}->>'concentration' = ${attr('concentration')} then 1 else 0 end
    - case when ${own} > 0 then abs(ln(greatest(${price}, 1)::numeric / ${own})) else 0 end
    + 0.1 * ln(1 + ${d.popularity})`;
  const rows = await db
    .select({ id: d.productId })
    .from(d)
    .where(and(eq(d.storeId, store.id), eq(d.visible, true), ne(d.productId, doc.productId), sql`${price} is not null`))
    .orderBy(sql`${score} desc`, d.slug)
    .limit(limit);
  return productCards(db, store, rows.map((r) => r.id), view);
}

/** Products bought in the same checkouts as this one, most frequent first. */
export async function boughtTogether(db: Database, store: StoreContext, productId: string, view: View, limit = 6): Promise<ProductCard[]> {
  const rows = await db.execute<{ product_id: string; n: number }>(sql`
    select v2.product_id, count(distinct o1.checkout_id)::int as n
    from order_lines l1
    join product_variants v1 on v1.id = l1.variant_id
    join orders o1 on o1.id = l1.order_id
    join orders o2 on o2.checkout_id = o1.checkout_id
    join order_lines l2 on l2.order_id = o2.id
    join product_variants v2 on v2.id = l2.variant_id
    where v1.product_id = ${productId} and v2.product_id <> ${productId}
      and o1.store_id = ${store.id} and o1.status <> 'cancelled' and o2.status <> 'cancelled'
      and o1.placed_at > now() - interval '180 days'
    group by v2.product_id
    having count(distinct o1.checkout_id) >= 2
    order by n desc, v2.product_id
    limit ${limit * 2}`);
  return (await productCards(db, store, rows.rows.map((r) => r.product_id), view)).slice(0, limit);
}

export async function recommendations(db: Database, store: StoreContext, slug: string, view: View) {
  const doc = await productDoc(db, store, slug);
  const [similar, together] = [await similarProducts(db, store, doc, view), await boughtTogether(db, store, doc.productId, view)];
  // The bundle: the product + up to 2 products bought with it, else one similar product of the same brand.
  const [self] = await productCards(db, store, [doc.productId], view);
  const sameBrand = similar.filter((p) => doc.brandName && p.brand === doc.brandName);
  const extras = together.length ? together.slice(0, 2) : sameBrand.slice(0, 1);
  const items = self && extras.length ? [self, ...extras] : [];
  const totalMinor = items.reduce((sum, p) => sum + p.priceFrom.amountMinor, 0);
  return {
    similar,
    boughtTogether: together,
    bundle: items.length
      ? {
          basis: together.length ? 'bought_together' : 'same_brand',
          items,
          total: { currency: view.currency.code, amountMinor: totalMinor, amount: (totalMinor / 10 ** view.currency.minorUnits).toFixed(view.currency.minorUnits) },
        }
      : null,
  };
}
