/**
 * Dispute Center: disagreements between a customer and a merchant (opened by either), or between a
 * merchant and ARUMA. Parties exchange messages, evidence and documents; ARUMA decides; the party that
 * did not win may appeal once, to a different ARUMA administrator; the resolution (refund, store
 * credit, compensation to the merchant) is then executed. Everything is recorded and nothing is deleted.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, orderActorType } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { orders } from './orders.js';
import { currencies } from './reference.js';
import { returnRequests } from './returns.js';

export const disputeKind = pgEnum('dispute_kind', ['customer_merchant', 'merchant_customer', 'merchant_aruma']);
export const disputeStatus = pgEnum('dispute_status', [
  'open', // parties discuss; the other party has a deadline to answer
  'under_review', // ARUMA is reviewing (asked by a party, or no answer in time)
  'decided', // ARUMA decided; the appeal window is open
  'appealed', // a party appealed; another ARUMA administrator reviews
  'resolved', // final: the decision (or appeal decision) is executed
  'withdrawn', // the claimant closed it (e.g. settled between the parties)
]);
export const disputeOutcome = pgEnum('dispute_outcome', ['claimant', 'respondent', 'partial']);
export const disputeRemedy = pgEnum('dispute_remedy', ['none', 'refund', 'store_credit', 'merchant_compensation']);
export const disputeExecution = pgEnum('dispute_execution', ['none', 'pending', 'done']);

export const disputes = pgTable(
  'disputes',
  {
    id: id(),
    /** Shown to every party, e.g. DS-2026-000003. */
    number: varchar('number', { length: 32 }).notNull().unique(),
    kind: disputeKind('kind').notNull(),
    /** e.g. item_not_received, false_claim, commission, payout… */
    category: varchar('category', { length: 48 }).notNull(),
    status: disputeStatus('status').notNull().default('open'),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    /** The customer party (null for merchant ↔ ARUMA). */
    customerUserId: uuid('customer_user_id').references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').references(() => returnRequests.id, { onDelete: 'restrict' }),
    /** Other things the dispute is about (payout, settlement, review…), by id. */
    references: jsonb('references').$type<Record<string, string>>().notNull().default({}),
    subject: varchar('subject', { length: 160 }).notNull(),
    description: text('description').notNull(),
    requestedRemedy: disputeRemedy('requested_remedy').notNull().default('none'),
    requestedAmountMinor: bigint('requested_amount_minor', { mode: 'bigint' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    respondDueAt: timestamp('respond_due_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalationReason: text('escalation_reason'),
    // Decision
    outcome: disputeOutcome('outcome'),
    remedy: disputeRemedy('remedy'),
    remedyAmountMinor: bigint('remedy_amount_minor', { mode: 'bigint' }),
    decisionText: text('decision_text'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    appealDueAt: timestamp('appeal_due_at', { withTimezone: true }),
    // Appeal (once)
    appealedBy: uuid('appealed_by').references(() => users.id, { onDelete: 'restrict' }),
    appealedAt: timestamp('appealed_at', { withTimezone: true }),
    appealReason: text('appeal_reason'),
    appealOutcome: varchar('appeal_outcome', { length: 16 }), // upheld | overturned | modified
    /** The outcome after the appeal (the first decision's outcome stays as it was). */
    appealNewOutcome: disputeOutcome('appeal_new_outcome'),
    appealDecisionText: text('appeal_decision_text'),
    appealDecidedBy: uuid('appeal_decided_by').references(() => users.id, { onDelete: 'restrict' }),
    appealDecidedAt: timestamp('appeal_decided_at', { withTimezone: true }),
    // Execution of the final resolution
    executionStatus: disputeExecution('execution_status').notNull().default('none'),
    paymentRefundId: varchar('payment_refund_id', { length: 64 }),
    executionReference: varchar('execution_reference', { length: 128 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('disputes_merchant_idx').on(t.merchantId, t.status, t.createdAt),
    index('disputes_customer_idx').on(t.customerUserId, t.createdAt),
    index('disputes_status_idx').on(t.status, t.createdAt),
    index('disputes_order_idx').on(t.orderId),
    // An appeal is never decided by the administrator who made the first decision.
    check('disputes_appeal_other_admin', sql`${t.appealDecidedBy} is null or ${t.appealDecidedBy} <> ${t.decidedBy}`),
    check('disputes_parties', sql`(${t.kind} = 'merchant_aruma') = (${t.customerUserId} is null)`),
    check('disputes_amounts', sql`(${t.requestedAmountMinor} is null or ${t.requestedAmountMinor} >= 0) and (${t.remedyAmountMinor} is null or ${t.remedyAmountMinor} >= 0)`),
  ],
);

export const disputeMessages = pgTable(
  'dispute_messages',
  {
    id: id(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    authorType: orderActorType('author_type').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    /** ARUMA internal note: never shown to the customer or the merchant. */
    internal: boolean('internal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('dispute_messages_dispute_idx').on(t.disputeId, t.createdAt)],
);

export const disputeFileKind = pgEnum('dispute_file_kind', ['evidence', 'document']);

/** Photos (evidence) and documents (invoices, statements, transfer receipts), encrypted at rest. */
export const disputeFiles = pgTable(
  'dispute_files',
  {
    id: id(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id').references(() => disputeMessages.id, { onDelete: 'restrict' }),
    kind: disputeFileKind('kind').notNull(),
    uploaderType: orderActorType('uploader_type').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'restrict' }),
    /** ARUMA internal file. */
    internal: boolean('internal').notNull().default(false),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name'),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dispute_files_dispute_idx').on(t.disputeId)],
);

export const disputeEventType = pgEnum('dispute_event_type', [
  'opened',
  'message',
  'file_added',
  'responded',
  'escalated',
  'decided',
  'accepted',
  'appealed',
  'appeal_decided',
  'executed',
  'execution_recorded',
  'resolved',
  'withdrawn',
]);

/** Audit trail of a dispute. Append-only. */
export const disputeEvents = pgTable(
  'dispute_events',
  {
    id: id(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    type: disputeEventType('type').notNull(),
    fromStatus: disputeStatus('from_status'),
    toStatus: disputeStatus('to_status'),
    actorType: orderActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    note: text('note'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('dispute_events_dispute_idx').on(t.disputeId, t.createdAt)],
);
