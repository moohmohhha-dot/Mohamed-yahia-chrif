/**
 * Search index (PostgreSQL first; an external engine can later be fed from the same queue).
 * - search_documents: one row per product, denormalised for fast search (names in every language,
 *   brand, categories with their parents, sellers, lowest price per currency, rating, stock, popularity).
 * - search_queue: products whose document must be rebuilt, filled by database triggers on every table
 *   that changes what a customer sees (products, offers, prices, merchants, reviews…), so no code path
 *   can forget to update the index.
 * - search_terms: the vocabulary of a store, for typo correction and autocomplete.
 * - search_synonyms: groups of words that mean the same thing, across languages (عطر = parfum = perfume).
 * - search_queries: what customers search (no user id), for popular suggestions and "no result" reports.
 */
import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { products } from './catalog.js';
import { users } from './identity.js';
import { stores } from './tenancy.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const searchDocuments = pgTable(
  'search_documents',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references(() => products.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** Shown in search: active, not blocked, sold by at least one active, verified merchant. */
    visible: boolean('visible').notNull(),
    slug: varchar('slug', { length: 128 }).notNull(),
    names: jsonb('names').$type<Record<string, string>>().notNull(),
    image: jsonb('image').$type<{ url: string; alt: string | null } | null>(),
    brandId: uuid('brand_id'),
    brandSlug: varchar('brand_slug', { length: 96 }),
    brandName: text('brand_name'),
    /** The product's categories and all their parents. */
    categoryIds: uuid('category_ids').array().notNull().default(sql`'{}'`),
    merchantIds: uuid('merchant_ids').array().notNull().default(sql`'{}'`),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Lowest sellable price per currency, in minor units: { "DZD": 650000 }. */
    minPrices: jsonb('min_prices').$type<Record<string, number>>().notNull().default({}),
    inStock: boolean('in_stock').notNull().default(false),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2, mode: 'number' }),
    ratingCount: integer('rating_count').notNull().default(0),
    /** Units sold in the last 90 days. */
    popularity: integer('popularity').notNull().default(0),
    /** Normalised names, brand and categories (all languages): typo correction and autocomplete. */
    nameNorm: text('name_norm').notNull().default(''),
    tsv: tsvector('tsv').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('search_documents_store_idx').on(t.storeId, t.visible)],
);

export const searchQueue = pgTable('search_queue', {
  productId: uuid('product_id').primaryKey(),
  queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
});

export const searchTerms = pgTable(
  'search_terms',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    term: varchar('term', { length: 96 }).notNull(),
    /** Number of visible products containing it. */
    docs: integer('docs').notNull(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.term] })],
);

export const searchSynonyms = pgTable(
  'search_synonyms',
  {
    id: id(),
    /** Null: every store. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    /** Single words that mean the same, in any language, as entered (normalised when used). */
    terms: text('terms').array().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('search_synonyms_store_idx').on(t.storeId)],
);

export const searchQueries = pgTable(
  'search_queries',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** Normalised text, without personal data (no user, no IP). */
    query: varchar('query', { length: 200 }).notNull(),
    locale: varchar('locale', { length: 16 }),
    results: integer('results').notNull(),
    /** typed | voice | suggestion */
    source: varchar('source', { length: 16 }).notNull().default('typed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('search_queries_store_idx').on(t.storeId, t.createdAt)],
);
