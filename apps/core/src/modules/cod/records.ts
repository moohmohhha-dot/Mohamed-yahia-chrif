/**
 * The COD record of an order and its append-only history. The orders module decides when these are
 * called; this file only keeps the record consistent.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type CodRisk, type Database } from '@aruma/db';
import { sequential, type Executor } from '../../shared/db.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';
import { codPolicy } from './policy.js';

type Order = typeof s.orders.$inferSelect;
export type CodRecord = typeof s.codOrders.$inferSelect;
export type CodEventType = (typeof s.codEventType.enumValues)[number];
export type CodActor = { type: (typeof s.orderActorType.enumValues)[number]; userId: string | null };

export async function codRecord(db: Executor, orderId: string, lock = false): Promise<CodRecord | null> {
  const query = db.select().from(s.codOrders).where(eq(s.codOrders.orderId, orderId));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

export async function codEvent(
  db: Executor,
  orderId: string,
  actor: CodActor,
  event: { type: CodEventType; reason?: string | null; note?: string | null; data?: Record<string, unknown> },
) {
  await db.insert(s.codEvents).values({
    orderId,
    type: event.type,
    reason: event.reason ?? null,
    note: event.note?.trim() || null,
    actorType: actor.type,
    actorUserId: actor.userId,
    data: event.data ?? {},
  });
}

/** Creates the COD record when a cash-on-delivery order is placed. */
export async function openCodRecord(db: Executor, order: Order, input: { requireConfirmation: boolean; risk: CodRisk }) {
  const [row] = await db
    .insert(s.codOrders)
    .values({
      orderId: order.id,
      checkoutId: order.checkoutId,
      storeId: order.storeId,
      merchantId: order.merchantId,
      customerUserId: order.customerUserId,
      phone: order.shippingAddress.phone,
      amountDueMinor: order.totalMinor - order.refundedMinor,
      currency: order.currency,
      confirmationStatus: input.requireConfirmation ? 'pending' : 'not_required',
      // Only the snapshot (level, score, reasons), not the history behind it.
      risk: { level: input.risk.level, score: input.risk.score, reasons: input.risk.reasons },
    })
    .returning();
  await codEvent(db, order.id, { type: 'customer', userId: order.customerUserId }, { type: 'created', data: { risk: input.risk.level } });
  return row!;
}

export async function updateCodRecord(db: Executor, orderId: string, patch: Partial<typeof s.codOrders.$inferInsert>) {
  const [row] = await db.update(s.codOrders).set(patch).where(eq(s.codOrders.orderId, orderId)).returning();
  return row!;
}

/** What each audience sees. Customers: confirmation, amount and attempts; merchants and staff: also risk and history. */
export async function describeCod(db: Executor, record: CodRecord, view: 'customer' | 'merchant' | 'platform') {
  const base = {
    confirmationStatus: record.confirmationStatus,
    confirmedVia: record.confirmedVia,
    confirmedAt: record.confirmedAt,
    amountDueMinor: Number(record.amountDueMinor),
    currency: record.currency,
    deliveryAttempts: record.deliveryAttempts,
    nextAttemptAt: record.nextAttemptAt,
    outcome: record.outcome,
  };
  if (view === 'customer') return base;
  const [policy, events] = await sequential([
    codPolicy(db, record.storeId),
    db
      .select({
        type: s.codEvents.type,
        reason: s.codEvents.reason,
        note: s.codEvents.note,
        actorType: s.codEvents.actorType,
        actorName: s.users.displayName,
        data: s.codEvents.data,
        createdAt: s.codEvents.createdAt,
      })
      .from(s.codEvents)
      .leftJoin(s.users, eq(s.users.id, s.codEvents.actorUserId))
      .where(eq(s.codEvents.orderId, record.orderId))
      .orderBy(asc(s.codEvents.createdAt), asc(s.codEvents.id)),
  ]);
  return {
    ...base,
    callAttempts: record.callAttempts,
    maxCallAttempts: policy.maxCallAttempts,
    maxDeliveryAttempts: policy.maxDeliveryAttempts,
    lastFailureReason: record.lastFailureReason,
    refusalReason: record.refusalReason,
    collectionStatus: record.collectionStatus,
    collectedAmountMinor: record.collectedAmountMinor === null ? null : Number(record.collectedAmountMinor),
    collectedAt: record.collectedAt,
    remittanceId: record.remittanceId,
    risk: record.risk,
    events,
  };
}

// --- Courier remittances -------------------------------------------------------------------------------

/** Where the merchant's cash is: still to collect, held by each courier, received. */
export async function codSummary(db: Executor, merchantId: string) {
  const byStatus = await db
    .select({
      collectionStatus: s.codOrders.collectionStatus,
      outcome: s.codOrders.outcome,
      currency: s.codOrders.currency,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(coalesce(${s.codOrders.collectedAmountMinor}, ${s.codOrders.amountDueMinor})), 0)::text`,
    })
    .from(s.codOrders)
    .where(eq(s.codOrders.merchantId, merchantId))
    .groupBy(s.codOrders.collectionStatus, s.codOrders.outcome, s.codOrders.currency);
  const withCourier = await db
    .select({
      orderId: s.codOrders.orderId,
      number: s.orders.number,
      courierCode: s.shipments.courierCode,
      trackingNumber: s.shipments.trackingNumber,
      amountMinor: s.codOrders.collectedAmountMinor,
      currency: s.codOrders.currency,
      collectedAt: s.codOrders.collectedAt,
    })
    .from(s.codOrders)
    .innerJoin(s.orders, eq(s.orders.id, s.codOrders.orderId))
    .leftJoin(s.shipments, and(eq(s.shipments.orderId, s.codOrders.orderId), sql`${s.shipments.status} <> 'cancelled'`))
    .where(and(eq(s.codOrders.merchantId, merchantId), eq(s.codOrders.collectionStatus, 'with_courier')))
    .orderBy(asc(s.codOrders.collectedAt));
  const sum = (pred: (r: (typeof byStatus)[number]) => boolean) =>
    byStatus.filter(pred).reduce((acc, r) => ({ count: acc.count + r.count, amountMinor: acc.amountMinor + Number(r.amount) }), { count: 0, amountMinor: 0 });
  const delivered = sum((r) => r.outcome === 'delivered').count;
  const refused = sum((r) => r.outcome === 'refused').count;
  return {
    awaiting: sum((r) => r.collectionStatus === 'awaiting' && r.outcome === 'open'),
    withCourier: sum((r) => r.collectionStatus === 'with_courier'),
    withMerchant: sum((r) => r.collectionStatus === 'with_merchant'),
    notCollected: sum((r) => r.collectionStatus === 'not_collected'),
    /** Refusals among parcels that reached the door. */
    refusalRate: delivered + refused ? refused / (delivered + refused) : null,
    pendingRemittance: withCourier.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) })),
  };
}

export async function listRemittances(db: Executor, merchantId: string) {
  const rows = await db.select().from(s.codRemittances).where(eq(s.codRemittances.merchantId, merchantId)).orderBy(desc(s.codRemittances.createdAt));
  return rows.map((r) => ({ ...r, collectedMinor: Number(r.collectedMinor), courierFeesMinor: Number(r.courierFeesMinor), receivedMinor: Number(r.receivedMinor) }));
}

/**
 * The courier paid the merchant for a set of orders. The amounts must add up: cash collected − courier
 * fees = amount received; otherwise nothing is recorded and the difference is shown.
 */
export async function recordRemittance(
  db: Database,
  actor: Actor,
  merchantId: string,
  input: { courierCode: string; reference: string; orderIds: string[]; courierFeesMinor: number; receivedMinor: number },
) {
  return db.transaction(async (tx) => {
    const orderIds = [...new Set(input.orderIds)];
    const records = await tx
      .select({ record: s.codOrders, courierCode: s.shipments.courierCode })
      .from(s.codOrders)
      .leftJoin(s.shipments, and(eq(s.shipments.orderId, s.codOrders.orderId), sql`${s.shipments.status} <> 'cancelled'`))
      .where(and(inArray(s.codOrders.orderId, orderIds), eq(s.codOrders.merchantId, merchantId)))
      .for('update', { of: s.codOrders });
    const wrong = orderIds.filter((id) => {
      const r = records.find((x) => x.record.orderId === id);
      return !r || r.record.collectionStatus !== 'with_courier' || r.courierCode !== input.courierCode;
    });
    if (wrong.length) throw new AppError(409, 'NOT_WITH_THIS_COURIER', 'Some orders are not waiting for payment from this courier', { orderIds: wrong });
    const currencies = new Set(records.map((r) => r.record.currency));
    if (currencies.size !== 1) throw badRequest('MIXED_CURRENCIES', 'A remittance is in one currency');
    const collected = records.reduce((sum, r) => sum + (r.record.collectedAmountMinor ?? 0n), 0n);
    const expected = collected - BigInt(input.courierFeesMinor);
    if (expected !== BigInt(input.receivedMinor)) {
      throw new AppError(409, 'AMOUNT_MISMATCH', 'Collected cash minus courier fees does not match the amount received', {
        collectedMinor: Number(collected),
        courierFeesMinor: input.courierFeesMinor,
        expectedMinor: Number(expected),
        receivedMinor: input.receivedMinor,
      });
    }
    const [remittance] = await tx
      .insert(s.codRemittances)
      .values({
        merchantId,
        courierCode: input.courierCode,
        reference: input.reference,
        currency: [...currencies][0]!,
        collectedMinor: collected,
        courierFeesMinor: BigInt(input.courierFeesMinor),
        receivedMinor: BigInt(input.receivedMinor),
        orderCount: orderIds.length,
        createdBy: actor.userId,
      })
      .returning();
    for (const id of orderIds) {
      await updateCodRecord(tx, id, { collectionStatus: 'with_merchant', remittanceId: remittance!.id });
      await codEvent(tx, id, { type: 'merchant', userId: actor.userId }, { type: 'remitted', note: input.reference, data: { remittanceId: remittance!.id } });
    }
    await audit(tx, actor, { action: 'cod.remittance.recorded', entityType: 'cod_remittance', entityId: remittance!.id, metadata: { reference: input.reference, orders: orderIds.length } });
    return { ...remittance!, collectedMinor: Number(remittance!.collectedMinor), courierFeesMinor: Number(remittance!.courierFeesMinor), receivedMinor: Number(remittance!.receivedMinor) };
  });
}

// --- Blocks (ARUMA staff) -------------------------------------------------------------------------------

export async function blockPhone(db: Database, actor: Actor, phone: string, reason: string) {
  return db.transaction(async (tx) => {
    const [block] = await tx.insert(s.codBlocks).values({ phone, reason, createdBy: actor.userId }).returning();
    await audit(tx, actor, { action: 'cod.phone.blocked', entityType: 'cod_block', entityId: block!.id, metadata: { reason } });
    return block!;
  });
}

export async function liftBlock(db: Database, actor: Actor, blockId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [block] = await tx.select().from(s.codBlocks).where(eq(s.codBlocks.id, blockId)).for('update');
    if (!block) throw notFound('Block');
    if (block.liftedAt) throw new AppError(409, 'ALREADY_LIFTED', 'This block was already lifted');
    const [lifted] = await tx.update(s.codBlocks).set({ liftedAt: new Date(), liftedBy: actor.userId, liftReason: reason }).where(eq(s.codBlocks.id, blockId)).returning();
    await audit(tx, actor, { action: 'cod.phone.unblocked', entityType: 'cod_block', entityId: blockId, metadata: { reason } });
    return lifted!;
  });
}
