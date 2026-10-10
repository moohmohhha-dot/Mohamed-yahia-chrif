/**
 * Orders ⇄ Payment Service.
 *
 * - Online: one payment per checkout (the customer pays once for all merchants' orders).
 *   Orders cannot be confirmed by merchants until the payment is successful.
 * - Cash on delivery: one payment per order, recorded as collected when the order is delivered.
 * - The Payment Service tells us what happened through signed events (handlePaymentEvent); every event
 *   is applied once.
 * - Refunds (full or partial) are requested here by an administrator and executed by the Payment Service.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { postOrderPaid, postOrderRefund } from '../finance/index.js';
import type { PaymentIntent, PaymentsClient } from '../payments/index.js';
import { audit, recordEvent } from '../platform/index.js';
import { transitionOrder, type OrderDeps } from './service.js';

type Order = typeof s.orders.$inferSelect;

async function checkoutOrders(db: Executor, checkoutId: string): Promise<Order[]> {
  return db.select().from(s.orders).where(eq(s.orders.checkoutId, checkoutId));
}

/** Creates (idempotently) the online payment of a checkout and links it to its orders. */
export async function startCheckoutPayment(
  db: Database,
  payments: PaymentsClient,
  checkoutId: string,
  options: { returnUrl: string; locale?: 'ar' | 'fr' | 'en'; paymentMethod?: 'edahabia' | 'cib' },
): Promise<PaymentIntent> {
  const orders = await checkoutOrders(db, checkoutId);
  if (orders.length === 0 || orders.some((o) => o.paymentMethod !== 'online')) throw notFound('Online checkout');
  // Store credit already paid part of the orders: only the rest is paid online.
  const total = orders.reduce((sum, o) => sum + o.totalMinor - o.creditAppliedMinor, 0n);
  if (total <= 0n) throw new AppError(409, 'NOTHING_TO_PAY', 'These orders are fully paid with store credit');
  const intent = await payments.createIntent(`checkout:${checkoutId}`, {
    referenceType: 'checkout',
    referenceId: checkoutId,
    method: 'online',
    amountMinor: Number(total),
    currency: orders[0]!.currency,
    description: `ARUMA ${orders.map((o) => o.number).join(', ')}`,
    returnUrl: options.returnUrl,
    failureUrl: options.returnUrl,
    locale: options.locale,
    ...(options.paymentMethod ? { providerOptions: { paymentMethod: options.paymentMethod } } : {}),
  });
  await db
    .update(s.orders)
    .set({ paymentIntentId: intent.id })
    .where(and(eq(s.orders.checkoutId, checkoutId), sql`${s.orders.paymentIntentId} is null`));
  return intent;
}

const customerView = (i: PaymentIntent) => ({
  intentId: i.id,
  status: i.status,
  amountMinor: i.amountMinor,
  currency: i.currency,
  redirectUrl: i.redirectUrl,
  failureReason: i.failureReason,
});

async function customerCheckout(db: Database, customerUserId: string, checkoutId: string) {
  const orders = await checkoutOrders(db, checkoutId);
  if (!orders.length || orders[0]!.customerUserId !== customerUserId || orders[0]!.paymentMethod !== 'online') throw notFound('Online checkout');
  return orders;
}

/** The customer's view of their checkout payment. With verify, the state is re-read from the provider (on return). */
export async function getCheckoutPayment(db: Database, payments: PaymentsClient, customerUserId: string, checkoutId: string, verify: boolean) {
  const orders = await customerCheckout(db, customerUserId, checkoutId);
  const intentId = orders.find((o) => o.paymentIntentId)?.paymentIntentId;
  if (!intentId) return { intentId: null, status: 'pending' as const, redirectUrl: null, retryable: true };
  const intent = verify ? await payments.verify(intentId) : await payments.getIntent(intentId);
  return { ...customerView(intent), retryable: intent.status === 'failed' };
}

/** Payment Retry from the customer: a new attempt (or the first one, if the payment could not be started). */
export async function retryCheckoutPayment(
  db: Database,
  payments: PaymentsClient,
  customerUserId: string,
  checkoutId: string,
  options: { returnUrl: string; locale?: 'ar' | 'fr' | 'en'; paymentMethod?: 'edahabia' | 'cib' },
) {
  const orders = await customerCheckout(db, customerUserId, checkoutId);
  if (orders.every((o) => o.status === 'cancelled')) throw new AppError(409, 'CHECKOUT_CANCELLED', 'This checkout was cancelled');
  const intentId = orders.find((o) => o.paymentIntentId)?.paymentIntentId;
  const intent = intentId ? await payments.retry(intentId) : await startCheckoutPayment(db, payments, checkoutId, options);
  return customerView(intent);
}

type PaymentEvent = {
  id: string;
  type: string;
  data: { intent: PaymentIntent; lateAfterCancel?: boolean; reason?: string; refund?: { id: string; amountMinor: number; scope: string | null; reason?: string } };
};

const systemActor = { userId: null, ip: null, type: 'system' as const };

/** Orders a payment is for: every order of the checkout (online) or the single order (cash on delivery). */
async function ordersOfIntent(db: Executor, intent: PaymentIntent) {
  if (intent.referenceType === 'checkout') return checkoutOrders(db, intent.referenceId);
  if (intent.referenceType === 'order') return db.select().from(s.orders).where(eq(s.orders.id, intent.referenceId));
  return [];
}

/**
 * Applies one refund to one order, once (keyed by the Payment Service refund id). A fully refunded
 * order that was cancelled or returned becomes "refunded".
 */
async function applyRefund(db: Database, deps: OrderDeps, orderId: string, refund: { id: string; amountMinor: number; reason?: string }, actor: Actor) {
  const order = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(s.orderRefunds)
      .values({ paymentRefundId: refund.id, orderId, amountMinor: BigInt(refund.amountMinor), reason: refund.reason ?? null })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return null; // already applied
    const [current] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId)).for('update');
    const refundedMinor = current!.refundedMinor + BigInt(refund.amountMinor);
    const [updated] = await tx
      .update(s.orders)
      // The money paid is fully refunded (store credit spent on the order is given back separately).
      .set({ refundedMinor, ...(refundedMinor === current!.totalMinor - current!.creditAppliedMinor ? { paymentStatus: 'refunded' as const } : {}) })
      .where(eq(s.orders.id, orderId))
      .returning();
    await postOrderRefund(tx, current!, { id: refund.id, amountMinor: BigInt(refund.amountMinor), reason: refund.reason });
    await audit(tx, actor, {
      action: 'orders.order.refunded',
      entityType: 'order',
      entityId: orderId,
      metadata: { paymentRefundId: refund.id, amountMinor: refund.amountMinor, refundedMinor: Number(refundedMinor) },
    });
    await recordEvent(tx, {
      type: 'orders.order.refunded',
      aggregateType: 'order',
      aggregateId: orderId,
      payload: { amountMinor: refund.amountMinor, refundedMinor: Number(refundedMinor), full: fullyReturned(updated!) },
    });
    return updated!;
  });
  if (order) await markRefundedIfDone(db, deps, actor, order, refund.reason ?? 'Refunded');
}

/** Everything the customer paid (money and store credit) has been given back. */
export const fullyReturned = (o: Order) => o.refundedMinor + o.creditReturnedMinor === o.totalMinor;

/** A cancelled or returned order whose whole value went back to the customer becomes "refunded". */
export async function markRefundedIfDone(db: Database, deps: OrderDeps, actor: Actor, order: Order, reason: string) {
  if (fullyReturned(order) && (order.status === 'cancelled' || order.status === 'returned')) {
    await transitionOrder(db, deps, { ...actor, type: actor.userId ? 'platform' : 'system' }, order.id, { to: 'refunded', reason, viaRefund: true });
  }
}

/** Handles one signed event from the Payment Service. Returns false if it was already handled. */
export async function handlePaymentEvent(db: Database, deps: OrderDeps, event: PaymentEvent): Promise<boolean> {
  const [fresh] = await db
    .insert(s.receivedPaymentEvents)
    .values({ eventId: event.id, type: event.type })
    .onConflictDoNothing()
    .returning();
  if (!fresh) return false;

  const intent = event.data.intent;
  const orders = await ordersOfIntent(db, intent);
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return true;
  const setPayment = (status: Order['paymentStatus']) =>
    db
      .update(s.orders)
      .set({ paymentStatus: status })
      .where(and(inArray(s.orders.id, ids), sql`${s.orders.paymentStatus} not in ('successful', 'refunded')`));

  switch (event.type) {
    case 'payment.succeeded': {
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(s.orders)
          .set({ paymentStatus: 'successful' })
          .where(and(inArray(s.orders.id, ids), inArray(s.orders.paymentStatus, ['pending', 'failed', 'cancelled'])))
          .returning();
        // The money is now held by the provider for these orders.
        for (const order of updated) await postOrderPaid(tx, order);
      });
      const cancelled = orders.filter((o) => o.status === 'cancelled');
      if (cancelled.length) {
        // Money arrived for orders that no longer exist (late payment): an administrator must refund it.
        await audit(db, null, { action: 'orders.payment.needs_refund', entityType: 'checkout', entityId: intent.referenceId, metadata: { orderIds: cancelled.map((o) => o.id) } });
        await recordEvent(db, { type: 'orders.payment.needs_refund', aggregateType: 'checkout', aggregateId: intent.referenceId, payload: { intentId: intent.id } });
      }
      break;
    }
    case 'payment.failed':
      await setPayment('failed');
      break;
    case 'payment.cancelled': {
      await setPayment('cancelled');
      for (const order of orders.filter((o) => o.status === 'new' || o.status === 'processing')) {
        await transitionOrder(db, deps, systemActor, order.id, { to: 'cancelled', reason: 'Payment cancelled' });
      }
      break;
    }
    case 'payment.refund_succeeded': {
      const refund = event.data.refund!;
      const target = refund.scope && ids.includes(refund.scope) ? refund.scope : ids.length === 1 ? ids[0]! : null;
      if (target) await applyRefund(db, deps, target, refund, { userId: null, ip: null });
      break;
    }
    case 'payment.needs_review':
      await audit(db, null, { action: 'orders.payment.needs_review', entityType: intent.referenceType, entityId: intent.referenceId, metadata: { reason: event.data.reason } });
      await recordEvent(db, { type: 'orders.payment.needs_review', aggregateType: intent.referenceType, aggregateId: intent.referenceId, payload: { reason: event.data.reason } });
      break;
    default:
      break; // payment.refunded, payment.refund_failed: nothing to change on orders
  }
  return true;
}

/**
 * Refund or Partial Refund of one order, by an administrator. The Payment Service returns the money
 * (through the provider, or records a manual refund with its proof); the order is updated once.
 */
export async function refundOrder(
  db: Database,
  deps: OrderDeps,
  admin: Actor,
  orderId: string,
  idempotencyKey: string,
  input: { amountMinor: number; reason: string; externalReference?: string },
): Promise<{ refundId: string }> {
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, orderId));
  if (!order) throw notFound('Order');
  if (order.paymentStatus !== 'successful' || !order.paymentIntentId) {
    throw new AppError(409, 'NOTHING_TO_REFUND', 'No payment has been received for this order');
  }
  // Money can be refunded up to what was paid in money and not yet given back (credit goes back as credit).
  const moneyLeft = order.totalMinor - order.creditAppliedMinor - order.refundedMinor;
  const valueLeft = order.totalMinor - order.refundedMinor - order.creditReturnedMinor;
  const refundable = moneyLeft < valueLeft ? moneyLeft : valueLeft;
  if (BigInt(input.amountMinor) > refundable) {
    throw new AppError(409, 'REFUND_EXCEEDS_ORDER', `At most ${refundable} can be refunded for this order`, { refundableMinor: Number(refundable) });
  }
  const { refundId } = await deps.payments.refund(order.paymentIntentId, `order-refund:${orderId}:${idempotencyKey}`, {
    amountMinor: input.amountMinor,
    reason: input.reason,
    requestedBy: admin.userId ? `user:${admin.userId}` : 'system',
    externalReference: input.externalReference,
    scope: orderId,
  });
  await applyRefund(db, deps, orderId, { id: refundId, amountMinor: input.amountMinor, reason: input.reason }, admin);
  return { refundId };
}

/** Cancels online checkouts left unpaid for too long, releasing their stock. Run periodically. */
export async function expireUnpaidCheckouts(db: Database, deps: OrderDeps, olderThanMinutes = 60, now = new Date()) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const stale = await db
    .selectDistinct({ checkoutId: s.orders.checkoutId, intentId: s.orders.paymentIntentId })
    .from(s.orders)
    .where(
      and(
        eq(s.orders.paymentMethod, 'online'),
        inArray(s.orders.paymentStatus, ['pending', 'failed']),
        eq(s.orders.status, 'new'),
        lt(s.orders.placedAt, cutoff),
      ),
    );
  for (const { checkoutId, intentId } of stale) {
    if (intentId) {
      const intent = await deps.payments.cancel(intentId, 'Checkout not paid in time').catch(() => null);
      if (intent?.status === 'successful') continue; // paid at the last moment: keep the orders
    }
    for (const order of await checkoutOrders(db, checkoutId)) {
      if (order.status === 'new' && order.paymentStatus !== 'successful') {
        await transitionOrder(db, deps, systemActor, order.id, { to: 'cancelled', reason: 'Not paid in time' });
      }
    }
  }
  return stale.length;
}
