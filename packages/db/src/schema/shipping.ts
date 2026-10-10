/**
 * Shipping: where customers live (administrative areas), how each merchant delivers (methods, zones,
 * rates), which courier companies exist and how ARUMA talks to them, and every parcel with its tracking
 * history.
 *
 * Areas are generic so every country fits the same tables. In Algeria:
 *   region = Wilaya, district = Daïra, locality = Commune.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { orders } from './orders.js';
import { countries, currencies } from './reference.js';
import { returnRequests } from './returns.js';

export const geoAreaLevel = pgEnum('geo_area_level', ['region', 'district', 'locality']);

/** Administrative areas, e.g. DZ-16 (Wilaya d'Alger) › DZ-16-D-… (Daïra) › DZ-16-C-… (Commune). */
export const geoAreas = pgTable(
  'geo_areas',
  {
    /** Stable readable id: `DZ-16`, `DZ-16-D-bab-el-oued`, `DZ-16-C-bab-el-oued`. Names may change, ids do not. */
    id: varchar('id', { length: 96 }).primaryKey(),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => countries.code),
    level: geoAreaLevel('level').notNull(),
    parentId: varchar('parent_id', { length: 96 }).references((): AnyPgColumn => geoAreas.id),
    /** Official code where one exists (Wilaya number, e.g. 16). */
    code: varchar('code', { length: 16 }),
    /** Names by locale: { ar: 'الجزائر', fr: 'Alger' }. */
    names: jsonb('names').$type<Record<string, string>>().notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('geo_areas_parent_idx').on(t.parentId), index('geo_areas_country_level_idx').on(t.country, t.level)],
);

/** Courier companies. `integration` says whether ARUMA talks to them by API or the merchant enters tracking by hand. */
export const courierIntegration = pgEnum('courier_integration', ['manual', 'api']);
export const couriers = pgTable('couriers', {
  code: varchar('code', { length: 32 }).primaryKey(),
  name: text('name').notNull(),
  country: char('country', { length: 2 })
    .notNull()
    .references(() => countries.code),
  integration: courierIntegration('integration').notNull().default('manual'),
  /** Public tracking page with `{tracking}` placeholder, only when the courier publishes one. */
  trackingUrlTemplate: text('tracking_url_template'),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

/**
 * Credentials for a courier API. Owned by a merchant (its own courier contract) or by the platform
 * (merchantId null, e.g. ARUMA Logistics later). Credentials are encrypted and never returned by the API.
 */
export const courierAccounts = pgTable(
  'courier_accounts',
  {
    id: id(),
    courierCode: varchar('courier_code', { length: 32 })
      .notNull()
      .references(() => couriers.code),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('courier_accounts_merchant_idx').on(t.merchantId)],
);

export const shippingMethodType = pgEnum('shipping_method_type', [
  'merchant_delivery', // the merchant (or its driver) delivers
  'courier', // a courier company delivers to the customer's address
  'local_pickup', // the customer collects from the merchant
  'pickup_point', // the customer collects from a relay point / courier desk (behind a feature flag)
]);

/** A named group of areas a merchant prices together, e.g. "Alger et environs" or "Sud". */
export const shippingZones = pgTable(
  'shipping_zones',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => countries.code),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('shipping_zones_merchant_idx').on(t.merchantId)],
);

/** Areas of a zone, at any level (a whole Wilaya, a Daïra, or a single Commune). */
export const shippingZoneAreas = pgTable(
  'shipping_zone_areas',
  {
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => shippingZones.id, { onDelete: 'cascade' }),
    areaId: varchar('area_id', { length: 96 })
      .notNull()
      .references(() => geoAreas.id),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.areaId] }), index('shipping_zone_areas_area_idx').on(t.areaId)],
);

/** How a merchant delivers. */
export const shippingMethods = pgTable(
  'shipping_methods',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    type: shippingMethodType('type').notNull(),
    name: text('name').notNull(),
    courierCode: varchar('courier_code', { length: 32 }).references(() => couriers.code),
    /** Set when parcels are created through the courier's API; null = tracking entered by hand. */
    courierAccountId: uuid('courier_account_id').references(() => courierAccounts.id),
    /** Local pickup: where and when the customer collects. */
    pickupLocation: jsonb('pickup_location').$type<{ areaId?: string; address: string; hours?: string; phone?: string }>(),
    /** Whether the customer may pay cash on delivery with this method. */
    cashOnDelivery: boolean('cash_on_delivery').notNull().default(true),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('shipping_methods_merchant_idx').on(t.merchantId),
    check('shipping_methods_courier_required', sql`(${t.type} not in ('courier', 'pickup_point')) or ${t.courierCode} is not null`),
    check('shipping_methods_pickup_location', sql`${t.type} <> 'local_pickup' or ${t.pickupLocation} is not null`),
  ],
);

/**
 * Price of a method for a zone. zoneId null = anywhere in the merchant's country (flat rate, local pickup).
 * The most specific matching zone wins (Commune › Daïra › Wilaya › anywhere).
 */
export const shippingRates = pgTable(
  'shipping_rates',
  {
    id: id(),
    methodId: uuid('method_id')
      .notNull()
      .references(() => shippingMethods.id, { onDelete: 'cascade' }),
    zoneId: uuid('zone_id').references(() => shippingZones.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    /** Free delivery when the merchant's part of the cart reaches this amount. */
    freeAboveMinor: bigint('free_above_minor', { mode: 'bigint' }),
    minDays: smallint('min_days').notNull().default(1),
    maxDays: smallint('max_days').notNull().default(3),
    ...timestamps,
  },
  (t) => [
    unique('shipping_rates_method_zone_currency_uq').on(t.methodId, t.zoneId, t.currency).nullsNotDistinct(),
    check('shipping_rates_price_positive', sql`${t.priceMinor} >= 0 and (${t.freeAboveMinor} is null or ${t.freeAboveMinor} >= 0)`),
    check('shipping_rates_days', sql`${t.minDays} >= 0 and ${t.maxDays} >= ${t.minDays}`),
  ],
);

/** Relay points and courier desks (stop desks). Prepared for later; checkout uses them only behind `shipping.pickup_points`. */
export const pickupPoints = pgTable(
  'pickup_points',
  {
    id: id(),
    /** Operated by a courier (its desk) or, later, by ARUMA or a partner shop. */
    courierCode: varchar('courier_code', { length: 32 }).references(() => couriers.code),
    areaId: varchar('area_id', { length: 96 })
      .notNull()
      .references(() => geoAreas.id),
    name: text('name').notNull(),
    address: text('address').notNull(),
    phone: varchar('phone', { length: 20 }),
    hours: text('hours'),
    /** The courier's own id for this desk, for API integrations. */
    externalId: varchar('external_id', { length: 64 }),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('pickup_points_area_idx').on(t.areaId)],
);

export const shipmentStatus = pgEnum('shipment_status', [
  'pending', // created, not handed over yet
  'ready_for_pickup', // local pickup or pickup point: waiting for the customer
  'in_transit', // handed to the courier / on the way
  'out_for_delivery', // with the driver today
  'delivery_failed', // attempt failed (absent, unreachable…); may be retried
  'delivered',
  'returning', // on its way back to the merchant
  'returned', // back with the merchant
  'cancelled', // never left
]);
/** outbound: merchant → customer; return: customer → merchant (a return pickup). */
export const shipmentDirection = pgEnum('shipment_direction', ['outbound', 'return']);
export const shipmentEventSource = pgEnum('shipment_event_source', ['merchant', 'courier', 'platform', 'system']);

export type ShipmentDestination = {
  type: 'address' | 'merchant_location' | 'pickup_point';
  fullName: string;
  phone: string;
  /** Address lines, Commune, Daïra, Wilaya (or the pickup location). */
  address: Record<string, unknown>;
};

/** A parcel. One active shipment per order (a cancelled one may be replaced). */
export const shipments = pgTable(
  'shipments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    direction: shipmentDirection('direction').notNull().default('outbound'),
    /** For a return pickup: the return it brings back. */
    returnId: uuid('return_id').references((): AnyPgColumn => returnRequests.id, { onDelete: 'restrict' }),
    methodId: uuid('method_id').references(() => shippingMethods.id),
    methodType: shippingMethodType('method_type').notNull(),
    courierCode: varchar('courier_code', { length: 32 }).references(() => couriers.code),
    courierAccountId: uuid('courier_account_id').references(() => courierAccounts.id),
    trackingNumber: varchar('tracking_number', { length: 64 }),
    /** The courier's id for the parcel when it differs from the tracking number. */
    externalId: varchar('external_id', { length: 64 }),
    labelUrl: text('label_url'),
    status: shipmentStatus('status').notNull().default('pending'),
    destination: jsonb('destination').$type<ShipmentDestination>().notNull(),
    /** Where the parcel is collected, when it is not the merchant (return pickups: the customer's address). */
    origin: jsonb('origin').$type<ShipmentDestination>(),
    /** Cash the courier must collect (cash on delivery), 0 otherwise. */
    codAmountMinor: bigint('cod_amount_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipments_active_order_uq').on(t.orderId).where(sql`${t.status} <> 'cancelled' and ${t.direction} = 'outbound'`),
    uniqueIndex('shipments_active_return_uq').on(t.returnId).where(sql`${t.status} <> 'cancelled' and ${t.direction} = 'return'`),
    check('shipments_return_link', sql`(${t.direction} = 'return') = (${t.returnId} is not null)`),
    uniqueIndex('shipments_tracking_uq').on(t.courierCode, t.trackingNumber).where(sql`${t.trackingNumber} is not null`),
    index('shipments_merchant_idx').on(t.merchantId, t.status),
  ],
);

/** Tracking history of a parcel. Append-only (database trigger). */
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'restrict' }),
    status: shipmentStatus('status').notNull(),
    source: shipmentEventSource('source').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    description: text('description'),
    location: text('location'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Courier's event id, so a webhook delivered twice is recorded once. */
    externalEventId: varchar('external_event_id', { length: 128 }),
    raw: jsonb('raw'),
  },
  (t) => [
    index('shipment_events_shipment_idx').on(t.shipmentId, t.occurredAt),
    uniqueIndex('shipment_events_external_uq').on(t.shipmentId, t.externalEventId).where(sql`${t.externalEventId} is not null`),
  ],
);
