/**
 * Product comparison: a table built from the catalog (sizes, price per 100 ml, notes, gender,
 * concentration, rating, sellers) and highlights computed by rules (cheapest, best value, best rated, most
 * popular). With AI switched on, a short written comparison is added under the table — never instead of it.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type Database } from '@aruma/db';
import { badRequest } from '../../shared/errors.js';
import { loadSellableOffers } from '../offers/index.js';
import { productCards } from '../search/index.js';
import type { StoreContext } from '../stores/index.js';
import { answerIn, data, type AiLayer } from './gateway.js';

type View = { locale: string; currency: { code: string; minorUnits: number } };

const summarySchema = z.object({
  summary: z.string().min(1).max(900),
  bestFor: z.array(z.object({ slug: z.string().max(128), reason: z.string().max(200) })).max(4),
});

const notesOf = (attributes: Record<string, unknown>) => {
  const n = (attributes.notes ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : []);
  return { top: list(n.top), heart: list(n.heart), base: list(n.base) };
};

/** Catalog facts for products a customer can buy now (card, sizes and prices, notes, gender, concentration). */
export async function productFacts(db: Database, store: StoreContext, productIds: string[], view: View) {
  const cards = await productCards(db, store, productIds, view);
  if (!cards.length) return [];
  const products = await db
    .select({ id: s.products.id, attributes: s.products.attributes })
    .from(s.products)
    .where(inArray(s.products.id, cards.map((c) => c.id)));
  const variants = await db
    .select({ id: s.productVariants.id, productId: s.productVariants.productId, options: s.productVariants.options })
    .from(s.productVariants)
    .where(and(inArray(s.productVariants.productId, cards.map((c) => c.id)), eq(s.productVariants.isActive, true)))
    .orderBy(asc(s.productVariants.position));
  const offers = await loadSellableOffers(db, store.id, variants.map((v) => v.id), view.currency.code);
  const money = (minor: number) => ({ currency: view.currency.code, amountMinor: minor, amount: (minor / 10 ** view.currency.minorUnits).toFixed(view.currency.minorUnits) });

  return cards.map((card) => {
    const attributes = products.find((p) => p.id === card.id)?.attributes ?? {};
    const sizes = variants
      .filter((v) => v.productId === card.id)
      .map((v) => {
        const own = offers.filter((o) => o.variantId === v.id);
        if (!own.length) return null;
        const best = Math.min(...own.map((o) => Number(o.amountMinor)));
        const ml = typeof v.options.sizeMl === 'number' ? v.options.sizeMl : null;
        return { sizeMl: ml, price: money(best), per100ml: ml ? money(Math.round((best * 100) / ml)) : null, inStock: own.some((o) => o.available > 0) };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
    return { product: card, sizes, notes: notesOf(attributes), gender: card.attributes.gender ?? null, concentration: card.attributes.concentration ?? null };
  });
}

export async function compareProducts(db: Database, ai: AiLayer, store: StoreContext, slugs: string[], view: View, userId?: string, options: { summary?: boolean } = {}) {
  const unique = [...new Set(slugs)];
  if (unique.length < 2 || unique.length > 4) throw badRequest('COMPARE_COUNT', 'Compare 2 to 4 products');
  const products = await db
    .select({ id: s.products.id, slug: s.products.slug })
    .from(s.products)
    .where(and(eq(s.products.storeId, store.id), inArray(s.products.slug, unique)));
  const rows = await productFacts(db, store, unique.map((slug) => products.find((p) => p.slug === slug)?.id).filter((id): id is string => Boolean(id)), view);
  if (rows.length < 2) throw badRequest('COMPARE_UNAVAILABLE', 'At least two of these products are not for sale');

  const pick = (score: (r: (typeof rows)[number]) => number | null, lowest = false) => {
    const scored = rows.map((r) => ({ slug: r.product.slug, v: score(r) })).filter((x): x is { slug: string; v: number } => x.v !== null);
    if (!scored.length) return null;
    scored.sort((a, b) => (lowest ? a.v - b.v : b.v - a.v));
    return scored[0]!.slug;
  };
  const perMl = (r: (typeof rows)[number]) => {
    const values = r.sizes.map((x) => x.per100ml?.amountMinor).filter((v): v is number => typeof v === 'number');
    return values.length ? Math.min(...values) : null;
  };
  const highlights = {
    cheapest: pick((r) => r.product.priceFrom.amountMinor, true),
    bestValue: pick(perMl, true),
    bestRated: pick((r) => (r.product.rating.count >= 3 ? Number(r.product.rating.average) : null)),
    inStock: rows.filter((r) => r.product.inStock).map((r) => r.product.slug),
  };

  // Written comparison: only when switched on; reused until a price, rating or name changes.
  let summary: z.infer<typeof summarySchema> | null = null;
  if (options.summary !== false && (await ai.enabled('product_comparison', store.id))) {
    const facts = rows.map((r) => ({ slug: r.product.slug, name: r.product.name, brand: r.product.brand, gender: r.gender, concentration: r.concentration, notes: r.notes, sizes: r.sizes.map((x) => ({ ml: x.sizeMl, price: x.price.amount, per100ml: x.per100ml?.amount ?? null })), rating: r.product.rating }));
    const key = ai.cache.key('compare', store.id, view.locale, view.currency.code, facts);
    summary = await ai.cache.get<z.infer<typeof summarySchema>>(key);
    if (!summary) {
      summary = await ai.json({
        feature: 'product_comparison',
        scope: { storeId: store.id, userId },
        system: `You compare perfumes for a shopper in a few sentences: what differs (scent, strength, price per 100 ml) and who each suits. Return {"summary": text, "bestFor": [{"slug", "reason"}]}. ${answerIn(view.locale)} Prices are in ${view.currency.code}.`,
        prompt: data('products', facts),
        schema: summarySchema,
        skipEnabledCheck: true,
      });
      if (summary) {
        summary.bestFor = summary.bestFor.filter((b) => rows.some((r) => r.product.slug === b.slug));
        await ai.cache.set(key, 'product_comparison', summary, 24);
      }
    }
  }
  return { products: rows, highlights, summary: summary ? { ...summary, generatedByAi: true } : null };
}
