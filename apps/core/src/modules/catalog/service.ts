import { and, asc, count, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { toMoney, type Money } from '../../shared/money.js';
import { loadSellableOffers, pickBestOffer } from '../offers/index.js';
import type { StoreContext } from '../stores/index.js';

type Currency = StoreContext['currencies'][number];

export type ListProductsInput = {
  locale: string;
  currency: Currency;
  categorySlug?: string;
  page: number;
  pageSize: number;
};

/** Picks the translation for `locale`, falling back to the store default locale. */
function pickTranslation<T extends { locale: string }>(rows: T[], locale: string, fallback: string): T | undefined {
  return rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale === fallback);
}

async function loadTranslations(db: Database, productIds: string[], locales: string[]) {
  if (productIds.length === 0) return new Map<string, (typeof s.productTranslations.$inferSelect)[]>();
  const rows = await db
    .select()
    .from(s.productTranslations)
    .where(and(inArray(s.productTranslations.productId, productIds), inArray(s.productTranslations.locale, locales)));
  const map = new Map<string, typeof rows>();
  for (const row of rows) map.set(row.productId, [...(map.get(row.productId) ?? []), row]);
  return map;
}

async function loadVariants(db: Database, productIds: string[]) {
  if (productIds.length === 0) return [];
  return db
    .select({
      id: s.productVariants.id,
      productId: s.productVariants.productId,
      sku: s.productVariants.sku,
      options: s.productVariants.options,
    })
    .from(s.productVariants)
    .where(and(inArray(s.productVariants.productId, productIds), eq(s.productVariants.isActive, true)))
    .orderBy(asc(s.productVariants.position));
}

export async function listProducts(db: Database, store: StoreContext, input: ListProductsInput) {
  const conditions = [eq(s.products.storeId, store.id), eq(s.products.status, 'active')];

  if (input.categorySlug) {
    const [category] = await db
      .select({ id: s.categories.id })
      .from(s.categories)
      .where(and(eq(s.categories.storeId, store.id), eq(s.categories.slug, input.categorySlug)));
    if (!category) throw notFound('Category');
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(s.productCategories)
          .where(
            and(eq(s.productCategories.productId, s.products.id), eq(s.productCategories.categoryId, category.id)),
          ),
      ),
    );
  }

  const where = and(...conditions);
  const [totalRow, rows] = await Promise.all([
    db.select({ total: count() }).from(s.products).where(where),
    db
      .select({
        id: s.products.id,
        slug: s.products.slug,
        attributes: s.products.attributes,
        brandName: s.brands.name,
      })
      .from(s.products)
      .leftJoin(s.brands, eq(s.brands.id, s.products.brandId))
      .where(where)
      .orderBy(desc(s.products.createdAt), asc(s.products.slug))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);

  const ids = rows.map((r) => r.id);
  const [translations, variants, images] = await Promise.all([
    loadTranslations(db, ids, [input.locale, store.defaultLocale]),
    loadVariants(db, ids),
    ids.length
      ? db
          .select()
          .from(s.productImages)
          .where(inArray(s.productImages.productId, ids))
          .orderBy(asc(s.productImages.position))
      : Promise.resolve([]),
  ]);

  const offers = await loadSellableOffers(
    db,
    store.id,
    variants.map((v) => v.id),
    input.currency.code,
  );

  const items = rows.map((p) => {
    const t = pickTranslation(translations.get(p.id) ?? [], input.locale, store.defaultLocale);
    const variantIds = new Set(variants.filter((v) => v.productId === p.id).map((v) => v.id));
    const own = offers.filter((o) => variantIds.has(o.variantId));
    const minPrice = own.reduce<bigint | null>((min, o) => (min === null || o.amountMinor < min ? o.amountMinor : min), null);
    const image = images.find((i) => i.productId === p.id);
    return {
      id: p.id,
      slug: p.slug,
      name: t?.name ?? p.slug,
      brand: p.brandName,
      attributes: p.attributes,
      image: image ? { url: image.url, alt: image.alt } : null,
      priceFrom: minPrice === null ? null : toMoney(minPrice, input.currency.code, input.currency.minorUnits),
      inStock: own.some((v) => v.available > 0),
    };
  });

  const total = totalRow[0]?.total ?? 0;
  return {
    data: items,
    meta: {
      locale: input.locale,
      currency: input.currency.code,
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    },
  };
}

export async function getProduct(
  db: Database,
  store: StoreContext,
  slug: string,
  locale: string,
  currency: Currency,
) {
  const [p] = await db
    .select({
      id: s.products.id,
      slug: s.products.slug,
      attributes: s.products.attributes,
      brandSlug: s.brands.slug,
      brandName: s.brands.name,
    })
    .from(s.products)
    .leftJoin(s.brands, eq(s.brands.id, s.products.brandId))
    .where(and(eq(s.products.storeId, store.id), eq(s.products.slug, slug), eq(s.products.status, 'active')));
  if (!p) throw notFound('Product');

  const [translations, variants, images, categories] = await Promise.all([
    loadTranslations(db, [p.id], [locale, store.defaultLocale]),
    loadVariants(db, [p.id]),
    db
      .select({ url: s.productImages.url, alt: s.productImages.alt })
      .from(s.productImages)
      .where(eq(s.productImages.productId, p.id))
      .orderBy(asc(s.productImages.position)),
    db
      .select({ slug: s.categories.slug })
      .from(s.productCategories)
      .innerJoin(s.categories, eq(s.categories.id, s.productCategories.categoryId))
      .where(eq(s.productCategories.productId, p.id)),
  ]);
  const t = pickTranslation(translations.get(p.id) ?? [], locale, store.defaultLocale);
  const offers = await loadSellableOffers(
    db,
    store.id,
    variants.map((v) => v.id),
    currency.code,
  );

  const money = (v: bigint | null): Money | null =>
    v === null ? null : toMoney(v, currency.code, currency.minorUnits);

  return {
    data: {
      id: p.id,
      slug: p.slug,
      name: t?.name ?? p.slug,
      description: t?.description ?? null,
      brand: p.brandSlug ? { slug: p.brandSlug, name: p.brandName } : null,
      attributes: p.attributes,
      categories: categories.map((c) => c.slug),
      images,
      variants: variants.map((v) => {
        const own = offers.filter((o) => o.variantId === v.id);
        const best = pickBestOffer(own);
        return {
          id: v.id,
          sku: v.sku,
          options: v.options,
          inStock: own.some((o) => o.available > 0),
          price: money(best?.amountMinor ?? null),
          compareAtPrice: money(best?.compareAtMinor ?? null),
          /** The offer a cart line will reference; other merchants' offers are counted in offerCount. */
          offer: best ? { id: best.offerId, merchant: best.merchant } : null,
          offerCount: own.length,
        };
      }),
    },
    meta: { locale, currency: currency.code },
  };
}

export async function listCategories(db: Database, store: StoreContext, locale: string) {
  const rows = await db
    .select({ id: s.categories.id, slug: s.categories.slug, parentId: s.categories.parentId })
    .from(s.categories)
    .where(and(eq(s.categories.storeId, store.id), eq(s.categories.status, 'active')))
    .orderBy(asc(s.categories.position), asc(s.categories.slug));
  const translations = rows.length
    ? await db
        .select()
        .from(s.categoryTranslations)
        .where(
          and(
            inArray(
              s.categoryTranslations.categoryId,
              rows.map((r) => r.id),
            ),
            inArray(s.categoryTranslations.locale, [locale, store.defaultLocale]),
          ),
        )
    : [];
  return {
    data: rows.map((c) => {
      const t = pickTranslation(
        translations.filter((tr) => tr.categoryId === c.id),
        locale,
        store.defaultLocale,
      );
      return { id: c.id, slug: c.slug, parentId: c.parentId, name: t?.name ?? c.slug };
    }),
    meta: { locale },
  };
}
