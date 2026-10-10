/**
 * Two-step verification (MFA) with an authenticator app (TOTP, RFC 6238): Google Authenticator,
 * Microsoft Authenticator, Aegis, 2FAS… No SMS: codes are computed on the phone, offline and free.
 * Mandatory for ARUMA staff, optional for customers and merchants.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';

export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The shared TOTP secret, encrypted (AES-256-GCM). */
  secretEncrypted: text('secret_encrypted').notNull(),
  /** Null while being set up: becomes active once a first code is confirmed. */
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  /** Last accepted 30-second step: a code is never accepted twice (replay). */
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use codes for a lost phone. Only a hash is stored. */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

/** A password accepted, waiting for the second factor: short-lived, few attempts. */
export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('mfa_challenges_user_idx').on(t.userId)],
);
