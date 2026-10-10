/** Stores are the ARUMA apps (MB Parfum, MB Beauty…). Everything commercial is scoped to one. */
import { char, pgTable, primaryKey, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { countries, currencies, locales } from './reference.js';

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
