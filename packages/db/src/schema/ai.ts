/**
 * AI layer (optional): nothing here is needed for ARUMA to work.
 * - ai_requests: one row per call to the AI provider (or per call it refused: switched off, budget,
 *   timeout…), for costs, quality and audits. The prompt and the answer are NOT stored: no customer
 *   text is kept by the AI layer.
 * - ai_cache: answers that can be reused (a product's review summary, a comparison) until their inputs
 *   change or they expire, so the same work is not paid twice.
 */
import { char, index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { stores } from './tenancy.js';

export const aiRequests = pgTable(
  'ai_requests',
  {
    id: id(),
    /** Feature key, e.g. review_summaries (docs/AI.md). */
    feature: varchar('feature', { length: 48 }).notNull(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 64 }),
    /** ok, or why the answer was not used: error, invalid, timeout, budget, limit. */
    status: varchar('status', { length: 16 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_requests_created_idx').on(t.createdAt),
    index('ai_requests_feature_idx').on(t.feature, t.createdAt),
    index('ai_requests_user_idx').on(t.userId, t.createdAt),
  ],
);

export const aiCache = pgTable(
  'ai_cache',
  {
    /** sha256 of the feature, the subject and a fingerprint of the inputs. */
    key: char('key', { length: 64 }).primaryKey(),
    feature: varchar('feature', { length: 48 }).notNull(),
    value: jsonb('value').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_cache_expires_idx').on(t.expiresAt)],
);
