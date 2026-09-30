/** Merchants (sellers), their staff, their verification, and which stores they may sell in. */
import { char, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { users } from './identity.js';
import { countries } from './reference.js';
import { stores } from './tenancy.js';

export const verificationStatus = pgEnum('verification_status', ['unverified', 'pending', 'verified', 'rejected']);
export const merchantRole = pgEnum('merchant_role', ['owner', 'manager', 'staff']);

export const merchants = pgTable('merchants', {
  id: id(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  country: char('country', { length: 2 }).references(() => countries.code),
  contactEmail: varchar('contact_email', { length: 254 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  status: recordStatus('status').notNull().default('draft'),
  verificationStatus: verificationStatus('verification_status').notNull().default('unverified'),
  verificationSubmittedAt: timestamp('verification_submitted_at', { withTimezone: true }),
  verificationDecidedAt: timestamp('verification_decided_at', { withTimezone: true }),
  verificationNote: text('verification_note'),
  ...timestamps,
});

export const merchantMembers = pgTable(
  'merchant_members',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: merchantRole('role').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.userId] })],
);

/** Which merchants may sell in which store, and the platform commission. */
export const storeMerchants = pgTable(
  'store_merchants',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    commissionBps: integer('commission_bps').notNull().default(0), // 100 bps = 1 %
    status: recordStatus('status').notNull().default('active'),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.merchantId] })],
);
