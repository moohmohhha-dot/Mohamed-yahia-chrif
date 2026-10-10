/**
 * Reservations: stock held for an order (or a checkout) between "order placed" and "order shipped".
 *
 *   reserveStock   order created     → reserved += q        (available drops, on hand unchanged)
 *   releaseStock   order cancelled   → reserved -= q        (available comes back)
 *   consumeStock   order shipped     → reserved -= q, on hand -= q
 *
 * Overselling is impossible: every line is checked against available stock while its level rows are
 * locked, the whole request is all-or-nothing, and the database rejects reserved > on hand anyway.
 * All three operations are idempotent per reference, so a retried request never double-books stock.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Transaction } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { recordEvent } from '../platform/index.js';
import { applyChange } from './levels.js';
import { ensureDefaultLocation } from './locations.js';

export type StockReference = { type: string; id: string };
export type ReservationLine = { offerId: string; quantity: number };
type Reservation = typeof s.inventoryReservations.$inferSelect;

const outOfStock = (offerId: string, requested: number, available: number) =>
  new AppError(409, 'OUT_OF_STOCK', `Only ${available} available, ${requested} requested`, { offerId, requested, available });

/** With `lock`, rows are locked and re-checked, so two concurrent releases cannot both release the same hold. */
async function activeFor(tx: Transaction, ref: StockReference, lock = false): Promise<Reservation[]> {
  const query = tx
    .select()
    .from(s.inventoryReservations)
    .where(
      and(
        eq(s.inventoryReservations.referenceType, ref.type),
        eq(s.inventoryReservations.referenceId, ref.id),
        eq(s.inventoryReservations.status, 'active'),
      ),
    );
  return lock ? query.for('update') : query;
}

/**
 * Reserves every line or nothing. Stock is taken from the default location first, then from the
 * locations with the most available stock (a line may be split across locations).
 * Calling it again for the same reference returns the existing reservations.
 */
export async function reserveStock(
  tx: Transaction,
  input: { reference: StockReference; lines: ReservationLine[]; expiresAt?: Date; actorUserId?: string | null },
): Promise<Reservation[]> {
  const existing = await activeFor(tx, input.reference);
  if (existing.length) return existing;

  const merged = new Map<string, number>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw badRequest('INVALID_QUANTITY', 'Quantities must be positive integers');
    merged.set(line.offerId, (merged.get(line.offerId) ?? 0) + line.quantity);
  }
  // Fixed lock order (by offer id) so two orders for the same items cannot deadlock.
  const offerIds = [...merged.keys()].sort();
  const offers = await tx.select().from(s.offers).where(inArray(s.offers.id, offerIds));

  const created: Reservation[] = [];
  for (const offerId of offerIds) {
    const offer = offers.find((o) => o.id === offerId);
    if (!offer || offer.status !== 'active') throw new AppError(409, 'OFFER_UNAVAILABLE', 'This offer is not for sale');
    const wanted = merged.get(offerId)!;

    const levels = await tx
      .select({ level: s.inventoryLevels, isDefault: s.inventoryLocations.isDefault })
      .from(s.inventoryLevels)
      .innerJoin(s.inventoryLocations, eq(s.inventoryLocations.id, s.inventoryLevels.locationId))
      .where(and(eq(s.inventoryLevels.offerId, offerId), eq(s.inventoryLocations.status, 'active')))
      .orderBy(desc(s.inventoryLocations.isDefault), asc(s.inventoryLevels.locationId))
      .for('update', { of: s.inventoryLevels });
    const total = levels.reduce((n, l) => n + l.level.onHand - l.level.reserved, 0);
    if (total < wanted) throw outOfStock(offerId, wanted, total);

    let remaining = wanted;
    const plan = [...levels].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || b.level.onHand - b.level.reserved - (a.level.onHand - a.level.reserved),
    );
    for (const { level } of plan) {
      if (remaining === 0) break;
      const take = Math.min(remaining, level.onHand - level.reserved);
      if (take <= 0) continue;
      await applyChange(tx, offerId, level.locationId, { reserved: take }, {
        merchantId: offer.merchantId,
        reason: 'reserved',
        actorUserId: input.actorUserId,
        referenceType: input.reference.type,
        referenceId: input.reference.id,
      });
      const [row] = await tx
        .insert(s.inventoryReservations)
        .values({
          offerId,
          locationId: level.locationId,
          merchantId: offer.merchantId,
          quantity: take,
          referenceType: input.reference.type,
          referenceId: input.reference.id,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      created.push(row!);
      remaining -= take;
    }
    // Defensive: never leave a line partly reserved.
    if (remaining > 0) throw outOfStock(offerId, wanted, wanted - remaining);
  }
  await recordEvent(tx, {
    type: 'inventory.stock.reserved',
    aggregateType: input.reference.type,
    aggregateId: input.reference.id,
    payload: { lines: input.lines },
  });
  return created;
}

async function close(
  tx: Transaction,
  ref: StockReference,
  outcome: 'released' | 'consumed' | 'expired',
  ctx: { actorUserId?: string | null; reason?: string; expiredBefore?: Date },
) {
  let active = await activeFor(tx, ref, true);
  // An expiry run only closes holds that are still expired now (one may have been extended meanwhile).
  if (ctx.expiredBefore) active = active.filter((r) => r.expiresAt && r.expiresAt <= ctx.expiredBefore!);
  // Lock order must match reserveStock to avoid deadlocks.
  active.sort((a, b) => a.offerId.localeCompare(b.offerId) || a.locationId.localeCompare(b.locationId));
  for (const r of active) {
    await applyChange(
      tx,
      r.offerId,
      r.locationId,
      outcome === 'consumed' ? { reserved: -r.quantity, onHand: -r.quantity } : { reserved: -r.quantity },
      {
        merchantId: r.merchantId,
        reason: outcome === 'consumed' ? 'sale' : 'released',
        note: ctx.reason ?? null,
        actorUserId: ctx.actorUserId,
        referenceType: ref.type,
        referenceId: ref.id,
      },
    );
    await tx
      .update(s.inventoryReservations)
      .set({ status: outcome, closedAt: new Date(), closeReason: ctx.reason ?? null })
      .where(eq(s.inventoryReservations.id, r.id));
  }
  if (active.length) {
    await recordEvent(tx, {
      type: outcome === 'consumed' ? 'inventory.stock.consumed' : 'inventory.stock.released',
      aggregateType: ref.type,
      aggregateId: ref.id,
      payload: { outcome, reservations: active.length },
    });
  }
  return active.length;
}

/** Order cancelled (or checkout abandoned): the held stock becomes available again. Idempotent. */
export const releaseStock = (tx: Transaction, ref: StockReference, ctx: { actorUserId?: string | null; reason?: string } = {}) =>
  close(tx, ref, 'released', ctx);

/** Order shipped: the held stock leaves the warehouse for good. Idempotent. */
export const consumeStock = (tx: Transaction, ref: StockReference, ctx: { actorUserId?: string | null; reason?: string } = {}) =>
  close(tx, ref, 'consumed', ctx);

/** Releases holds whose expiry has passed (run periodically, e.g. every minute). Returns how many references were freed. */
export async function releaseExpiredReservations(db: Database, now = new Date()): Promise<number> {
  const due = await db
    .selectDistinct({ type: s.inventoryReservations.referenceType, id: s.inventoryReservations.referenceId })
    .from(s.inventoryReservations)
    .where(
      and(
        eq(s.inventoryReservations.status, 'active'),
        isNotNull(s.inventoryReservations.expiresAt),
        lte(s.inventoryReservations.expiresAt, now),
      ),
    );
  let freed = 0;
  for (const ref of due) {
    freed += (await db.transaction((tx) => close(tx, ref, 'expired', { reason: 'Reservation expired', expiredBefore: now }))) > 0 ? 1 : 0;
  }
  return freed;
}

/**
 * Returned goods put back on sale (the merchant decided they are resellable): on hand increases at the
 * merchant's default location. Recorded with the order as reference.
 */
export async function receiveReturn(
  tx: Transaction,
  input: { reference: StockReference; merchantId: string; lines: ReservationLine[]; actorUserId?: string | null; note?: string },
) {
  const location = await ensureDefaultLocation(tx, input.merchantId);
  for (const line of [...input.lines].sort((a, b) => a.offerId.localeCompare(b.offerId))) {
    await applyChange(tx, line.offerId, location.id, { onHand: line.quantity }, {
      merchantId: input.merchantId,
      reason: 'returned',
      note: input.note ?? null,
      actorUserId: input.actorUserId,
      referenceType: input.reference.type,
      referenceId: input.reference.id,
    });
  }
}
