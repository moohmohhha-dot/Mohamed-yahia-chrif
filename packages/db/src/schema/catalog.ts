/**
 * Catalog: WHAT is sold in a store (products, variants, categories, brands, translations).
 * Prices and stock are NOT here — they belong to merchant offers (offers.ts).
 * Vertical-specific fields (perfume notes, concentration…) live in `attributes` JSONB.
 */
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { locales } from './reference.js';
import { stores } from './tenancy.js';

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
    /** Merchant that created the listing (for moderation). Selling happens through offers. */
    createdByMerchantId: uuid('created_by_merchant_id').references(() => merchants.id, { onDelete: 'set null' }),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    slug: varchar('slug', { length: 128 }).notNull(),
    status: recordStatus('status').notNull().default('draft'),
    /** Vertical-specific data. For perfumes: { gender, concentration, notes: { top, heart, base } } */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Taken off sale by ARUMA (moderation): the merchant cannot publish it again until ARUMA unblocks it. */
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedBy: uuid('blocked_by').references(() => users.id, { onDelete: 'restrict' }),
    blockReason: text('block_reason'),
    /** The status to restore when unblocked. */
    blockedFromStatus: recordStatus('blocked_from_status'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('products_store_slug_uq').on(t.storeId, t.slug),
    index('products_store_status_idx').on(t.storeId, t.status),
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
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('product_variants_sku_uq').on(t.productId, t.sku),
  ],
);
