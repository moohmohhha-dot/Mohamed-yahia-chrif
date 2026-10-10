/**
 * Cash-on-delivery flows that move orders: confirmation (SMS code from the customer, or a call by the
 * merchant), rescheduling a failed delivery, and a refusal at the door.
 */
import { and, eq } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import {
  assessCustomer,
  codEvent,
  codPolicy,
  codRecord,
  updateCodRecord,
  type CallOutcome,
  type CodPolicy,
  type CustomerAssessment,
  type RefusalReason,
} from '../cod/index.js';
import { requireMembership, type MerchantRole } from '../merchants/index.js';
import { audit, consumeVerificationCode, issueVerificationCode, type MessageSender } from '../platform/index.js';
import { activeShipment } from '../shipping/index.js';
import { updateOrderShipment } from './fulfillment.js';
import { applyTransition, loadForActor, type OrderActor, type OrderDeps } from './service.js';

const SYSTEM: OrderActor = { type: 'system', userId: null, ip: null };
const CODE_PURPOSE = 'cod.confirmation';

/** At checkout: is COD allowed for this customer, and with which risk snapshot. */
export async function codCheckout(db: Executor, storeId: string, customerUserId: string, phone: string): Promise<{ policy: CodPolicy; risk: CustomerAssessment }> {
  const policy = await codPolicy(db, storeId);
  const risk = await assessCustomer(db, { phone, customerUserId }, policy);
  if (risk.blocked) {
    // Neutral wording: the customer is not told about other merchants' orders.
    throw new AppError(409, 'COD_NOT_AVAILABLE', 'Cash on delivery is not available for this order; please pay online');
  }
  return { policy, risk };
}

async function pendingRecords(db: Executor, customerUserId: string, checkoutId: string) {
  const records = await db
    .select()
    .from(s.codOrders)
    .where(and(eq(s.codOrders.checkoutId, checkoutId), eq(s.codOrders.customerUserId, customerUserId), eq(s.codOrders.confirmationStatus, 'pending')));
  if (!records.length) throw new AppError(409, 'NOTHING_TO_CONFIRM', 'No order of this checkout is waiting for confirmation');
  return records;
}

/** Sends the confirmation code by SMS to the delivery phone (one code for the whole checkout). */
export async function sendCodCode(db: Database, messages: MessageSender, customerUserId: string, checkoutId: string) {
  const records = await pendingRecords(db, customerUserId, checkoutId);
  const phone = records[0]!.phone;
  const code = await issueVerificationCode(db, { purpose: CODE_PURPOSE, subjectId: checkoutId, target: phone });
  const amount = records.reduce((sum, r) => sum + r.amountDueMinor, 0n);
  await messages.send({
    channel: 'sms',
    to: phone,
    template: 'cod.confirmation_code',
    params: { code, amountMinor: String(amount), currency: records[0]!.currency },
  });
  for (const r of records) await codEvent(db, r.orderId, { type: 'system', userId: null }, { type: 'code_sent' });
  return { sentTo: `${phone.slice(0, 4)}••••${phone.slice(-2)}`, orders: records.length };
}

/** The customer types the SMS code: every waiting COD order of the checkout is confirmed. */
export async function confirmCodByCode(db: Database, customerUserId: string, checkoutId: string, code: string) {
  const records = await pendingRecords(db, customerUserId, checkoutId);
  // Outside a transaction, so failed attempts are counted.
  await consumeVerificationCode(db, { purpose: CODE_PURPOSE, subjectId: checkoutId, target: records[0]!.phone }, code);
  let confirmed = 0;
  await db.transaction(async (tx) => {
    for (const r of records) {
      const record = await codRecord(tx, r.orderId, true);
      const [order] = await tx.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.id, r.orderId));
      if (record?.confirmationStatus !== 'pending' || order?.status !== 'new') continue;
      await updateCodRecord(tx, r.orderId, { confirmationStatus: 'confirmed', confirmedVia: 'sms_code', confirmedAt: new Date(), confirmedBy: customerUserId });
      await codEvent(tx, r.orderId, { type: 'customer', userId: customerUserId }, { type: 'confirmed', reason: 'sms_code' });
      confirmed++;
    }
  });
  return { confirmed };
}

/**
 * A confirmation call by the merchant (or ARUMA support). Confirmed: the order is confirmed and moves
 * to processing. Declined: cancelled. Wrong number, or no answer after the allowed calls: cancelled as
 * unreachable (the reserved stock goes back on sale).
 */
export async function recordConfirmationCall(db: Database, deps: OrderDeps, actor: OrderActor, orderId: string, input: { outcome: CallOutcome; note?: string }) {
  return db.transaction(async (tx) => {
    let role: MerchantRole | null = null;
    if (actor.type === 'merchant') role = await requireMembership(tx, actor.merchantId!, actor.userId!);
    const order = await loadForActor(tx, actor, orderId, true);
    const record = await codRecord(tx, order.id, true);
    if (!record) throw new AppError(409, 'NOT_COD', 'This order is not paid on delivery');
    if (record.confirmationStatus !== 'pending' || order.status !== 'new') {
      throw new AppError(409, 'COD_ALREADY_DECIDED', 'This order is no longer waiting for confirmation', { confirmationStatus: record.confirmationStatus });
    }
    const policy = await codPolicy(tx, record.storeId);
    const attempt = record.callAttempts + 1;
    const who = { type: actor.type, userId: actor.userId };
    await updateCodRecord(tx, order.id, { callAttempts: attempt });
    await codEvent(tx, order.id, who, { type: 'call', reason: input.outcome, note: input.note, data: { attempt } });

    const cancel = async (reason: string) => {
      await applyTransition(tx, deps, SYSTEM, null, order, { to: 'cancelled', reason });
    };
    if (input.outcome === 'confirmed') {
      await updateCodRecord(tx, order.id, {
        confirmationStatus: 'confirmed',
        confirmedVia: actor.type === 'platform' ? 'platform' : 'phone_call',
        confirmedAt: new Date(),
        confirmedBy: actor.userId,
      });
      await codEvent(tx, order.id, who, { type: 'confirmed', reason: 'phone_call', note: input.note });
      await applyTransition(tx, deps, actor, role, order, { to: 'processing', note: 'Confirmed by phone' });
    } else if (input.outcome === 'declined') {
      await updateCodRecord(tx, order.id, { confirmationStatus: 'declined' });
      await codEvent(tx, order.id, who, { type: 'declined', note: input.note });
      await cancel('The customer declined the order during the confirmation call');
    } else if (input.outcome === 'wrong_number' || attempt >= policy.maxCallAttempts) {
      await updateCodRecord(tx, order.id, { confirmationStatus: 'unreachable' });
      await codEvent(tx, order.id, who, { type: 'unreachable', reason: input.outcome, data: { attempts: attempt } });
      await cancel(input.outcome === 'wrong_number' ? 'Wrong phone number' : `Customer unreachable after ${attempt} calls`);
    }
    await audit(tx, actor, { action: 'cod.call.recorded', entityType: 'order', entityId: order.id, metadata: { outcome: input.outcome, attempt } });
    return { attempt, maxCallAttempts: policy.maxCallAttempts };
  });
}

/** After a failed delivery: when the driver will try again (within the allowed attempts). */
export async function scheduleReattempt(db: Database, actor: OrderActor, orderId: string, input: { at: Date; note?: string }) {
  return db.transaction(async (tx) => {
    if (actor.type === 'merchant') await requireMembership(tx, actor.merchantId!, actor.userId!);
    const order = await loadForActor(tx, actor, orderId, true);
    const record = await codRecord(tx, order.id, true);
    if (!record) throw new AppError(409, 'NOT_COD', 'This order is not paid on delivery');
    const shipment = await activeShipment(tx, order.id);
    if (shipment?.status !== 'delivery_failed') throw new AppError(409, 'NO_FAILED_DELIVERY', 'A new attempt is scheduled after a failed delivery');
    const policy = await codPolicy(tx, record.storeId);
    if (record.deliveryAttempts >= policy.maxDeliveryAttempts) {
      throw new AppError(409, 'COD_MAX_ATTEMPTS', 'The allowed delivery attempts are used up: send the parcel back', {
        attempts: record.deliveryAttempts,
        max: policy.maxDeliveryAttempts,
      });
    }
    const now = Date.now();
    if (input.at.getTime() < now - 3600_000 || input.at.getTime() > now + 14 * 24 * 3600_000) {
      throw badRequest('INVALID_DATE', 'Choose a date within the next 14 days');
    }
    await updateCodRecord(tx, order.id, { nextAttemptAt: input.at });
    await codEvent(tx, order.id, { type: actor.type, userId: actor.userId }, { type: 'reattempt_scheduled', note: input.note, data: { at: input.at.toISOString(), attempt: record.deliveryAttempts + 1 } });
    return { nextAttemptAt: input.at, attempt: record.deliveryAttempts + 1, maxDeliveryAttempts: policy.maxDeliveryAttempts };
  });
}

/** The customer refused the parcel at the door (or at the shop): it goes back to the merchant, nothing is collected. */
export async function recordRefusal(db: Database, deps: OrderDeps, actor: OrderActor, orderId: string, input: { reason: RefusalReason; note?: string }) {
  const shipment = await activeShipment(db, orderId);
  if (!shipment) throw notFound('Shipment');
  const atShop = shipment.status === 'ready_for_pickup';
  if (!atShop && !['in_transit', 'out_for_delivery', 'delivery_failed'].includes(shipment.status)) {
    throw new AppError(409, 'NOT_OUT_FOR_DELIVERY', 'A refusal is recorded while the parcel is being delivered');
  }
  await updateOrderShipment(db, deps, actor, orderId, { status: atShop ? 'returned' : 'returning', refusalReason: input.reason, note: input.note });
}
