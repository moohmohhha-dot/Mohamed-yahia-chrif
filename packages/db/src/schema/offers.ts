/**
 * Merchant offers: a merchant's price and stock for a catalog variant.
 * The catalog describes WHAT is sold; offers describe WHO sells it, at WHAT price, with HOW MUCH stock.
 * Several merchants can offer the same variant (marketplace), MB Parfum starts with one.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, pgTable, primaryKey, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    /** Inventory. Moves to per-warehouse stock when ARUMA Fulfillment opens a second location. */
    stockQuantity: integer('stock_quantity').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('offers_variant_merchant_uq').on(t.variantId, t.merchantId),
    index('offers_store_idx').on(t.storeId),
    index('offers_merchant_idx').on(t.merchantId),
    check('offers_stock_nonneg', sql`${t.stockQuantity} >= 0`),
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
