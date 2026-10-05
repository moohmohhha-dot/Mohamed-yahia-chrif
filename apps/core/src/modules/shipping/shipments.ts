/**
 * Parcels and their tracking history. These are the building blocks; the orders module decides when
 * they are used (it keeps the order status and the parcel status in step).
 */
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { schema as s, type ShipmentDestination } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { LEFT_MERCHANT, needsTracking, SHIPMENT_TRANSITIONS, type ShipmentStatus } from './statuses.js';

type Order = typeof s.orders.$inferSelect;
export type Shipment = typeof s.shipments.$inferSelect;
export type ShipmentSource = (typeof s.shipmentEventSource.enumValues)[number];

export async function activeShipment(db: Executor, orderId: string, lock = false): Promise<Shipment | null> {
  const query = db
    .select()
    .from(s.shipments)
    .where(and(eq(s.shipments.orderId, orderId), eq(s.shipments.direction, 'outbound'), ne(s.shipments.status, 'cancelled')));
  const [shipment] = lock ? await query.for('update') : await query;
  return shipment ?? null;
}

/** Where the parcel goes, frozen when it is created. */
export function destinationOf(order: Order): ShipmentDestination {
  const a = order.shippingAddress;
  const contact = { fullName: a.fullName, phone: a.phone };
  const delivery = order.delivery;
  if (delivery?.type === 'local_pickup') return { type: 'merchant_location', ...contact, address: { ...delivery.pickupLocation } };
  if (delivery?.type === 'pickup_point') return { type: 'pickup_point', ...contact, address: { ...delivery.pickupPoint } };
  return { type: 'address', ...contact, address: { ...a } };
}

/** A courier's tracking number belongs to one parcel only. */
async function assertTrackingFree(db: Executor, courierCode: string | null, trackingNumber: string | null | undefined, shipmentId?: string) {
  if (!courierCode || !trackingNumber) return;
  const [other] = await db
    .select({ id: s.shipments.id })
    .from(s.shipments)
    .where(and(eq(s.shipments.courierCode, courierCode), eq(s.shipments.trackingNumber, trackingNumber)));
  if (other && other.id !== shipmentId) throw new AppError(409, 'TRACKING_NUMBER_IN_USE', 'This tracking number is already used by another parcel of this courier');
}

/** Creates the parcel of an order (status pending) with its first history line. */
export async function openShipment(
  tx: Executor,
  input: {
    order: Order;
    source: ShipmentSource;
    actorUserId: string | null;
    trackingNumber?: string | null;
    courierAccountId?: string | null;
    externalId?: string | null;
    labelUrl?: string | null;
  },
): Promise<Shipment> {
  const { order } = input;
  if (!order.delivery) throw new AppError(409, 'NO_DELIVERY_METHOD', 'This order has no delivery method');
  if (await activeShipment(tx, order.id)) throw new AppError(409, 'SHIPMENT_EXISTS', 'This order already has a shipment');
  await assertTrackingFree(tx, order.delivery.courierCode, input.trackingNumber?.trim());
  const [shipment] = await tx
    .insert(s.shipments)
    .values({
      orderId: order.id,
      merchantId: order.merchantId,
      methodId: order.delivery.methodId,
      methodType: order.delivery.type,
      courierCode: order.delivery.courierCode,
      courierAccountId: input.courierAccountId ?? null,
      trackingNumber: input.trackingNumber?.trim() || null,
      externalId: input.externalId ?? null,
      labelUrl: input.labelUrl ?? null,
      destination: destinationOf(order),
      codAmountMinor: order.paymentMethod === 'cash_on_delivery' && order.paymentStatus !== 'successful' ? order.totalMinor - order.refundedMinor - order.creditAppliedMinor : 0n,
      currency: order.currency,
      createdBy: input.actorUserId,
    })
    .returning();
  await tx.insert(s.shipmentEvents).values({
    shipmentId: shipment!.id,
    status: 'pending',
    source: input.source,
    actorUserId: input.actorUserId,
    description: 'Shipment created',
  });
  return shipment!;
}

export type ShipmentUpdate = {
  status: ShipmentStatus;
  source: ShipmentSource;
  actorUserId: string | null;
  trackingNumber?: string | null;
  description?: string | null;
  location?: string | null;
  occurredAt?: Date;
  externalEventId?: string | null;
  raw?: unknown;
};

/**
 * Records a tracking update and moves the parcel to its new status.
 * Returns null when the update was already recorded (a courier webhook delivered twice).
 * Couriers sometimes report events late or out of order: such an update is kept in the history but does
 * not move the parcel backwards. Merchants and staff get an error instead.
 */
export async function recordShipmentStatus(tx: Executor, shipment: Shipment, update: ShipmentUpdate): Promise<Shipment | null> {
  if (update.externalEventId) {
    const [seen] = await tx
      .select({ id: s.shipmentEvents.id })
      .from(s.shipmentEvents)
      .where(and(eq(s.shipmentEvents.shipmentId, shipment.id), eq(s.shipmentEvents.externalEventId, update.externalEventId)));
    if (seen) return null;
  }
  const tracking = update.trackingNumber?.trim() || shipment.trackingNumber;
  if (update.trackingNumber?.trim() && shipment.trackingNumber && update.trackingNumber.trim() !== shipment.trackingNumber && shipment.status !== 'pending') {
    throw new AppError(409, 'TRACKING_LOCKED', 'The tracking number cannot change once the parcel has left');
  }
  if (tracking !== shipment.trackingNumber) await assertTrackingFree(tx, shipment.courierCode, tracking, shipment.id);
  let moves = update.status !== shipment.status;
  if (moves && !SHIPMENT_TRANSITIONS[shipment.status].includes(update.status)) {
    if (update.source !== 'courier') {
      throw new AppError(409, 'INVALID_SHIPMENT_TRANSITION', `A parcel cannot go from ${shipment.status} to ${update.status}`, {
        from: shipment.status,
        to: update.status,
      });
    }
    moves = false;
  }
  if (moves && (LEFT_MERCHANT.includes(update.status) || update.status === 'delivered') && needsTracking(shipment.methodType) && !tracking) {
    throw badRequest('TRACKING_NUMBER_REQUIRED', "Enter the courier's tracking number before the parcel leaves");
  }
  const now = new Date();
  await tx.insert(s.shipmentEvents).values({
    shipmentId: shipment.id,
    status: update.status,
    source: update.source,
    actorUserId: update.actorUserId,
    description: update.description?.trim() || (moves ? null : 'Reported by the courier after a later status'),
    location: update.location?.trim() || null,
    occurredAt: update.occurredAt ?? now,
    externalEventId: update.externalEventId ?? null,
    raw: update.raw ?? null,
  });
  const [updated] = await tx
    .update(s.shipments)
    .set({ trackingNumber: tracking, ...(moves ? { status: update.status, statusChangedAt: now } : {}) })
    .where(eq(s.shipments.id, shipment.id))
    .returning();
  return updated!;
}

/** A parcel with its history. Customers do not see who did what inside the merchant. */
export async function describeShipment(db: Executor, shipment: Shipment, view: 'customer' | 'merchant' | 'platform') {
  const [courier] = shipment.courierCode ? await db.select().from(s.couriers).where(eq(s.couriers.code, shipment.courierCode)) : [];
  const events = await db
    .select({
      status: s.shipmentEvents.status,
      source: s.shipmentEvents.source,
      actorName: s.users.displayName,
      description: s.shipmentEvents.description,
      location: s.shipmentEvents.location,
      occurredAt: s.shipmentEvents.occurredAt,
    })
    .from(s.shipmentEvents)
    .leftJoin(s.users, eq(s.users.id, s.shipmentEvents.actorUserId))
    .where(eq(s.shipmentEvents.shipmentId, shipment.id))
    .orderBy(asc(s.shipmentEvents.occurredAt), asc(s.shipmentEvents.recordedAt));
  return {
    id: shipment.id,
    status: shipment.status,
    methodType: shipment.methodType,
    courierCode: shipment.courierCode,
    courierName: courier?.name ?? null,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: courier?.trackingUrlTemplate && shipment.trackingNumber ? courier.trackingUrlTemplate.replace('{tracking}', encodeURIComponent(shipment.trackingNumber)) : null,
    /** Parcels created through a courier API are updated by the courier, not by hand. */
    trackedByCourier: Boolean(shipment.courierAccountId),
    codAmountMinor: Number(shipment.codAmountMinor),
    statusChangedAt: shipment.statusChangedAt,
    ...(view === 'customer' ? {} : { labelUrl: shipment.labelUrl, destination: shipment.destination }),
    events: events.map((e) => (view === 'customer' ? { status: e.status, description: e.description, location: e.location, occurredAt: e.occurredAt } : e)),
  };
}

/** The order's current parcel (or the last cancelled one), described. */
export async function shipmentOfOrder(db: Executor, orderId: string, view: 'customer' | 'merchant' | 'platform') {
  const shipment =
    (await activeShipment(db, orderId)) ??
    (
      await db
        .select()
        .from(s.shipments)
        .where(and(eq(s.shipments.orderId, orderId), eq(s.shipments.direction, 'outbound')))
        .orderBy(desc(s.shipments.createdAt))
        .limit(1)
    )[0];
  return shipment ? describeShipment(db, shipment, view) : null;
}

export async function findShipmentByTracking(db: Executor, courierCode: string, trackingNumber: string) {
  const [shipment] = await db
    .select()
    .from(s.shipments)
    .where(and(eq(s.shipments.courierCode, courierCode), eq(s.shipments.trackingNumber, trackingNumber)));
  return shipment ?? null;
}

// --- Return pickups (customer → merchant) ---------------------------------------------------------------

export async function activeReturnShipment(db: Executor, returnId: string, lock = false): Promise<Shipment | null> {
  const query = db
    .select()
    .from(s.shipments)
    .where(and(eq(s.shipments.returnId, returnId), eq(s.shipments.direction, 'return'), ne(s.shipments.status, 'cancelled')));
  const [shipment] = lock ? await query.for('update') : await query;
  return shipment ?? null;
}

/** A pickup of returned items at the customer's address, back to the merchant. */
export async function openReturnShipment(
  tx: Executor,
  input: {
    order: Order;
    returnId: string;
    courierCode: string | null;
    trackingNumber?: string | null;
    origin: ShipmentDestination;
    destination: ShipmentDestination;
    source: ShipmentSource;
    actorUserId: string | null;
  },
): Promise<Shipment> {
  if (await activeReturnShipment(tx, input.returnId)) throw new AppError(409, 'SHIPMENT_EXISTS', 'This return already has a pickup');
  if (input.courierCode) {
    const [courier] = await tx.select().from(s.couriers).where(and(eq(s.couriers.code, input.courierCode), eq(s.couriers.active, true)));
    if (!courier) throw badRequest('UNKNOWN_COURIER', 'This courier is not available');
  }
  await assertTrackingFree(tx, input.courierCode, input.trackingNumber?.trim());
  const [shipment] = await tx
    .insert(s.shipments)
    .values({
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      direction: 'return',
      returnId: input.returnId,
      methodType: input.courierCode ? 'courier' : 'merchant_delivery',
      courierCode: input.courierCode,
      trackingNumber: input.trackingNumber?.trim() || null,
      origin: input.origin,
      destination: input.destination,
      codAmountMinor: 0n,
      currency: input.order.currency,
      createdBy: input.actorUserId,
    })
    .returning();
  await tx.insert(s.shipmentEvents).values({ shipmentId: shipment!.id, status: 'pending', source: input.source, actorUserId: input.actorUserId, description: 'Return pickup created' });
  return shipment!;
}
