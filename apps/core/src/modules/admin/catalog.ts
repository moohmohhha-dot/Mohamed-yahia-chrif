/** Products, offers and stock across all merchants; ARUMA can take a product off sale (moderation). */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { assertNoConflictOfInterest } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';

const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

async function namesOf(db: Database, productIds: string[]) {
  if (!productIds.length) return new Map<string, Record<string, string>>();
  const rows = await db.select({ productId: s.productTranslations.productId, locale: s.productTranslations.locale, name: s.productTranslations.name }).from(s.productTranslations).where(inArray(s.productTranslations.productId, productIds));
  const map = new Map<string, Record<string, string>>();
  for (const r of rows) map.set(r.productId, { ...map.get(r.productId), [r.locale]: r.name });
  return map;
}

export async function listProducts(db: Database, q: { q?: string; status?: 'draft' | 'active' | 'archived'; blocked?: boolean; merchantId?: string; storeId?: string; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.q) where.push(sql`(${s.products.slug} ilike ${like(q.q)} or ${s.products.id} in (select product_id from product_translations where name ilike ${like(q.q)}))`);
  if (q.status) where.push(eq(s.products.status, q.status));
  if (q.blocked !== undefined) where.push(q.blocked ? isNotNull(s.products.blockedAt) : isNull(s.products.blockedAt));
  if (q.merchantId) where.push(eq(s.products.createdByMerchantId, q.merchantId));
  if (q.storeId) where.push(eq(s.products.storeId, q.storeId));
  const rows = await db
    .select({ product: s.products, storeSlug: s.stores.slug, merchantName: s.merchants.name })
    .from(s.products)
    .innerJoin(s.stores, eq(s.stores.id, s.products.storeId))
    .leftJoin(s.merchants, eq(s.merchants.id, s.products.createdByMerchantId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.products.updatedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const ids = rows.map((r) => r.product.id);
  const names = await namesOf(db, ids);
  const offers = ids.length
    ? await db
        .select({ productId: s.productVariants.productId, n: sql<number>`count(*)::int`, stock: sql<number>`coalesce(sum(${s.offers.availableQuantity}), 0)::int` })
        .from(s.offers)
        .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
        .where(inArray(s.productVariants.productId, ids))
        .groupBy(s.productVariants.productId)
    : [];
  return rows.map(({ product: p, storeSlug, merchantName }) => ({
    id: p.id,
    slug: p.slug,
    storeSlug,
    merchantId: p.createdByMerchantId,
    merchantName,
    names: names.get(p.id) ?? {},
    status: p.status,
    blocked: p.blockedAt ? { at: p.blockedAt, reason: p.blockReason } : null,
    offers: offers.find((o) => o.productId === p.id)?.n ?? 0,
    availableStock: offers.find((o) => o.productId === p.id)?.stock ?? 0,
    updatedAt: p.updatedAt,
  }));
}

export async function describeProduct(db: Database, productId: string) {
  const [row] = await db
    .select({ product: s.products, storeSlug: s.stores.slug, merchantName: s.merchants.name })
    .from(s.products)
    .innerJoin(s.stores, eq(s.stores.id, s.products.storeId))
    .leftJoin(s.merchants, eq(s.merchants.id, s.products.createdByMerchantId))
    .where(eq(s.products.id, productId));
  if (!row) throw notFound('Product');
  const p = row.product;
  const [translations, variants, offers, history] = [
    await db.select({ locale: s.productTranslations.locale, name: s.productTranslations.name, description: s.productTranslations.description }).from(s.productTranslations).where(eq(s.productTranslations.productId, productId)),
    await db.select({ id: s.productVariants.id, sku: s.productVariants.sku, options: s.productVariants.options, isActive: s.productVariants.isActive }).from(s.productVariants).where(eq(s.productVariants.productId, productId)).orderBy(asc(s.productVariants.position)),
    await listOffers(db, { productId, page: 1, pageSize: 100 }),
    await db
      .select({ action: s.auditLogs.action, actorName: s.users.displayName, metadata: s.auditLogs.metadata, createdAt: s.auditLogs.createdAt })
      .from(s.auditLogs)
      .leftJoin(s.users, eq(s.users.id, s.auditLogs.actorUserId))
      .where(and(eq(s.auditLogs.entityType, 'product'), eq(s.auditLogs.entityId, productId)))
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(50),
  ];
  return {
    id: p.id,
    slug: p.slug,
    storeSlug: row.storeSlug,
    merchantId: p.createdByMerchantId,
    merchantName: row.merchantName,
    status: p.status,
    attributes: p.attributes,
    blocked: p.blockedAt ? { at: p.blockedAt, reason: p.blockReason, previousStatus: p.blockedFromStatus } : null,
    translations,
    variants,
    offers,
    history,
    createdAt: p.createdAt,
  };
}

/** Takes a product off sale at once (counterfeit, forbidden item, misleading listing). The merchant sees the reason. */
export async function blockProduct(db: Database, actor: Actor & { userId: string }, productId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(s.products).where(eq(s.products.id, productId)).for('update');
    if (!p) throw notFound('Product');
    if (p.createdByMerchantId) await assertNoConflictOfInterest(tx, actor.userId, p.createdByMerchantId);
    if (p.blockedAt) throw new AppError(409, 'ALREADY_BLOCKED', 'This product is already blocked');
    await tx
      .update(s.products)
      .set({ blockedAt: new Date(), blockedBy: actor.userId, blockReason: reason, blockedFromStatus: p.status, status: p.status === 'active' ? 'archived' : p.status })
      .where(eq(s.products.id, productId));
    await audit(tx, actor, { action: 'catalog.product.blocked', entityType: 'product', entityId: productId, metadata: { reason, previousStatus: p.status } });
    await recordEvent(tx, { type: 'catalog.product.blocked', aggregateType: 'product', aggregateId: productId, payload: { merchantId: p.createdByMerchantId } });
  });
}

export async function unblockProduct(db: Database, actor: Actor & { userId: string }, productId: string, note: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(s.products).where(eq(s.products.id, productId)).for('update');
    if (!p) throw notFound('Product');
    if (p.createdByMerchantId) await assertNoConflictOfInterest(tx, actor.userId, p.createdByMerchantId);
    if (!p.blockedAt) throw new AppError(409, 'NOT_BLOCKED', 'This product is not blocked');
    const status = p.blockedFromStatus ?? 'draft';
    await tx.update(s.products).set({ blockedAt: null, blockedBy: null, blockReason: null, blockedFromStatus: null, status }).where(eq(s.products.id, productId));
    await audit(tx, actor, { action: 'catalog.product.unblocked', entityType: 'product', entityId: productId, metadata: { note, restoredStatus: status } });
  });
}

export async function listOffers(db: Database, q: { merchantId?: string; productId?: string; status?: 'draft' | 'active' | 'archived'; q?: string; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.merchantId) where.push(eq(s.offers.merchantId, q.merchantId));
  if (q.productId) where.push(eq(s.productVariants.productId, q.productId));
  if (q.status) where.push(eq(s.offers.status, q.status));
  if (q.q) where.push(ilike(s.offers.sku, like(q.q)));
  const rows = await db
    .select({
      id: s.offers.id,
      sku: s.offers.sku,
      status: s.offers.status,
      merchantId: s.offers.merchantId,
      merchantName: s.merchants.name,
      productId: s.productVariants.productId,
      variantSku: s.productVariants.sku,
      options: s.productVariants.options,
      storeSlug: s.stores.slug,
      onHand: s.offers.onHandQuantity,
      reserved: s.offers.reservedQuantity,
      available: s.offers.availableQuantity,
      lowStockThreshold: s.offers.lowStockThreshold,
      updatedAt: s.offers.updatedAt,
    })
    .from(s.offers)
    .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
    .innerJoin(s.merchants, eq(s.merchants.id, s.offers.merchantId))
    .innerJoin(s.stores, eq(s.stores.id, s.offers.storeId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.offers.updatedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const ids = rows.map((r) => r.id);
  const [prices, names] = [
    ids.length ? await db.select().from(s.offerPrices).where(inArray(s.offerPrices.offerId, ids)) : [],
    await namesOf(db, [...new Set(rows.map((r) => r.productId))]),
  ];
  return rows.map((o) => ({
    ...o,
    productNames: names.get(o.productId) ?? {},
    prices: prices.filter((p) => p.offerId === o.id).map((p) => ({ currency: p.currency, amountMinor: Number(p.amountMinor), compareAtMinor: p.compareAtMinor === null ? null : Number(p.compareAtMinor) })),
  }));
}

/** Stock per offer and location; `low` = at or below the merchant's alert threshold. */
export async function listInventory(db: Database, q: { merchantId?: string; low?: boolean; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.merchantId) where.push(eq(s.offers.merchantId, q.merchantId));
  if (q.low) where.push(and(isNotNull(s.offers.lowStockThreshold), lte(s.offers.availableQuantity, s.offers.lowStockThreshold))!);
  const rows = await db
    .select({
      offerId: s.offers.id,
      sku: s.offers.sku,
      merchantId: s.offers.merchantId,
      merchantName: s.merchants.name,
      productId: s.productVariants.productId,
      locationCode: s.inventoryLocations.code,
      locationName: s.inventoryLocations.name,
      city: s.inventoryLocations.city,
      onHand: s.inventoryLevels.onHand,
      reserved: s.inventoryLevels.reserved,
      offerAvailable: s.offers.availableQuantity,
      lowStockThreshold: s.offers.lowStockThreshold,
      updatedAt: s.inventoryLevels.updatedAt,
    })
    .from(s.inventoryLevels)
    .innerJoin(s.offers, eq(s.offers.id, s.inventoryLevels.offerId))
    .innerJoin(s.inventoryLocations, eq(s.inventoryLocations.id, s.inventoryLevels.locationId))
    .innerJoin(s.merchants, eq(s.merchants.id, s.offers.merchantId))
    .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(s.offers.availableQuantity), asc(s.offers.sku))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const names = await namesOf(db, [...new Set(rows.map((r) => r.productId))]);
  return rows.map((r) => ({ ...r, productNames: names.get(r.productId) ?? {}, low: r.lowStockThreshold !== null && r.offerAvailable <= r.lowStockThreshold }));
}
