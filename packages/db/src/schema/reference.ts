/** Global reference data shared by every ARUMA app. */
import { char, pgTable, smallint, text, varchar } from 'drizzle-orm/pg-core';

export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(), // ISO 4217, e.g. DZD
  name: text('name').notNull(),
  minorUnits: smallint('minor_units').notNull(), // DZD = 2, XOF = 0, KWD = 3
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
