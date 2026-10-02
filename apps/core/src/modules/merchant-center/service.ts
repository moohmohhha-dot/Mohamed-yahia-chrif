/**
 * Merchant Center read model: one call that summarizes a merchant's state for its dashboard.
 * It only reads; every change goes through the owning module (merchants, catalog, offers).
 */
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { resolveCommissionBps } from '../finance/index.js';
import { requireMembership } from '../merchants/index.js';

/** Sections whose module is not built yet; the Merchant Center shows them as upcoming. */
export const UPCOMING_SECTIONS = {
  sales: 1,
  customers: 1,
  coupons: 2,
  promotions: 2,
  ads: 3,
  analytics: 2,
  reviews: 2,
  messages: 2,
  support: 2,
  balance: 2,
  settlements: 2,
  payouts: 2,
} as const;

export async function getDashboard(db: Database, userId: string, merchantId: string) {
  const role = await requireMembership(db, merchantId, userId);
  const [merchant] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));

  const [checks, stores, productsByStatus, offerStats, recentMovements] = await Promise.all([
    db
      .select({ kind: s.merchantVerifications.kind, status: s.merchantVerifications.status })
      .from(s.merchantVerifications)
      .where(eq(s.merchantVerifications.merchantId, merchantId)),
    listMerchantStores(db, userId, merchantId).then((rows) =>
      rows.filter((r) => r.status === 'active').map(({ storeSlug, storeName, commissionBps }) => ({ storeSlug, storeName, commissionBps })),
    ),
    db
      .select({ status: s.products.status, n: count() })
      .from(s.products)
      .where(eq(s.products.createdByMerchantId, merchantId))
      .groupBy(s.products.status),
    db
      .select({
        active: sql<number>`count(*) filter (where ${s.offers.status} = 'active')`.mapWith(Number),
        archived: sql<number>`count(*) filter (where ${s.offers.status} = 'archived')`.mapWith(Number),
        outOfStock: sql<number>`count(*) filter (where ${s.offers.status} = 'active' and ${s.offers.availableQuantity} = 0)`.mapWith(Number),
        lowStock: sql<number>`count(*) filter (where ${s.offers.status} = 'active' and ${s.offers.availableQuantity} > 0 and ${s.offers.availableQuantity} <= ${s.offers.lowStockThreshold})`.mapWith(Number),
        units: sql<number>`coalesce(sum(${s.offers.onHandQuantity}) filter (where ${s.offers.status} = 'active'), 0)`.mapWith(Number),
        reserved: sql<number>`coalesce(sum(${s.offers.reservedQuantity}) filter (where ${s.offers.status} = 'active'), 0)`.mapWith(Number),
        available: sql<number>`coalesce(sum(${s.offers.availableQuantity}) filter (where ${s.offers.status} = 'active'), 0)`.mapWith(Number),
      })
      .from(s.offers)
      .where(eq(s.offers.merchantId, merchantId)),
    db
      .select({
        id: s.inventoryMovements.id,
        sku: s.productVariants.sku,
        delta: s.inventoryMovements.delta,
        quantityAfter: s.inventoryMovements.quantityAfter,
        reason: s.inventoryMovements.reason,
        createdAt: s.inventoryMovements.createdAt,
      })
      .from(s.inventoryMovements)
      .innerJoin(s.offers, eq(s.offers.id, s.inventoryMovements.offerId))
      .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
      .where(eq(s.inventoryMovements.merchantId, merchantId))
      .orderBy(desc(s.inventoryMovements.createdAt))
      .limit(5),
  ]);

  const ordersByStatus = await db
    .select({ status: s.orders.status, n: count() })
    .from(s.orders)
    .where(eq(s.orders.merchantId, merchantId))
    .groupBy(s.orders.status);

  return {
    orders: Object.fromEntries(ordersByStatus.map((o) => [o.status, o.n])),
    merchant: {
      id: merchant!.id,
      name: merchant!.name,
      type: merchant!.type,
      status: merchant!.status,
      verificationStatus: merchant!.verificationStatus,
      canSell: merchant!.verificationStatus === 'verified' && merchant!.status === 'active',
    },
    myRole: role,
    checks,
    stores,
    products: Object.fromEntries(productsByStatus.map((p) => [p.status, p.n])),
    offers: offerStats[0],
    recentMovements,
    upcomingSections: UPCOMING_SECTIONS,
  };
}

/**
 * Stores the merchant may sell in, with the commission that applies today: the merchant's own rate if
 * ARUMA set one, otherwise the store / platform rule (8 % by default). Read-only for merchants.
 */
export async function listMerchantStores(db: Database, userId: string, merchantId: string) {
  await requireMembership(db, merchantId, userId);
  const rows = await db
    .select({ storeId: s.stores.id, storeSlug: s.stores.slug, storeName: s.stores.name, override: s.storeMerchants.commissionBps, status: s.storeMerchants.status })
    .from(s.storeMerchants)
    .innerJoin(s.stores, eq(s.stores.id, s.storeMerchants.storeId))
    .where(eq(s.storeMerchants.merchantId, merchantId));
  const result = [];
  for (const r of rows) {
    result.push({
      storeSlug: r.storeSlug,
      storeName: r.storeName,
      status: r.status,
      commissionBps: await resolveCommissionBps(db, r.storeId, merchantId),
      commissionSource: r.override === null ? 'rules' : 'merchant_rate',
    });
  }
  return result;
}
