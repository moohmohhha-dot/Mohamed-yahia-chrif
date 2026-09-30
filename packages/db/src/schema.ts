/**
 * ARUMA MARKET — core data model.
 *
 * Design rules (see docs/ARCHITECTURE.md):
 * - Every commercial record is scoped to a `store` (a storefront app such as MB Parfum)
 *   and, for catalog data, to a `vendor` (the merchant who sells it). MB Parfum starts
 *   with a single vendor; the marketplace adds more without schema changes.
 * - Money is stored as integer minor units (e.g. cents / centimes) plus an ISO 4217 code.
 *   Never floats.
 * - Human-readable text lives in `*_translations` tables keyed by BCP 47 locale.
 * - Vertical-specific fields (perfume notes, concentration…) live in `attributes` JSONB,
 *   so a future electronics or fashion store reuses the same tables.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const recordStatus = pgEnum('record_status', ['draft', 'active', 'archived']);

// ---------------------------------------------------------------------------
// Reference data (global)
// ---------------------------------------------------------------------------

export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(), // ISO 4217, e.g. DZD
  name: text('name').notNull(),
  minorUnits: smallint('minor_units').notNull(), // DZD = 2, JPY = 0, KWD = 3
});

export const locales = pgTable('locales', {
  code: varchar('code', { length: 16 }).primaryKey(), // BCP 47, e.g. ar, fr, en
  name: text('name').notNull(),
  direction: varchar('direction', { length: 3 }).notNull().default('ltr'), // ltr | rtl
});

export const countries = pgTable('countries', {
  code: char('code', { length: 2 }).primaryKey(), // ISO 3166-1 alpha-2
  name: text('name').notNull(),
  defaultCurrency: char('default_currency', { length: 3 })
    .notNull()
    .references(() => currencies.code),
});

// ---------------------------------------------------------------------------
// Tenancy: stores (storefront apps) and vendors (merchants)
// ---------------------------------------------------------------------------

export const stores = pgTable('stores', {
  id: id(),
  slug: varchar('slug', { length: 64 }).notNull().unique(), // e.g. mb-parfum
  name: text('name').notNull(),
  vertical: varchar('vertical', { length: 32 }).notNull(), // e.g. perfume
  status: recordStatus('status').notNull().default('draft'),
  defaultLocale: varchar('default_locale', { length: 16 })
    .notNull()
    .references(() => locales.code),
  defaultCurrency: char('default_currency', { length: 3 })
    .notNull()
    .references(() => currencies.code),
  ...timestamps,
});

export const storeLocales = pgTable(
  'store_locales',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    locale: varchar('locale', { length: 16 })
      .notNull()
      .references(() => locales.code),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.locale] })],
);

export const storeCurrencies = pgTable(
  'store_currencies',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.currency] })],
);

export const storeCountries = pgTable(
  'store_countries',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => countries.code),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.country] })],
);

export const vendors = pgTable('vendors', {
  id: id(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: text('name').notNull(),
  country: char('country', { length: 2 }).references(() => countries.code),
  status: recordStatus('status').notNull().default('draft'),
  ...timestamps,
});

/** Which vendors are allowed to sell in which store. */
export const storeVendors = pgTable(
  'store_vendors',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    commissionBps: integer('commission_bps').notNull().default(0), // 100 bps = 1 %
    status: recordStatus('status').notNull().default('active'),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.vendorId] })],
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const categories = pgTable(
  'categories',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    slug: varchar('slug', { length: 96 }).notNull(),
    position: integer('position').notNull().default(0),
    status: recordStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('categories_store_slug_uq').on(t.storeId, t.slug),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete('set null'),
  ],
);

export const categoryTranslations = pgTable(
  'category_translations',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    locale: varchar('locale', { length: 16 })
      .notNull()
      .references(() => locales.code),
    name: text('name').notNull(),
    description: text('description'),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.locale] })],
);

export const brands = pgTable(
  'brands',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('brands_store_slug_uq').on(t.storeId, t.slug)],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    slug: varchar('slug', { length: 128 }).notNull(),
    status: recordStatus('status').notNull().default('draft'),
    /** Vertical-specific data. For perfumes: { gender, concentration, notes: { top, heart, base } } */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('products_store_slug_uq').on(t.storeId, t.slug),
    index('products_store_status_idx').on(t.storeId, t.status),
    index('products_vendor_idx').on(t.vendorId),
  ],
);

export const productTranslations = pgTable(
  'product_translations',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    locale: varchar('locale', { length: 16 })
      .notNull()
      .references(() => locales.code),
    name: text('name').notNull(),
    description: text('description'),
  },
  (t) => [primaryKey({ columns: [t.productId, t.locale] })],
);

export const productCategories = pgTable(
  'product_categories',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.categoryId] }), index('product_categories_category_idx').on(t.categoryId)],
);

export const productImages = pgTable('product_images', {
  id: id(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  alt: text('alt'),
  position: integer('position').notNull().default(0),
});

export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: varchar('sku', { length: 64 }).notNull(),
    /** Variant options. For perfumes: { sizeMl: 100 } */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('product_variants_sku_uq').on(t.productId, t.sku),
    check('product_variants_stock_nonneg', sql`${t.stockQuantity} >= 0`),
  ],
);

/** One explicit price per variant per currency. No silent FX conversion. */
export const variantPrices = pgTable(
  'variant_prices',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    compareAtMinor: bigint('compare_at_minor', { mode: 'bigint' }),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.currency] }),
    check('variant_prices_amount_nonneg', sql`${t.amountMinor} >= 0`),
  ],
);
