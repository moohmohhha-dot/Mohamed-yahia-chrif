/**
 * Orders. A customer checkout can contain items from several merchants; it creates one order per
 * merchant (sharing a checkout id), because each merchant prepares and ships its own parcel.
 *
 * Status changes are only allowed along the transitions in apps/core/src/modules/orders/transitions.ts,
 * enforced again by a database trigger (migration 0005). Every change is recorded in
 * order_status_history (append-only): who, when, from, to, and why.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, orderActorType } from './common.js';

export { orderActorType };
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { offers } from './offers.js';
import { currencies } from './reference.js';
import { stores } from './tenancy.js';
import { productVariants } from './catalog.js';
import { shippingMethods } from './shipping.js';

export const orderStatus = pgEnum('order_status', [
  'new', // placed by the customer, stock reserved
  'processing', // confirmed by the merchant (e.g. phone confirmation for cash on delivery)
  'preparing', // being packed
  'shipping', // handed to the carrier; stock leaves the warehouse
  'delivered', // received by the customer
  'cancelled', // stopped before shipping; reserved stock released
  'returned', // refused at delivery or returned after it
  'refunded', // money given back (platform only)
]);
export const paymentMethod = pgEnum('payment_method', ['cash_on_delivery', 'online']);
/** Mirrors the Payment Service's status for this order's money (kept in sync by signed payment events). */
export const orderPaymentStatus = pgEnum('order_payment_status', ['pending', 'successful', 'failed', 'cancelled', 'refunded']);

/** One checkout submission; makes "place order" safe to retry (Idempotency-Key). */
export const checkouts = pgTable(
  'checkouts',
  {
    id: id(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('checkouts_customer_key_uq').on(t.customerUserId, t.idempotencyKey)],
);

/**
 * Delivery address, frozen in the order. For countries with administrative areas (Algeria), the ids are
 * checked by the server and the names are filled from them: region = Wilaya, district = Daïra,
 * city = Commune.
 */
export type ShippingAddress = {
  fullName: string;
  phone: string;
  country: string;
  regionId?: string;
  region: string;
  districtId?: string;
  district?: string;
  cityId?: string;
  city: string;
  line1: string;
  line2?: string;
  postalCode?: string;
  deliveryNotes?: string;
};

/** How the order is delivered, frozen at checkout (later changes to the method do not alter it). */
export type OrderDelivery = {
  methodId: string;
  type: 'merchant_delivery' | 'courier' | 'local_pickup' | 'pickup_point';
  name: string;
  courierCode: string | null;
  courierName: string | null;
  minDays: number;
  maxDays: number;
  pickupLocation?: { address: string; hours?: string; phone?: string } | null;
  pickupPoint?: { id: string; name: string; address: string; hours?: string | null } | null;
};

export const orders = pgTable(
  'orders',
  {
    id: id(),
    /** Human-readable number shown to customers and merchants, e.g. 2026-000042. */
    number: varchar('number', { length: 32 }).notNull().unique(),
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
    status: orderStatus('status').notNull().default('new'),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
    shippingMinor: bigint('shipping_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    /** ARUMA commission at the time of the order (finance uses this, not today's rate). */
    commissionBps: integer('commission_bps').notNull(),
    /** Per-order fee charged to the merchant, fixed at the time of the order. */
    merchantFeeMinor: bigint('merchant_fee_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    paymentMethod: paymentMethod('payment_method').notNull(),
    paymentStatus: orderPaymentStatus('payment_status').notNull().default('pending'),
    /** Id of the payment in the Payment Service: one per checkout for online, one per order for cash. */
    paymentIntentId: varchar('payment_intent_id', { length: 64 }),
    /** Money given back for this order so far (partial or full refunds). */
    refundedMinor: bigint('refunded_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Part of the total paid with the customer's store credit (the rest is paid online or in cash). */
    creditAppliedMinor: bigint('credit_applied_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Value given back to the customer as store credit (restored credit, or a return resolved with credit). */
    creditReturnedMinor: bigint('credit_returned_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    /** A free replacement sent for an item returned from this earlier order. */
    replacementForOrderId: uuid('replacement_for_order_id').references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    shippingAddress: jsonb('shipping_address').$type<ShippingAddress>().notNull(),
    shippingMethodId: uuid('shipping_method_id').references((): AnyPgColumn => shippingMethods.id, { onDelete: 'restrict' }),
    delivery: jsonb('delivery').$type<OrderDelivery>(),
    customerNote: text('customer_note'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_merchant_status_idx').on(t.merchantId, t.status, t.placedAt),
    index('orders_customer_idx').on(t.customerUserId, t.placedAt),
    index('orders_checkout_idx').on(t.checkoutId),
    check('orders_total_consistent', sql`${t.totalMinor} = ${t.subtotalMinor} + ${t.shippingMinor}`),
    // Money refunded can never exceed what was paid in money; money + credit given back never exceed the total.
    check(
      'orders_refund_bounds',
      sql`${t.refundedMinor} >= 0 and ${t.creditReturnedMinor} >= 0 and ${t.creditAppliedMinor} >= 0 and ${t.creditAppliedMinor} <= ${t.totalMinor} and ${t.refundedMinor} <= ${t.totalMinor} - ${t.creditAppliedMinor} and ${t.refundedMinor} + ${t.creditReturnedMinor} <= ${t.totalMinor}`,
    ),
  ],
);

/** What was bought, frozen at order time (later price or name changes do not alter past orders). */
export const orderLines = pgTable(
  'order_lines',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    sku: varchar('sku', { length: 64 }).notNull(),
    productNames: jsonb('product_names').$type<Record<string, string>>().notNull(),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    lineTotalMinor: bigint('line_total_minor', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    index('order_lines_order_idx').on(t.orderId),
    check('order_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('order_lines_total_consistent', sql`${t.lineTotalMinor} = ${t.unitPriceMinor} * ${t.quantity}`),
  ],
);

/** Every status change: who, when, from, to, why. Append-only (database trigger). */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    fromStatus: orderStatus('from_status'), // null for the creation entry
    toStatus: orderStatus('to_status').notNull(),
    actorType: orderActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_status_history_order_idx').on(t.orderId, t.createdAt)],
);

/** Refunds applied to an order, one row per Payment Service refund (so a refund is never counted twice). */
export const orderRefunds = pgTable(
  'order_refunds',
  {
    paymentRefundId: varchar('payment_refund_id', { length: 64 }).primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_refunds_order_idx').on(t.orderId)],
);

/** Payment Service events already handled (de-duplication of retried deliveries). */
export const receivedPaymentEvents = pgTable('received_payment_events', {
  eventId: varchar('event_id', { length: 64 }).primaryKey(),
  type: varchar('type', { length: 64 }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
