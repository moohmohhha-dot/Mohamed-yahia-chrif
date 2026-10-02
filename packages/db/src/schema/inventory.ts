/**
 * Inventory: where stock physically is, how much is reserved, and every change to it.
 *
 *   inventory_locations     warehouses / shops of a merchant (one default location each)
 *   inventory_levels        on hand + reserved per offer per location   (available = on_hand - reserved)
 *   inventory_reservations  stock held for an order (or a checkout) until it is consumed or released
 *   inventory_movements     append-only history of every change (enforced by a database trigger)
 *
 * Overselling is impossible at the database level: reserved can never exceed on_hand (check constraint),
 * and reservations only succeed through an atomic conditional update.
 */
import { sql } from 'drizzle-orm';
import { boolean, char, check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { offers } from './offers.js';
import { countries } from './reference.js';

export const inventoryLocationType = pgEnum('inventory_location_type', ['warehouse', 'shop', 'fulfillment_center', 'dropship']);

export const inventoryLocations = pgTable(
  'inventory_locations',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(), // e.g. MAIN, ALGER-1 — used in imports
    name: text('name').notNull(),
    type: inventoryLocationType('type').notNull().default('warehouse'),
    country: char('country', { length: 2 }).references(() => countries.code),
    region: text('region'),
    city: text('city'),
    addressLine: text('address_line'),
    isDefault: boolean('is_default').notNull().default(false), // exactly one per merchant
    status: recordStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('inventory_locations_merchant_code_uq').on(t.merchantId, t.code),
    uniqueIndex('inventory_locations_one_default_uq').on(t.merchantId).where(sql`${t.isDefault}`),
  ],
);

export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => inventoryLocations.id, { onDelete: 'restrict' }),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.offerId, t.locationId] }),
    index('inventory_levels_location_idx').on(t.locationId),
    check('inventory_levels_on_hand_nonneg', sql`${t.onHand} >= 0`),
    check('inventory_levels_reserved_nonneg', sql`${t.reserved} >= 0`),
    check('inventory_levels_no_oversell', sql`${t.reserved} <= ${t.onHand}`),
  ],
);

export const reservationStatus = pgEnum('inventory_reservation_status', ['active', 'released', 'consumed', 'expired']);

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: id(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => inventoryLocations.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    status: reservationStatus('status').notNull().default('active'),
    /** What holds the stock, e.g. ('order', '<order id>') or ('checkout', '<cart id>'). */
    referenceType: varchar('reference_type', { length: 32 }).notNull(),
    referenceId: varchar('reference_id', { length: 128 }).notNull(),
    /** Optional hold time (e.g. 15 minutes for a checkout); expired holds are released by a job. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_reservations_ref_line_uq').on(t.referenceType, t.referenceId, t.offerId, t.locationId),
    index('inventory_reservations_offer_idx').on(t.offerId, t.status),
    index('inventory_reservations_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'active' and ${t.expiresAt} is not null`),
    check('inventory_reservations_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

export const inventoryReason = pgEnum('inventory_reason', [
  'initial', // offer created
  'restock', // goods received
  'correction', // stock count fixed
  'damaged', // lost / broken / expired
  'returned', // customer return put back in stock
  'sale', // reservation consumed: the order left the warehouse
  'sale_cancelled', // legacy value, no longer written (cancellations release reservations instead)
  'reserved', // stock held for an order / checkout
  'released', // hold cancelled or expired
  'transfer_out', // moved to another location
  'transfer_in', // received from another location
  'import', // bulk import (CSV / Excel)
]);

/**
 * Append-only history of every stock change at a location: on-hand change (delta) and reserved change
 * (reservedDelta), the resulting quantities, why, by whom, and for what (order, transfer, import…).
 * UPDATE, DELETE and TRUNCATE are rejected by a database trigger (migration 0003).
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: id(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => inventoryLocations.id, { onDelete: 'restrict' }),
    delta: integer('delta').notNull(), // on-hand change
    quantityAfter: integer('quantity_after').notNull(), // on hand at the location after the change
    reservedDelta: integer('reserved_delta').notNull().default(0),
    reservedAfter: integer('reserved_after').notNull().default(0),
    reason: inventoryReason('reason').notNull(),
    note: text('note'),
    referenceType: varchar('reference_type', { length: 32 }),
    referenceId: varchar('reference_id', { length: 128 }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movements_offer_idx').on(t.offerId, t.createdAt),
    index('inventory_movements_reference_idx').on(t.referenceType, t.referenceId),
  ],
);
