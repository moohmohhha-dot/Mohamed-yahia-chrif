/**
 * Orders. A customer checkout can contain items from several merchants; it creates one order per
 * merchant (sharing a checkout id), because each merchant prepares and ships its own parcel.
 *
 * Status changes are only allowed along the transitions in apps/core/src/modules/orders/transitions.ts,
 * enforced again by a database trigger (migration 0005). Every change is recorded in
 * order_status_history (append-only): who, when, from, to, and why.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { offers } from './offers.js';
import { currencies } from './reference.js';
import { stores } from './tenancy.js';
import { productVariants } from './catalog.js';

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
export const paymentMethod = pgEnum('payment_method', ['cash_on_delivery']);
export const orderActorType = pgEnum('order_actor_type', ['customer', 'merchant', 'platform', 'system']);

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

export type ShippingAddress = {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode?: string;
  country: string;
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
    paymentMethod: paymentMethod('payment_method').notNull(),
    shippingAddress: jsonb('shipping_address').$type<ShippingAddress>().notNull(),
    customerNote: text('customer_note'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_merchant_status_idx').on(t.merchantId, t.status, t.placedAt),
    index('orders_customer_idx').on(t.customerUserId, t.placedAt),
    index('orders_checkout_idx').on(t.checkoutId),
    check('orders_total_consistent', sql`${t.totalMinor} = ${t.subtotalMinor} + ${t.shippingMinor}`),
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
