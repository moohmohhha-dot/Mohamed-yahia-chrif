/**
 * Payments service data, in its own Postgres schema ("payments"). ARUMA CORE never reads these tables:
 * it talks to the service over its API and receives signed events.
 *
 * No card data is ever stored here: customers type card details on the provider's page
 * (e.g. Chargily for CIB / Edahabia). ARUMA only keeps the provider's payment id, amounts and statuses.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const payments = pgSchema('payments');

export const paymentStatus = payments.enum('payment_status', ['pending', 'successful', 'failed', 'cancelled', 'refunded']);
export const paymentMethod = payments.enum('payment_method', ['online', 'cash_on_delivery']);
export const refundStatus = payments.enum('refund_status', ['pending', 'successful', 'failed']);
export const refundMethod = payments.enum('refund_method', ['provider', 'manual']);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** What has to be paid, for what, and where it stands. One intent can have several attempts (retries). */
export const paymentIntents = payments.table(
  'payment_intents',
  {
    id: id(),
    /** Who asked (e.g. "aruma-core") and for what (e.g. checkout <id>, order <id>). */
    client: varchar('client', { length: 32 }).notNull(),
    referenceType: varchar('reference_type', { length: 32 }).notNull(),
    referenceId: varchar('reference_id', { length: 128 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    method: paymentMethod('method').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(), // chargily | cash_on_delivery | sandbox
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    /** Sum of successful refunds. Partial refunds keep the status "successful". */
    refundedMinor: bigint('refunded_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    description: text('description'),
    returnUrl: text('return_url'),
    failureUrl: text('failure_url'),
    locale: varchar('locale', { length: 8 }),
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('payment_intents_idempotency_uq').on(t.client, t.idempotencyKey),
    index('payment_intents_reference_idx').on(t.referenceType, t.referenceId),
    check('payment_intents_amount_positive', sql`${t.amountMinor} > 0`),
    check('payment_intents_refund_bounds', sql`${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor}`),
  ],
);

/** One try at the provider (a hosted checkout page). A retry creates a new attempt. */
export const paymentAttempts = payments.table(
  'payment_attempts',
  {
    id: id(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'restrict' }),
    number: integer('number').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerPaymentId: varchar('provider_payment_id', { length: 128 }),
    redirectUrl: text('redirect_url'),
    status: paymentStatus('status').notNull().default('pending'),
    providerStatus: varchar('provider_status', { length: 32 }),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('payment_attempts_number_uq').on(t.intentId, t.number),
    uniqueIndex('payment_attempts_provider_id_uq').on(t.provider, t.providerPaymentId),
  ],
);

export const refunds = payments.table(
  'refunds',
  {
    id: id(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'restrict' }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    method: refundMethod('method').notNull(),
    status: refundStatus('status').notNull().default('pending'),
    /** Provider refund id, or for manual refunds the proof (bank transfer / cash receipt reference). */
    externalReference: varchar('external_reference', { length: 128 }),
    requestedBy: varchar('requested_by', { length: 128 }).notNull(),
    /** Optional: which part of the payment this refund is for (e.g. one order of a checkout). */
    scope: varchar('scope', { length: 128 }),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('refunds_idempotency_uq').on(t.intentId, t.idempotencyKey),
    check('refunds_amount_positive', sql`${t.amountMinor} > 0`),
  ],
);

/** Every webhook received, valid or not. Duplicates (same provider event id) are processed once. */
export const webhookEvents = payments.table(
  'webhook_events',
  {
    id: id(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 128 }),
    eventType: varchar('event_type', { length: 64 }),
    signatureValid: integer('signature_valid').notNull(), // 1 / 0
    payload: jsonb('payload').$type<unknown>(),
    receivedAt: createdAt(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [uniqueIndex('webhook_events_provider_event_uq').on(t.provider, t.providerEventId)],
);

/** Append-only status history of every intent (database trigger, migration 0001). */
export const statusHistory = payments.table(
  'status_history',
  {
    id: id(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'restrict' }),
    fromStatus: paymentStatus('from_status'),
    toStatus: paymentStatus('to_status').notNull(),
    source: varchar('source', { length: 32 }).notNull(), // api | webhook | verification | cod | refund | expiry
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('status_history_intent_idx').on(t.intentId, t.createdAt)],
);

/** Events for the client (ARUMA CORE), delivered with retries and an HMAC signature. */
export const outboundEvents = payments.table(
  'outbound_events',
  {
    id: id(),
    client: varchar('client', { length: 32 }).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('outbound_events_due_idx').on(t.nextAttemptAt).where(sql`${t.deliveredAt} is null`)],
);
