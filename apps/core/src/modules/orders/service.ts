import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor, Transaction } from '../../shared/db.js';
import { AppError, badRequest, forbidden, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { consumeStock, receiveReturn, releaseStock } from '../inventory/index.js';
import { postOrderDelivered } from '../finance/index.js';
import type { PaymentsClient } from '../payments/index.js';
import { requireMembership, type MerchantRole } from '../merchants/index.js';
import { audit, recordEvent, type SecretBox } from '../platform/index.js';
import {
  activeShipment,
  courierCredentials,
  handedOverStatus,
  openShipment,
  recordShipmentStatus,
  shipmentOfOrder,
  type CourierRegistry,
  type Shipment,
  type ShipmentSource,
} from '../shipping/index.js';
import { MERCHANT_ROLES_FOR, nextStatuses, reasonRequired, TRANSITIONS, type OrderActorType, type OrderStatus } from './transitions.js';

type Order = typeof s.orders.$inferSelect;
/** Who is acting on an order. `merchantId` scopes a merchant actor to its own orders. */
export type OrderActor = Actor & { type: OrderActorType; userId: string | null; merchantId?: string };

export type TransitionInput = {
  to: OrderStatus;
  reason?: string;
  note?: string;
  /** Returns only: put the goods back on sale (true) or not (false, e.g. damaged). */
  restock?: boolean;
  /** Set by the refund flow: the only way an order becomes "refunded". */
  viaRefund?: boolean;
  /** Shipping: the courier's tracking number, when the order leaves with a courier. */
  trackingNumber?: string;
  /** Set when a parcel update moves the order (the parcel is already up to date). */
  fromShipment?: boolean;
};

export type OrderDeps = { payments: PaymentsClient; couriers?: CourierRegistry; secrets?: SecretBox };

export const shipmentSource = (actor: OrderActor): ShipmentSource =>
  actor.type === 'merchant' ? 'merchant' : actor.type === 'platform' ? 'platform' : 'system';

/**
 * When an order is moved directly, its parcel follows: leaving the merchant opens (or hands over) the
 * parcel, delivery and return close it, cancellation withdraws a parcel that has not left.
 */
async function syncShipment(tx: Transaction, actor: OrderActor, order: Order, input: TransitionInput) {
  const shipment = await activeShipment(tx, order.id, true);
  if (shipment?.courierAccountId && actor.type === 'merchant' && (input.to === 'shipping' || input.to === 'delivered')) {
    throw new AppError(409, 'SHIPMENT_TRACKED_BY_COURIER', 'This parcel is tracked by the courier; its status updates arrive automatically');
  }
  const update = { source: shipmentSource(actor), actorUserId: actor.userId, description: input.reason?.trim() || input.note?.trim() || null };
  if (input.to === 'shipping') {
    const parcel = shipment ?? (await openShipment(tx, { order, source: update.source, actorUserId: actor.userId, trackingNumber: input.trackingNumber }));
    if (parcel.status === 'pending') {
      await recordShipmentStatus(tx, parcel, { ...update, status: handedOverStatus(parcel.methodType), trackingNumber: input.trackingNumber });
    }
  }
  if (!shipment) return;
  if (input.to === 'delivered' && shipment.status !== 'delivered') await recordShipmentStatus(tx, shipment, { ...update, status: 'delivered' });
  if (input.to === 'returned' && shipment.status !== 'returned') await recordShipmentStatus(tx, shipment, { ...update, status: 'returned' });
  if (input.to === 'cancelled' && shipment.status === 'pending') await recordShipmentStatus(tx, shipment, { ...update, status: 'cancelled' });
}

/** Loads an order the actor may see; anyone else gets 404 (no hint that the order exists). */
export async function loadForActor(db: Executor, actor: OrderActor, orderId: string, lock = false): Promise<Order> {
  const scope: SQL[] = [eq(s.orders.id, orderId)];
  if (actor.type === 'customer') scope.push(eq(s.orders.customerUserId, actor.userId!));
  if (actor.type === 'merchant') scope.push(eq(s.orders.merchantId, actor.merchantId!));
  const query = db.select().from(s.orders).where(and(...scope));
  const [order] = lock ? await query.for('update') : await query;
  if (!order) throw notFound('Order');
  return order;
}

/**
 * Moves an order to a new status: checks the rule table and the actor's rights, applies the stock
 * consequence, and records the change (who, when, from, to, why) — all in one transaction.
 */
export async function transitionOrder(db: Database, deps: OrderDeps, actor: OrderActor, orderId: string, input: TransitionInput) {
  let parcelToCancel: Shipment | null = null;
  const result = await db.transaction(async (tx) => {
    let merchantRole: MerchantRole | null = null;
    if (actor.type === 'merchant') merchantRole = await requireMembership(tx, actor.merchantId!, actor.userId!);
    const order = await loadForActor(tx, actor, orderId, true);
    if (input.to === 'cancelled') {
      const shipment = await activeShipment(tx, order.id);
      if (shipment?.courierAccountId) parcelToCancel = shipment;
    }
    return applyTransition(tx, deps, actor, merchantRole, order, input);
  });

  // A parcel already registered with a courier API is withdrawn there too (best effort: the order is cancelled either way).
  const parcel = parcelToCancel as Shipment | null;
  if (parcel?.trackingNumber && parcel.courierAccountId && deps.couriers?.[parcel.courierCode!] && deps.secrets) {
    const { credentials } = await courierCredentials(db, deps.secrets, parcel.courierAccountId);
    await deps.couriers[parcel.courierCode!]!.cancelParcel(credentials, parcel.trackingNumber).catch(() => undefined);
  }

  // An online checkout is paid as a whole: cancelling an unpaid order cancels the whole checkout and its payment.
  if (input.to === 'cancelled' && result.paymentMethod === 'online' && result.paymentStatus !== 'successful') {
    const siblings = await db
      .select({ id: s.orders.id, status: s.orders.status })
      .from(s.orders)
      .where(and(eq(s.orders.checkoutId, result.checkoutId), inArray(s.orders.status, ['new', 'processing'])));
    for (const sibling of siblings) {
      await transitionOrder(db, deps, { userId: null, ip: null, type: 'system' }, sibling.id, {
        to: 'cancelled',
        reason: 'The checkout was cancelled before payment',
      });
    }
    if (result.paymentIntentId) {
      await deps.payments.cancel(result.paymentIntentId, input.reason ?? 'Order cancelled').catch(() => undefined);
    }
  }
  return result;
}

/** The status change itself, inside the caller's transaction, on an order the caller has locked. */
export async function applyTransition(
  tx: Transaction,
  deps: OrderDeps,
  actor: OrderActor,
  merchantRole: MerchantRole | null,
  order: Order,
  input: TransitionInput,
): Promise<Order> {
  const from = order.status;
  if (!TRANSITIONS[from][input.to]) {
    throw new AppError(409, 'INVALID_TRANSITION', `An order cannot go from ${from} to ${input.to}`, { from, to: input.to });
  }
  if (!nextStatuses(from, actor.type).includes(input.to)) throw forbidden(`You cannot move an order to ${input.to}`);
  const roles = MERCHANT_ROLES_FOR[input.to];
  if (merchantRole && roles && !roles.includes(merchantRole)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  if (reasonRequired(input.to, actor.type) && !input.reason?.trim()) {
    throw badRequest('REASON_REQUIRED', `A reason is required to mark an order ${input.to}`);
  }
  if (input.to === 'refunded' && !input.viaRefund) {
    throw new AppError(409, 'USE_REFUND', 'Orders are refunded through the refund flow, which returns the money');
  }
  if (input.to === 'processing' && order.paymentMethod === 'online' && order.paymentStatus !== 'successful') {
    throw new AppError(409, 'PAYMENT_NOT_COMPLETED', 'This order is paid online and the payment is not complete yet');
  }
  if (input.to === 'returned' && input.restock === undefined) {
    throw badRequest('RESTOCK_REQUIRED', 'Say whether the returned goods go back on sale (restock: true or false)');
  }
  // Keep the parcel in step when the order is moved directly (not by a parcel update).
  if (!input.fromShipment && order.delivery) await syncShipment(tx, actor, order, input);

  // Stock consequences.
  const ref = { type: 'order', id: order.id };
  const stockCtx = { actorUserId: actor.userId, reason: input.reason ?? `Order ${order.number} → ${input.to}` };
  if (input.to === 'cancelled') await releaseStock(tx, ref, stockCtx);
  if (input.to === 'shipping') await consumeStock(tx, ref, stockCtx);
  if (input.to === 'returned' && input.restock) {
    const lines = await tx.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    await receiveReturn(tx, {
      reference: ref,
      merchantId: order.merchantId,
      lines: lines.map((l) => ({ offerId: l.offerId, quantity: l.quantity })),
      actorUserId: actor.userId,
      note: input.reason,
    });
  }

  // Cash on delivery: delivering means the money was collected, recorded in the Payment Service.
  let payment: Partial<typeof s.orders.$inferInsert> = {};
  if (input.to === 'delivered' && order.paymentMethod === 'cash_on_delivery' && order.paymentStatus !== 'successful') {
    const intent = await deps.payments.createIntent(`order:${order.id}`, {
      referenceType: 'order',
      referenceId: order.id,
      method: 'cash_on_delivery',
      amountMinor: Number(order.totalMinor),
      currency: order.currency,
      description: `Order ${order.number}`,
    });
    await deps.payments.cashCollected(intent.id, Number(order.totalMinor), `${actor.type}:${actor.userId ?? 'system'}`);
    payment = { paymentStatus: 'successful', paymentIntentId: intent.id };
  }

  const now = new Date();
  const [updated] = await tx
    .update(s.orders)
    .set({ status: input.to, statusChangedAt: now, ...payment })
    .where(eq(s.orders.id, order.id))
    .returning();
  await tx.insert(s.orderStatusHistory).values({
    orderId: order.id,
    fromStatus: from,
    toStatus: input.to,
    actorType: actor.type,
    actorUserId: actor.userId,
    reason: input.reason?.trim() || null,
    note: [input.note?.trim(), input.to === 'returned' ? `restock: ${input.restock ? 'yes' : 'no'}` : null].filter(Boolean).join(' · ') || null,
    createdAt: now,
  });
  // Delivery is when the sale counts: merchant due, ARUMA commission and fee go into the ledger.
  if (input.to === 'delivered') await postOrderDelivered(tx, updated!, now);
  await audit(tx, actor, {
    action: 'orders.order.status_changed',
    entityType: 'order',
    entityId: order.id,
    metadata: { from, to: input.to, reason: input.reason ?? null },
  });
  await recordEvent(tx, {
    type: 'orders.order.status_changed',
    aggregateType: 'order',
    aggregateId: order.id,
    payload: { number: order.number, merchantId: order.merchantId, from, to: input.to },
  });
  return updated!;
}

const money = (v: bigint) => Number(v);

/** Full order: lines, address, and the complete status history with who did what. */
export async function getOrder(db: Database, actor: OrderActor, orderId: string) {
  if (actor.type === 'merchant') await requireMembership(db, actor.merchantId!, actor.userId!);
  const order = await loadForActor(db, actor, orderId);
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
  const history = await db
    .select({
      id: s.orderStatusHistory.id,
      fromStatus: s.orderStatusHistory.fromStatus,
      toStatus: s.orderStatusHistory.toStatus,
      actorType: s.orderStatusHistory.actorType,
      actorName: s.users.displayName,
      reason: s.orderStatusHistory.reason,
      note: s.orderStatusHistory.note,
      createdAt: s.orderStatusHistory.createdAt,
    })
    .from(s.orderStatusHistory)
    .leftJoin(s.users, eq(s.users.id, s.orderStatusHistory.actorUserId))
    .where(eq(s.orderStatusHistory.orderId, order.id))
    .orderBy(asc(s.orderStatusHistory.createdAt), asc(s.orderStatusHistory.id));
  const [merchant] = await db.select({ name: s.merchants.name, slug: s.merchants.slug }).from(s.merchants).where(eq(s.merchants.id, order.merchantId));

  const { commissionBps, ...summary } = serializeOrder(order);
  return {
    ...summary,
    ...(actor.type === 'customer' ? {} : { commissionBps }),
    paymentStatus: order.paymentStatus,
    refundedMinor: Number(order.refundedMinor),
    paymentIntentId: actor.type === 'customer' ? undefined : order.paymentIntentId,
    merchant: merchant!,
    shippingAddress: order.shippingAddress,
    delivery: order.delivery,
    shipment: await shipmentOfOrder(db, order.id, actor.type === 'customer' ? 'customer' : actor.type === 'merchant' ? 'merchant' : 'platform'),
    customerNote: order.customerNote,
    lines: lines.map((l) => ({
      id: l.id,
      offerId: l.offerId,
      sku: l.sku,
      productNames: l.productNames,
      options: l.options,
      quantity: l.quantity,
      unitPriceMinor: money(l.unitPriceMinor),
      lineTotalMinor: money(l.lineTotalMinor),
    })),
    // The customer sees who changed the status by role, not staff names.
    history: history.map((h) => ({ ...h, actorName: actor.type === 'customer' && h.actorType !== 'customer' ? null : h.actorName })),
    allowedTransitions: nextStatuses(order.status, actor.type)
      .filter((to) => to !== 'refunded') // refunds have their own flow
      .map((to) => ({ to, reasonRequired: reasonRequired(to, actor.type) })),
  };
}

function serializeOrder(o: Order) {
  return {
    id: o.id,
    number: o.number,
    checkoutId: o.checkoutId,
    merchantId: o.merchantId,
    status: o.status,
    currency: o.currency,
    subtotalMinor: money(o.subtotalMinor),
    shippingMinor: money(o.shippingMinor),
    totalMinor: money(o.totalMinor),
    // The commission is ARUMA-internal: merchants see it (it is their contract), customers do not.
    commissionBps: o.commissionBps,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    placedAt: o.placedAt,
    statusChangedAt: o.statusChangedAt,
  };
}

async function listOrders(db: Database, conditions: SQL[], page: number, pageSize: number) {
  const rows = await db
    .select()
    .from(s.orders)
    .where(and(...conditions))
    .orderBy(desc(s.orders.placedAt), desc(s.orders.number))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const counts = rows.length
    ? await db
        .select({ orderId: s.orderLines.orderId, quantity: s.orderLines.quantity })
        .from(s.orderLines)
        .where(inArray(s.orderLines.orderId, rows.map((r) => r.id)))
    : [];
  return rows.map((o) => ({
    ...serializeOrder(o),
    items: counts.filter((c) => c.orderId === o.id).reduce((n, c) => n + c.quantity, 0),
    city: o.shippingAddress.city,
    deliveryType: o.delivery?.type ?? null,
    region: o.shippingAddress.region,
    customerName: o.shippingAddress.fullName,
  }));
}

type ListFilter = { status?: OrderStatus; page: number; pageSize: number };

export function listCustomerOrders(db: Database, userId: string, f: ListFilter) {
  const conditions = [eq(s.orders.customerUserId, userId)];
  if (f.status) conditions.push(eq(s.orders.status, f.status));
  return listOrders(db, conditions, f.page, f.pageSize).then((rows) =>
    rows.map(({ commissionBps: _c, ...r }) => r),
  );
}

export async function listMerchantOrders(db: Database, userId: string, merchantId: string, f: ListFilter) {
  await requireMembership(db, merchantId, userId);
  const conditions = [eq(s.orders.merchantId, merchantId)];
  if (f.status) conditions.push(eq(s.orders.status, f.status));
  return listOrders(db, conditions, f.page, f.pageSize);
}

export function listAllOrders(db: Database, f: ListFilter & { merchantId?: string }) {
  const conditions: SQL[] = [];
  if (f.status) conditions.push(eq(s.orders.status, f.status));
  if (f.merchantId) conditions.push(eq(s.orders.merchantId, f.merchantId));
  return listOrders(db, conditions, f.page, f.pageSize);
}
