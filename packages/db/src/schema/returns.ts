/**
 * Returns: the customer asks to return items of a delivered order (with a reason and evidence), the
 * merchant answers, ARUMA reviews disputes, the item comes back (pickup or drop-off), the merchant
 * inspects it, and the customer gets a refund (full or partial), a replacement or store credit.
 *
 * Every step is recorded in return_events (append-only): who, when, from which status to which, why.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, orderActorType } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { orderLines, orders } from './orders.js';
import { currencies } from './reference.js';
import { stores } from './tenancy.js';

export const returnStatus = pgEnum('return_status', [
  'draft', // being prepared by the customer (evidence upload)
  'requested', // waiting for the merchant's answer
  'under_review', // ARUMA is reviewing (escalated by the customer, or the merchant did not answer in time)
  'approved', // accepted: waiting for the item to come back (or resolved directly when the customer keeps it)
  'rejected', // refused (by the merchant: the customer may escalate; by ARUMA: final)
  'cancelled', // withdrawn by the customer
  'in_transit', // the item is on its way back
  'received', // back with the merchant, waiting for inspection
  'inspection_failed', // the item is not as the customer described (the customer may escalate)
  'refund_pending', // resolved with a refund that must be sent by hand (cash-on-delivery orders)
  'completed', // refund sent, credit given or replacement created
]);
export const returnReason = pgEnum('return_reason', [
  'damaged', // arrived damaged
  'defective', // does not work / leaks
  'wrong_item', // not what was ordered (other product, size)
  'not_as_described',
  'missing_parts',
  'counterfeit_suspected',
  'changed_mind',
  'other',
]);
export const returnResolution = pgEnum('return_resolution', ['refund', 'replacement', 'store_credit']);
export const returnMethod = pgEnum('return_method', ['pickup', 'drop_off', 'keep_item']);
export const returnEventType = pgEnum('return_event_type', [
  'created',
  'submitted',
  'evidence_added',
  'merchant_approved',
  'merchant_rejected',
  'escalated',
  'admin_approved',
  'admin_rejected',
  'cancelled',
  'pickup_created',
  'shipped_back',
  'received',
  'inspected',
  'refunded',
  'refund_recorded',
  'credited',
  'replacement_created',
  'note',
]);

/** Return rules: a platform default (storeId null) and optional per-store overrides. */
export const returnPolicies = pgTable(
  'return_policies',
  {
    id: id(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    /** Days after delivery during which a return can be requested. */
    windowDays: smallint('window_days').notNull().default(7),
    /** Hours the merchant has to answer before ARUMA takes over. */
    merchantResponseHours: smallint('merchant_response_hours').notNull().default(48),
    /** Days the customer has to escalate a rejection to ARUMA. */
    escalationDays: smallint('escalation_days').notNull().default(7),
    /** Returns for a change of mind (the item must come back unopened). */
    allowChangeOfMind: boolean('allow_change_of_mind').notNull().default(true),
    /** Deducted from the refund of a change-of-mind return (return shipping), never for the merchant's fault. */
    changeOfMindFeeMinor: bigint('change_of_mind_fee_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('return_policies_store_uq').on(t.storeId).nullsNotDistinct(),
    check('return_policies_limits', sql`${t.windowDays} between 1 and 90 and ${t.merchantResponseHours} between 1 and 720 and ${t.escalationDays} between 1 and 60 and ${t.changeOfMindFeeMinor} >= 0`),
  ],
);

export const returnRequests = pgTable(
  'return_requests',
  {
    id: id(),
    /** Shown to customers and merchants, e.g. RT-2026-000012. */
    number: varchar('number', { length: 32 }).notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: returnStatus('status').notNull().default('draft'),
    reason: returnReason('reason').notNull(),
    description: text('description').notNull(),
    /** What the customer asks for. */
    requestedResolution: returnResolution('requested_resolution').notNull(),
    /** What was approved (by the merchant or ARUMA). */
    resolution: returnResolution('resolution'),
    returnMethod: returnMethod('return_method'),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Value of the returned items (+ delivery when it is the merchant's fault and everything comes back). */
    itemsValueMinor: bigint('items_value_minor', { mode: 'bigint' }).notNull(),
    /** What the customer is due if the item passes inspection (value minus a change-of-mind fee). */
    approvedAmountMinor: bigint('approved_amount_minor', { mode: 'bigint' }),
    /** What was finally given back (money or credit); lower than approved = partial refund. */
    finalAmountMinor: bigint('final_amount_minor', { mode: 'bigint' }),
    partialReason: text('partial_reason'),
    responseDueAt: timestamp('response_due_at', { withTimezone: true }),
    merchantNote: text('merchant_note'),
    merchantRespondedAt: timestamp('merchant_responded_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalationReason: text('escalation_reason'),
    adminNote: text('admin_note'),
    adminDecidedAt: timestamp('admin_decided_at', { withTimezone: true }),
    /** A decision by ARUMA is final (no further escalation). */
    finalDecision: boolean('final_decision').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    inspectionNote: text('inspection_note'),
    replacementOrderId: uuid('replacement_order_id').references(() => orders.id, { onDelete: 'restrict' }),
    paymentRefundId: varchar('payment_refund_id', { length: 64 }),
    refundReference: varchar('refund_reference', { length: 128 }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('return_requests_merchant_idx').on(t.merchantId, t.status, t.createdAt),
    index('return_requests_customer_idx').on(t.customerUserId, t.createdAt),
    index('return_requests_order_idx').on(t.orderId),
    index('return_requests_due_idx').on(t.status, t.responseDueAt),
    check('return_requests_amounts', sql`${t.itemsValueMinor} > 0 and (${t.finalAmountMinor} is null or ${t.finalAmountMinor} >= 0)`),
  ],
);

/** Items being returned (part of an order line is allowed). */
export const returnLines = pgTable(
  'return_lines',
  {
    id: id(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'restrict' }),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    /** Set at inspection: the item goes back on sale (true) or not (false, e.g. opened or damaged). */
    restock: boolean('restock'),
  },
  (t) => [unique('return_lines_line_uq').on(t.returnId, t.orderLineId), check('return_lines_quantity', sql`${t.quantity} > 0`)],
);

export const evidenceRole = pgEnum('return_evidence_role', ['customer', 'merchant', 'platform']);

/** Photos and documents (encrypted at rest). Never deleted. */
export const returnEvidence = pgTable(
  'return_evidence',
  {
    id: id(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'restrict' }),
    role: evidenceRole('role').notNull(),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name'),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('return_evidence_return_idx').on(t.returnId)],
);

/** Everything that happened to a return. Append-only. */
export const returnEvents = pgTable(
  'return_events',
  {
    id: id(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'restrict' }),
    type: returnEventType('type').notNull(),
    fromStatus: returnStatus('from_status'),
    toStatus: returnStatus('to_status'),
    actorType: orderActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    note: text('note'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('return_events_return_idx').on(t.returnId, t.createdAt)],
);

