/**
 * Merchant offers: a merchant's price and stock for a catalog variant.
 * The catalog describes WHAT is sold; offers describe WHO sells it, at WHAT price, with HOW MUCH stock.
 * Several merchants can offer the same variant (marketplace), MB Parfum starts with one.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, pgTable, primaryKey, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { productVariants } from './catalog.js';
import { merchants } from './merchants.js';
import { currencies } from './reference.js';
import { stores } from './tenancy.js';

export const offers = pgTable(
  'offers',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    status: recordStatus('status').notNull().default('active'),
    /** The merchant's own SKU for this offer: unique per merchant, used by imports and the Inventory API. */
    sku: varchar('sku', { length: 64 }).notNull(),
    /**
     * Totals across all inventory locations. Maintained ONLY by a database trigger on inventory_levels
     * (migration 0004): the application never writes them. available = on_hand - reserved.
     */
    onHandQuantity: integer('on_hand_quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    availableQuantity: integer('available_quantity').notNull().default(0),
    /** Alert when available stock is at or below this; null = no alert. */
    lowStockThreshold: integer('low_stock_threshold').default(5),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('offers_variant_merchant_uq').on(t.variantId, t.merchantId),
    uniqueIndex('offers_merchant_sku_uq').on(t.merchantId, t.sku),
    index('offers_store_idx').on(t.storeId),
    index('offers_merchant_idx').on(t.merchantId),
    check('offers_available_nonneg', sql`${t.availableQuantity} >= 0`),
  ],
);

/** One explicit price per offer per currency. No silent FX conversion. */
export const offerPrices = pgTable(
  'offer_prices',
  {
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    compareAtMinor: bigint('compare_at_minor', { mode: 'bigint' }),
  },
  (t) => [
    primaryKey({ columns: [t.offerId, t.currency] }),
    check('offer_prices_amount_nonneg', sql`${t.amountMinor} >= 0`),
  ],
);
