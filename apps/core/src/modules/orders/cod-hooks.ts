/**
 * What cash on delivery changes in the order and parcel flow. Called inside the transactions of
 * checkout (checkout.ts), status changes (service.ts) and parcel updates (fulfillment.ts).
 */
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { codEvent, codPolicy, codRecord, updateCodRecord, type CodActor, type FailureReason, type RefusalReason } from '../cod/index.js';
import type { ShipmentStatus } from '../shipping/index.js';
import type { OrderStatus } from './transitions.js';

type Order = typeof s.orders.$inferSelect;

/** A COD order is prepared only once the customer confirmed it (SMS code or call), when the policy asks for it. */
export async function assertCodConfirmed(db: Executor, order: Order) {
  if (order.paymentMethod !== 'cash_on_delivery') return;
  const record = await codRecord(db, order.id);
  if (record && record.confirmationStatus !== 'confirmed' && record.confirmationStatus !== 'not_required') {
    throw new AppError(409, 'COD_NOT_CONFIRMED', 'Confirm the order with the customer first (SMS code or phone call)', {
      confirmationStatus: record.confirmationStatus,
    });
  }
}

/** Collection and outcome follow the order: delivered = cash collected; cancelled or returned unpaid = not collected. */
export async function codAfterTransition(db: Executor, order: Order, to: OrderStatus, actor: CodActor) {
  if (order.paymentMethod !== 'cash_on_delivery') return;
  const record = await codRecord(db, order.id, true);
  if (!record) return;
  if (to === 'delivered' && record.collectionStatus === 'awaiting') {
    // With a courier, the courier holds the cash until it pays the merchant; otherwise the merchant has it.
    const holder = order.delivery?.type === 'courier' || order.delivery?.type === 'pickup_point' ? 'with_courier' : 'with_merchant';
    await updateCodRecord(db, order.id, {
      outcome: 'delivered',
      collectionStatus: holder,
      collectedAmountMinor: record.amountDueMinor,
      collectedAt: new Date(),
      nextAttemptAt: null,
    });
    await codEvent(db, order.id, actor, { type: 'collected', data: { amountMinor: Number(record.amountDueMinor), holder } });
  }
  if ((to === 'cancelled' || to === 'returned') && record.collectionStatus === 'awaiting') {
    const outcome = to === 'cancelled' ? 'cancelled' : record.outcome === 'refused' ? 'refused' : 'failed';
    await updateCodRecord(db, order.id, { outcome, collectionStatus: 'not_collected', nextAttemptAt: null });
    await codEvent(db, order.id, actor, { type: 'not_collected', reason: to });
  }
}

export type ParcelUpdate = { status: ShipmentStatus; reason?: FailureReason; refusalReason?: RefusalReason; note?: string };

/**
 * Before a parcel update is recorded: a failed delivery needs a reason; once the allowed number of
 * attempts has failed, the parcel can only go back to the merchant.
 */
export async function codBeforeParcelUpdate(db: Executor, order: Order, from: ShipmentStatus, update: ParcelUpdate, source: string) {
  if (order.paymentMethod !== 'cash_on_delivery') return;
  const record = await codRecord(db, order.id);
  if (!record) return;
  if (update.status === 'delivery_failed' && from !== 'delivery_failed' && source !== 'courier' && !update.reason) {
    throw badRequest('FAILURE_REASON_REQUIRED', 'Say why the delivery failed');
  }
  if (from === 'delivery_failed' && (update.status === 'out_for_delivery' || update.status === 'in_transit') && source !== 'courier') {
    const policy = await codPolicy(db, record.storeId);
    if (record.deliveryAttempts >= policy.maxDeliveryAttempts) {
      throw new AppError(409, 'COD_MAX_ATTEMPTS', 'The allowed delivery attempts are used up: send the parcel back', {
        attempts: record.deliveryAttempts,
        max: policy.maxDeliveryAttempts,
      });
    }
  }
}

/** After a parcel update: count failed attempts, record refusals. */
export async function codAfterParcelUpdate(db: Executor, order: Order, from: ShipmentStatus, to: ShipmentStatus, update: ParcelUpdate, actor: CodActor) {
  if (order.paymentMethod !== 'cash_on_delivery') return;
  const record = await codRecord(db, order.id, true);
  if (!record) return;
  if (to === 'delivery_failed' && from !== 'delivery_failed') {
    const reason = update.reason ?? 'other';
    await updateCodRecord(db, order.id, { deliveryAttempts: record.deliveryAttempts + 1, lastFailureReason: reason, nextAttemptAt: null });
    await codEvent(db, order.id, actor, { type: 'delivery_failed', reason, note: update.note, data: { attempt: record.deliveryAttempts + 1 } });
  }
  if (from === 'delivery_failed' && (to === 'out_for_delivery' || to === 'in_transit')) {
    await updateCodRecord(db, order.id, { nextAttemptAt: null });
  }
  if (update.refusalReason && (to === 'returning' || to === 'returned') && record.outcome === 'open') {
    await updateCodRecord(db, order.id, { outcome: 'refused', refusalReason: update.refusalReason, collectionStatus: 'not_collected', nextAttemptAt: null });
    await codEvent(db, order.id, actor, { type: 'refused', reason: update.refusalReason, note: update.note });
  }
}
