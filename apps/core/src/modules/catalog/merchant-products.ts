/**
 * Merchant-side catalog management. A merchant creates products in a store it is allowed to sell in,
 * and may only edit the products it created. Selling (price, stock) always goes through offers.
 */
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { sequential, type Executor } from '../../shared/db.js';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';
import { getActiveStore, type StoreContext } from '../stores/index.js';

type OwnerActor = Actor & { userId: string };
export type TranslationInput = { locale: string; name: string; description?: string };
export type VariantInput = { sku: string; options: Record<string, unknown> };

async function requireSellerInStore(db: Executor, merchantId: string, storeId: string) {
  const [row] = await db
    .select()
    .from(s.storeMerchants)
    .where(and(eq(s.storeMerchants.storeId, storeId), eq(s.storeMerchants.merchantId, merchantId), eq(s.storeMerchants.status, 'active')));
  if (!row) throw new AppError(403, 'NOT_ALLOWED_IN_STORE', 'The merchant is not allowed to sell in this store');
}

function checkTranslations(store: StoreContext, translations: TranslationInput[], requireDefault: boolean) {
  const locales = translations.map((t) => t.locale);
  if (new Set(locales).size !== locales.length) throw badRequest('DUPLICATE_LOCALE', 'One translation per language');
  const unsupported = locales.filter((l) => !store.locales.some((sl) => sl.code === l));
  if (unsupported.length) throw badRequest('UNSUPPORTED_LOCALE', `Not available in this store: ${unsupported.join(', ')}`);
  if (requireDefault && !locales.includes(store.defaultLocale)) {
    throw badRequest('DEFAULT_LOCALE_REQUIRED', `A translation in ${store.defaultLocale} is required`);
  }
}

async function resolveCategories(db: Executor, storeId: string, slugs: string[]) {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ id: s.categories.id, slug: s.categories.slug })
    .from(s.categories)
    .where(and(eq(s.categories.storeId, storeId), inArray(s.categories.slug, slugs)));
  const missing = slugs.filter((slug) => !rows.some((r) => r.slug === slug));
  if (missing.length) throw badRequest('UNKNOWN_CATEGORY', `Unknown categories: ${missing.join(', ')}`);
  return rows.map((r) => r.id);
}

async function requireVerified(db: Executor, merchantId: string) {
  const [m] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
  if (m?.verificationStatus !== 'verified' || m.status !== 'active') {
    throw new AppError(403, 'MERCHANT_NOT_VERIFIED', 'The merchant must be verified to publish products');
  }
}

/** Loads a product the merchant created, or 404 (another merchant's product is indistinguishable from none). */
async function getOwnProduct(db: Executor, merchantId: string, productId: string) {
  const [p] = await db
    .select()
    .from(s.products)
    .where(and(eq(s.products.id, productId), eq(s.products.createdByMerchantId, merchantId)));
  if (!p) throw notFound('Product');
  return p;
}

async function getStoreById(db: Database, storeId: string) {
  const [store] = await db.select({ slug: s.stores.slug }).from(s.stores).where(eq(s.stores.id, storeId));
  return getActiveStore(db, store!.slug);
}

export async function createProduct(
  db: Database,
  actor: OwnerActor,
  merchantId: string,
  input: {
    storeSlug: string;
    slug: string;
    brandSlug?: string;
    categorySlugs: string[];
    attributes: Record<string, unknown>;
    translations: TranslationInput[];
    variants: VariantInput[];
  },
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  const store = await getActiveStore(db, input.storeSlug);
  checkTranslations(store, input.translations, true);
  const skus = input.variants.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) throw badRequest('DUPLICATE_SKU', 'Each variant needs a unique SKU');

  try {
    return await db.transaction(async (tx) => {
      await requireSellerInStore(tx, merchantId, store.id);
      const categoryIds = await resolveCategories(tx, store.id, input.categorySlugs);
      let brandId: string | null = null;
      if (input.brandSlug) {
        const [brand] = await tx
          .select({ id: s.brands.id })
          .from(s.brands)
          .where(and(eq(s.brands.storeId, store.id), eq(s.brands.slug, input.brandSlug)));
        if (!brand) throw badRequest('UNKNOWN_BRAND', `Unknown brand: ${input.brandSlug}`);
        brandId = brand.id;
      }

      const [product] = await tx
        .insert(s.products)
        .values({
          storeId: store.id,
          createdByMerchantId: merchantId,
          brandId,
          slug: input.slug,
          status: 'draft',
          attributes: input.attributes,
        })
        .returning();
      await tx.insert(s.productTranslations).values(input.translations.map((t) => ({ productId: product!.id, ...t })));
      if (categoryIds.length) {
        await tx.insert(s.productCategories).values(categoryIds.map((categoryId) => ({ productId: product!.id, categoryId })));
      }
      await tx
        .insert(s.productVariants)
        .values(input.variants.map((v, position) => ({ productId: product!.id, ...v, position })));

      await audit(tx, actor, { action: 'catalog.product.created', entityType: 'product', entityId: product!.id });
      await recordEvent(tx, {
        type: 'catalog.product.created',
        aggregateType: 'product',
        aggregateId: product!.id,
        payload: { storeId: store.id, merchantId },
      });
      return product!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SLUG_TAKEN', 'This product slug is already used in the store');
    throw error;
  }
}

export async function updateProduct(
  db: Database,
  actor: OwnerActor,
  merchantId: string,
  productId: string,
  input: {
    status?: 'draft' | 'active' | 'archived';
    attributes?: Record<string, unknown>;
    categorySlugs?: string[];
    translations?: TranslationInput[];
  },
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  const existing = await getOwnProduct(db, merchantId, productId);
  const store = await getStoreById(db, existing.storeId);
  if (input.translations) checkTranslations(store, input.translations, false);

  return db.transaction(async (tx) => {
    if (input.status === 'active') await requireVerified(tx, merchantId);
    const [product] = await tx
      .update(s.products)
      .set({
        ...(input.status ? { status: input.status } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
      })
      .where(eq(s.products.id, productId))
      .returning();
    for (const t of input.translations ?? []) {
      const values = { name: t.name, description: t.description ?? null };
      await tx
        .insert(s.productTranslations)
        .values({ productId, locale: t.locale, ...values })
        .onConflictDoUpdate({ target: [s.productTranslations.productId, s.productTranslations.locale], set: values });
    }
    if (input.categorySlugs) {
      const categoryIds = await resolveCategories(tx, existing.storeId, input.categorySlugs);
      await tx.delete(s.productCategories).where(eq(s.productCategories.productId, productId));
      if (categoryIds.length) {
        await tx.insert(s.productCategories).values(categoryIds.map((categoryId) => ({ productId, categoryId })));
      }
    }
    await audit(tx, actor, {
      action: 'catalog.product.updated',
      entityType: 'product',
      entityId: productId,
      metadata: { fields: Object.keys(input), status: input.status ?? null },
    });
    return product!;
  });
}

export async function addVariant(db: Database, actor: OwnerActor, merchantId: string, productId: string, input: VariantInput) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  await getOwnProduct(db, merchantId, productId);
  try {
    return await db.transaction(async (tx) => {
      const count = await tx.$count(s.productVariants, eq(s.productVariants.productId, productId));
      const [variant] = await tx
        .insert(s.productVariants)
        .values({ productId, ...input, position: count })
        .returning();
      await audit(tx, actor, { action: 'catalog.variant.created', entityType: 'variant', entityId: variant!.id });
      return variant!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('DUPLICATE_SKU', 'This SKU already exists for the product');
    throw error;
  }
}

export async function updateVariant(
  db: Database,
  actor: OwnerActor,
  merchantId: string,
  productId: string,
  variantId: string,
  input: { options?: Record<string, unknown>; isActive?: boolean },
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  await getOwnProduct(db, merchantId, productId);
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .update(s.productVariants)
      .set(input)
      .where(and(eq(s.productVariants.id, variantId), eq(s.productVariants.productId, productId)))
      .returning();
    if (!variant) throw notFound('Variant');
    await audit(tx, actor, { action: 'catalog.variant.updated', entityType: 'variant', entityId: variantId, metadata: input });
    return variant;
  });
}

async function describeProducts(db: Executor, products: (typeof s.products.$inferSelect & { storeSlug: string })[], merchantId: string) {
  if (products.length === 0) return [];
  const ids = products.map((p) => p.id);
  const [translations, variants, categories, myOffers] = await sequential([
    db.select().from(s.productTranslations).where(inArray(s.productTranslations.productId, ids)),
    db.select().from(s.productVariants).where(inArray(s.productVariants.productId, ids)).orderBy(asc(s.productVariants.position)),
    db
      .select({ productId: s.productCategories.productId, slug: s.categories.slug })
      .from(s.productCategories)
      .innerJoin(s.categories, eq(s.categories.id, s.productCategories.categoryId))
      .where(inArray(s.productCategories.productId, ids)),
    db
      .select({ id: s.offers.id, variantId: s.offers.variantId, status: s.offers.status, stock: s.offers.stockQuantity })
      .from(s.offers)
      .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
      .where(and(eq(s.offers.merchantId, merchantId), inArray(s.productVariants.productId, ids))),
  ]);
  return products.map((p) => ({
    id: p.id,
    slug: p.slug,
    storeSlug: p.storeSlug,
    status: p.status,
    attributes: p.attributes,
    ownedByMe: p.createdByMerchantId === merchantId,
    translations: translations.filter((t) => t.productId === p.id).map(({ locale, name, description }) => ({ locale, name, description })),
    categories: categories.filter((c) => c.productId === p.id).map((c) => c.slug),
    variants: variants
      .filter((v) => v.productId === p.id)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        options: v.options,
        isActive: v.isActive,
        myOffer: myOffers.find((o) => o.variantId === v.id) ?? null,
      })),
    updatedAt: p.updatedAt,
  }));
}

export async function listMerchantProducts(db: Database, userId: string, merchantId: string) {
  await requireMembership(db, merchantId, userId);
  const rows = await db
    .select({ product: s.products, storeSlug: s.stores.slug })
    .from(s.products)
    .innerJoin(s.stores, eq(s.stores.id, s.products.storeId))
    .where(eq(s.products.createdByMerchantId, merchantId))
    .orderBy(desc(s.products.updatedAt));
  return describeProducts(db, rows.map((r) => ({ ...r.product, storeSlug: r.storeSlug })), merchantId);
}

/** Active products in the stores this merchant sells in, to add its own offer to (marketplace). */
export async function searchSellableCatalog(db: Database, userId: string, merchantId: string, q: string | undefined) {
  await requireMembership(db, merchantId, userId);
  const conditions = [
    eq(s.storeMerchants.merchantId, merchantId),
    eq(s.storeMerchants.status, 'active'),
    or(eq(s.products.status, 'active'), eq(s.products.createdByMerchantId, merchantId)),
  ];
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        ilike(s.products.slug, pattern),
        inArray(
          s.products.id,
          db.select({ id: s.productTranslations.productId }).from(s.productTranslations).where(ilike(s.productTranslations.name, pattern)),
        ),
      ),
    );
  }
  const rows = await db
    .selectDistinct({ product: s.products, storeSlug: s.stores.slug })
    .from(s.products)
    .innerJoin(s.stores, eq(s.stores.id, s.products.storeId))
    .innerJoin(s.storeMerchants, eq(s.storeMerchants.storeId, s.products.storeId))
    .where(and(...conditions))
    .limit(50);
  return describeProducts(db, rows.map((r) => ({ ...r.product, storeSlug: r.storeSlug })), merchantId);
}
