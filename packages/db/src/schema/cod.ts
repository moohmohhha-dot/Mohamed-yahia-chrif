/**
 * Cash on delivery (COD): confirming the order with the customer before preparing it, the amount the
 * driver must collect, delivery attempts, refusals at the door, where the cash is (with the courier or
 * with the merchant), and the customer's track record used for risk signals.
 *
 * The money itself never passes through ARUMA: the customer pays the driver, and the courier pays the
 * merchant. ARUMA records what was collected and what the courier says it paid (remittances), so the
 * merchant can check that every dinar came back.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { checkouts, orderActorType, orders } from './orders.js';
import { currencies } from './reference.js';
import { couriers } from './shipping.js';
import { stores } from './tenancy.js';

export const codConfirmationStatus = pgEnum('cod_confirmation_status', [
  'pending', // waiting for the customer's SMS code or the merchant's call
  'confirmed',
  'declined', // the customer said no
  'unreachable', // no answer after the allowed number of calls, or wrong number
  'not_required', // the store's policy does not ask for confirmation
]);
export const codConfirmationChannel = pgEnum('cod_confirmation_channel', ['sms_code', 'phone_call', 'platform']);
export const codCollectionStatus = pgEnum('cod_collection_status', [
  'awaiting', // not delivered yet
  'with_courier', // the courier collected the cash and has not paid the merchant yet
  'with_merchant', // the merchant has the cash (own delivery, shop pickup, or courier paid)
  'not_collected', // cancelled, refused or returned
]);
export const codOutcome = pgEnum('cod_outcome', ['open', 'delivered', 'refused', 'failed', 'cancelled']);
export const codEventType = pgEnum('cod_event_type', [
  'created',
  'code_sent',
  'confirmed',
  'call',
  'declined',
  'unreachable',
  'delivery_failed',
  'reattempt_scheduled',
  'refused',
  'collected',
  'remitted',
  'not_collected',
]);

/** COD rules: one platform row (storeId null) and optional per-store overrides. */
export const codPolicies = pgTable(
  'cod_policies',
  {
    id: id(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    /** COD orders must be confirmed (SMS code or call) before the merchant prepares them. */
    requireConfirmation: boolean('require_confirmation').notNull().default(true),
    /** Calls without an answer before the order is cancelled as unreachable. */
    maxCallAttempts: smallint('max_call_attempts').notNull().default(3),
    /** Delivery attempts before the parcel must go back to the merchant. */
    maxDeliveryAttempts: smallint('max_delivery_attempts').notNull().default(3),
    /** Refusals at the door after which COD is no longer offered to that phone/customer (0 = never). */
    blockAfterRefusals: smallint('block_after_refusals').notNull().default(3),
    /** Largest order total accepted in cash (null = no limit). */
    maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cod_policies_store_uq').on(t.storeId).nullsNotDistinct(),
    check('cod_policies_limits', sql`${t.maxCallAttempts} between 1 and 10 and ${t.maxDeliveryAttempts} between 1 and 10 and ${t.blockAfterRefusals} >= 0`),
  ],
);

export type CodRisk = {
  level: 'low' | 'medium' | 'high';
  score: number;
  reasons: { code: string; count?: number }[];
};

/** One row per cash-on-delivery order: its confirmation, delivery attempts and collection. */
export const codOrders = pgTable(
  'cod_orders',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id, { onDelete: 'restrict' }),
    checkoutId: uuid('checkout_id')
      .notNull()
      .references(() => checkouts.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The delivery phone, international format: risk signals follow the phone, not only the account. */
    phone: varchar('phone', { length: 20 }).notNull(),
    /** Cash the driver must collect. */
    amountDueMinor: bigint('amount_due_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    confirmationStatus: codConfirmationStatus('confirmation_status').notNull(),
    confirmedVia: codConfirmationChannel('confirmed_via'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'restrict' }),
    callAttempts: smallint('call_attempts').notNull().default(0),
    deliveryAttempts: smallint('delivery_attempts').notNull().default(0),
    lastFailureReason: varchar('last_failure_reason', { length: 48 }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    refusalReason: varchar('refusal_reason', { length: 48 }),
    collectionStatus: codCollectionStatus('collection_status').notNull().default('awaiting'),
    collectedAmountMinor: bigint('collected_amount_minor', { mode: 'bigint' }),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    remittanceId: uuid('remittance_id').references(() => codRemittances.id, { onDelete: 'restrict' }),
    outcome: codOutcome('outcome').notNull().default('open'),
    /** Risk signals when the order was placed (kept, so later history does not rewrite it). */
    risk: jsonb('risk').$type<CodRisk>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('cod_orders_phone_idx').on(t.phone),
    index('cod_orders_customer_idx').on(t.customerUserId),
    index('cod_orders_merchant_collection_idx').on(t.merchantId, t.collectionStatus),
    index('cod_orders_checkout_idx').on(t.checkoutId),
  ],
);

/** Everything that happened to a COD order: calls, codes, attempts, refusals, collection. Append-only. */
export const codEvents = pgTable(
  'cod_events',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => codOrders.orderId, { onDelete: 'restrict' }),
    type: codEventType('type').notNull(),
    /** Call outcome, failure or refusal reason code. */
    reason: varchar('reason', { length: 48 }),
    note: text('note'),
    actorType: orderActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** clock_timestamp(): several events of one transaction keep their order. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('cod_events_order_idx').on(t.orderId, t.createdAt)],
);

/** A courier paying the merchant the cash it collected for a set of orders. Append-only. */
export const codRemittances = pgTable(
  'cod_remittances',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    courierCode: varchar('courier_code', { length: 32 }).references(() => couriers.code),
    /** The courier's payment reference (transfer or statement number). */
    reference: varchar('reference', { length: 100 }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    collectedMinor: bigint('collected_minor', { mode: 'bigint' }).notNull(),
    courierFeesMinor: bigint('courier_fees_minor', { mode: 'bigint' }).notNull(),
    receivedMinor: bigint('received_minor', { mode: 'bigint' }).notNull(),
    orderCount: integer('order_count').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cod_remittances_reference_uq').on(t.merchantId, t.courierCode, t.reference).nullsNotDistinct(),
    check('cod_remittances_amounts', sql`${t.receivedMinor} = ${t.collectedMinor} - ${t.courierFeesMinor} and ${t.courierFeesMinor} >= 0`),
  ],
);

/** Phones that may not use COD, set by ARUMA staff. Lifted, never deleted. */
export const codBlocks = pgTable(
  'cod_blocks',
  {
    id: id(),
    phone: varchar('phone', { length: 20 }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: uuid('lifted_by').references(() => users.id, { onDelete: 'restrict' }),
    liftReason: text('lift_reason'),
  },
  (t) => [uniqueIndex('cod_blocks_active_phone_uq').on(t.phone).where(sql`${t.liftedAt} is null`)],
);
