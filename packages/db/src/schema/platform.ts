/** Cross-cutting platform tables: audit trail, domain events (outbox), feature flags. */
import { sql } from 'drizzle-orm';
import { boolean, char, index, inet, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, timestamps } from './common.js';
import { users } from './identity.js';
import { stores } from './tenancy.js';

export const actorType = pgEnum('actor_type', ['user', 'system']);

/** Append-only record of who did what. Never updated or deleted by the application. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 96 }).notNull(), // e.g. merchant.verification.approved
    entityType: varchar('entity_type', { length: 48 }).notNull(),
    entityId: text('entity_id').notNull(),
    ip: inet('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.entityType, t.entityId), index('audit_logs_actor_idx').on(t.actorUserId)],
);

/**
 * Transactional outbox. Written in the same transaction as the change it describes,
 * then consumed by notifications, webhooks, search indexing, analytics — or by a
 * separate service if one is ever extracted.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: id(),
    type: varchar('type', { length: 96 }).notNull(), // e.g. identity.user.registered
    aggregateType: varchar('aggregate_type', { length: 48 }).notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('domain_events_unpublished_idx').on(t.occurredAt).where(sql`${t.publishedAt} is null`)],
);

export const featureFlags = pgTable('feature_flags', {
  key: varchar('key', { length: 96 }).primaryKey(), // e.g. checkout.cash_on_delivery
  description: text('description').notNull(),
  enabledByDefault: boolean('enabled_by_default').notNull().default(false),
  ...timestamps,
});

/** Per-store override, so a feature can be switched on for MB Parfum before other apps. */
export const featureFlagOverrides = pgTable(
  'feature_flag_overrides',
  {
    flagKey: varchar('flag_key', { length: 96 })
      .notNull()
      .references(() => featureFlags.key, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [primaryKey({ columns: [t.flagKey, t.storeId] })],
);

/**
 * One-time codes sent by SMS or email to prove control of a phone number or email address.
 * Only a hash of the code is stored.
 */
export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: id(),
    purpose: varchar('purpose', { length: 48 }).notNull(), // e.g. merchant.phone
    subjectId: text('subject_id').notNull(), // e.g. the merchant id
    target: varchar('target', { length: 254 }).notNull(), // phone number or email address
    codeHash: char('code_hash', { length: 64 }).notNull(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_codes_subject_idx').on(t.purpose, t.subjectId, t.createdAt)],
);
