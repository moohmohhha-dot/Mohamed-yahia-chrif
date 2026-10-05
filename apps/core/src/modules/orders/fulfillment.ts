/**
 * Fulfillment: the parcel of an order and the order status kept in step with it.
 *
 * - The merchant creates the parcel once the order is confirmed (processing or preparing). With a
 *   courier API account the parcel is registered with the courier, which returns the tracking number.
 * - Parcel updates (from the merchant, or from the courier's webhooks) move the order: the parcel
 *   leaving makes the order "shipping", delivery makes it "delivered" (and records the sale).
 * - A parcel coming back does not change the order by itself: the merchant confirms the return and
 *   says whether the goods go back on sale.
 */
import { and, eq } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, notFound } from '../../shared/errors.js';
import { requireMembership, type MerchantRole } from '../merchants/index.js';
import { audit } from '../platform/index.js';
import {
  activeShipment,
  courierCredentials,
  destinationOf,
  findShipmentByTracking,
  LEFT_MERCHANT,
  openShipment,
  recordShipmentStatus,
  type ShipmentSource,
  type ShipmentStatus,
} from '../shipping/index.js';
import { applyTransition, loadForActor, shipmentSource, type OrderActor, type OrderDeps } from './service.js';
import type { OrderStatus } from './transitions.js';
import type { FailureReason, RefusalReason } from '../cod/index.js';
import { codAfterParcelUpdate, codBeforeParcelUpdate } from './cod-hooks.js';

const SYSTEM: OrderActor = { type: 'system', userId: null, ip: null };

/** Order moves implied by a parcel status, from the order's current status. */
function orderStepsFor(order: OrderStatus, parcel: ShipmentStatus): OrderStatus[] {
  const steps: OrderStatus[] = [];
  if (!['processing', 'preparing', 'shipping'].includes(order)) return steps;
  if (LEFT_MERCHANT.includes(parcel) || parcel === 'delivered') {
    if (order === 'processing') steps.push('preparing', 'shipping');
    if (order === 'preparing') steps.push('shipping');
  }
  if (parcel === 'delivered') steps.push('delivered');
  return steps;
}

export async function createOrderShipment(db: Database, deps: OrderDeps, actor: OrderActor, orderId: string, input: { trackingNumber?: string }) {
  if (actor.type === 'merchant') await requireMembership(db, actor.merchantId!, actor.userId!);
  const order = await loadForActor(db, actor, orderId);
  if (!order.delivery) throw new AppError(409, 'NO_DELIVERY_METHOD', 'This order has no delivery method');
  if (!['processing', 'preparing'].includes(order.status)) {
    throw new AppError(409, 'ORDER_NOT_READY_TO_SHIP', 'Confirm the order before preparing its parcel', { status: order.status });
  }
  if (await activeShipment(db, order.id)) throw new AppError(409, 'SHIPMENT_EXISTS', 'This order already has a shipment');

  // Courier API: register the parcel first (outside the transaction), withdraw it if saving fails.
  const [method] = await db.select().from(s.shippingMethods).where(eq(s.shippingMethods.id, order.delivery.methodId));
  const adapter = method?.courierAccountId ? deps.couriers?.[method.courierCode!] : undefined;
  let parcel: { trackingNumber: string; externalId?: string | null; labelUrl?: string | null } | null = null;
  let credentials: Record<string, string> | null = null;
  if (adapter && method?.courierAccountId && deps.secrets) {
    ({ credentials } = await courierCredentials(db, deps.secrets, method.courierAccountId));
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    parcel = await adapter.createParcel(credentials, {
      reference: order.number,
      destination: destinationOf(order),
      codAmountMinor: order.paymentMethod === 'cash_on_delivery' && order.paymentStatus !== 'successful' ? Number(order.totalMinor - order.refundedMinor - order.creditAppliedMinor) : 0,
      currency: order.currency,
      declaredValueMinor: Number(order.subtotalMinor),
      items: lines.map((l) => ({ name: l.productNames.fr ?? Object.values(l.productNames)[0] ?? l.sku, quantity: l.quantity })),
    });
  }
  try {
    return await db.transaction(async (tx) => {
      let merchantRole: MerchantRole | null = null;
      if (actor.type === 'merchant') merchantRole = await requireMembership(tx, actor.merchantId!, actor.userId!);
      let current = await loadForActor(tx, actor, orderId, true);
      if (current.status === 'processing') {
        current = await applyTransition(tx, deps, actor, merchantRole, current, { to: 'preparing', fromShipment: true });
      }
      if (current.status !== 'preparing') throw new AppError(409, 'ORDER_NOT_READY_TO_SHIP', 'The order changed meanwhile', { status: current.status });
      const shipment = await openShipment(tx, {
        order: current,
        source: shipmentSource(actor),
        actorUserId: actor.userId,
        trackingNumber: parcel?.trackingNumber ?? input.trackingNumber,
        courierAccountId: parcel ? method!.courierAccountId : null,
        externalId: parcel?.externalId,
        labelUrl: parcel?.labelUrl,
      });
      await audit(tx, actor, { action: 'shipping.shipment.created', entityType: 'shipment', entityId: shipment.id, metadata: { orderId, viaCourierApi: Boolean(parcel) } });
      return shipment;
    });
  } catch (error) {
    if (parcel && adapter && credentials) await adapter.cancelParcel(credentials, parcel.trackingNumber).catch(() => undefined);
    throw error;
  }
}

export type ShipmentStatusInput = {
  status: ShipmentStatus;
  trackingNumber?: string;
  note?: string;
  location?: string;
  /** Why a delivery attempt failed (required for cash-on-delivery orders). */
  reason?: FailureReason;
  /** Set when the customer refused the parcel at the door. */
  refusalReason?: RefusalReason;
};
type CourierContext = { source: ShipmentSource; occurredAt?: Date; externalEventId?: string; raw?: unknown };

/** Records a parcel update and moves the order accordingly, in one transaction. Returns false for a repeated courier update. */
export async function updateOrderShipment(
  db: Database,
  deps: OrderDeps,
  actor: OrderActor,
  orderId: string,
  input: ShipmentStatusInput,
  context?: CourierContext,
) {
  return db.transaction(async (tx) => {
    let merchantRole: MerchantRole | null = null;
    if (actor.type === 'merchant') merchantRole = await requireMembership(tx, actor.merchantId!, actor.userId!);
    let order = await loadForActor(tx, actor, orderId, true);
    const shipment = await activeShipment(tx, order.id, true);
    if (!shipment) throw notFound('Shipment');
    const source = context?.source ?? shipmentSource(actor);
    if (shipment.courierAccountId && source === 'merchant') {
      throw new AppError(409, 'SHIPMENT_TRACKED_BY_COURIER', 'This parcel is tracked by the courier; its status updates arrive automatically');
    }
    const parcelUpdate = { status: input.status, reason: input.reason, refusalReason: input.refusalReason, note: input.note };
    await codBeforeParcelUpdate(tx, order, shipment.status, parcelUpdate, source);
    const updated = await recordShipmentStatus(tx, shipment, {
      status: input.status,
      source,
      actorUserId: actor.userId,
      trackingNumber: input.trackingNumber,
      description: input.note,
      location: input.location,
      occurredAt: context?.occurredAt,
      externalEventId: context?.externalEventId,
      raw: context?.raw,
    });
    if (!updated) return false;
    await codAfterParcelUpdate(tx, order, shipment.status, updated.status, parcelUpdate, { type: actor.type, userId: actor.userId });
    for (const to of orderStepsFor(order.status, updated.status)) {
      order = await applyTransition(tx, deps, actor, merchantRole, order, { to, fromShipment: true, note: input.note });
    }
    return true;
  });
}

/** A courier's webhook: authenticated by the courier adapter, then each update is applied to its parcel. */
export async function handleCourierWebhook(
  db: Database,
  deps: OrderDeps,
  accountId: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
) {
  if (!deps.secrets) throw notFound('Courier account');
  const [exists] = await db.select({ id: s.courierAccounts.id }).from(s.courierAccounts).where(and(eq(s.courierAccounts.id, accountId), eq(s.courierAccounts.active, true)));
  if (!exists) throw notFound('Courier account');
  const { account, credentials } = await courierCredentials(db, deps.secrets, accountId);
  const adapter = deps.couriers?.[account.courierCode];
  if (!adapter) throw notFound('Courier integration');
  const events = adapter.parseWebhook(credentials, rawBody, headers);
  let applied = 0;
  for (const event of events) {
    const shipment = await findShipmentByTracking(db, account.courierCode, event.trackingNumber);
    // Not a parcel of this account (return pickups are entered by hand for now).
    if (!shipment || shipment.courierAccountId !== account.id || shipment.direction !== 'outbound') continue;
    const done = await updateOrderShipment(
      db,
      deps,
      SYSTEM,
      shipment.orderId,
      { status: event.status, note: event.description, location: event.location, reason: event.failureReason, refusalReason: event.refusalReason },
      { source: 'courier', occurredAt: event.occurredAt, externalEventId: event.externalEventId, raw: event.raw },
    );
    if (done) applied++;
  }
  return { received: events.length, applied };
}
