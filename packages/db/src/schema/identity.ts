/**
 * One ARUMA identity per person, shared by every app (MB Parfum, MB Beauty…).
 * - users:    the person
 * - accounts: the ways they can sign in (password today; Google, phone OTP… later)
 * - devices:  the phones/browsers they use (future push notifications, fraud signals)
 * - sessions: opaque, revocable login tokens (only a SHA-256 hash is stored)
 */
import { sql } from 'drizzle-orm';
import { char, index, inet, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, timestamps } from './common.js';
import { countries, locales } from './reference.js';

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'deleted']);

export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 254 }), // stored lower-cased
    phone: varchar('phone', { length: 20 }), // E.164, e.g. +213555000000
    displayName: text('display_name').notNull(),
    locale: varchar('locale', { length: 16 }).references(() => locales.code),
    country: char('country', { length: 2 }).references(() => countries.code),
    status: userStatus('status').notNull().default('active'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email).where(sql`${t.email} is not null`),
    uniqueIndex('users_phone_uq').on(t.phone).where(sql`${t.phone} is not null`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(), // password | google | apple | phone
    providerAccountId: varchar('provider_account_id', { length: 254 }).notNull(),
    passwordHash: text('password_hash'), // only for provider = password
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_provider_uq').on(t.provider, t.providerAccountId),
    index('accounts_user_idx').on(t.userId),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientDeviceId: varchar('client_device_id', { length: 128 }), // sent by the app in X-Device-Id
    platform: varchar('platform', { length: 16 }).notNull().default('web'), // web | ios | android
    userAgent: text('user_agent'),
    pushToken: text('push_token'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('devices_user_client_uq')
      .on(t.userId, t.clientDeviceId)
      .where(sql`${t.clientDeviceId} is not null`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Set when the sign-in was confirmed with the second factor (authenticator code or recovery code). */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);
