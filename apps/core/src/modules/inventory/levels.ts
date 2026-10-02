/**
 * Low-level stock operations. Every function here runs inside the caller's transaction and records
 * exactly one movement per level change, so history and quantities can never disagree.
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Transaction } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';

export type InventoryReason = (typeof s.inventoryReason.enumValues)[number];
/** Reasons a merchant may use for a manual adjustment. Others are written by the system only. */
export const MANUAL_REASONS = ['restock', 'correction', 'damaged', 'returned'] as const;

export type MovementContext = {
  merchantId: string;
  reason: InventoryReason;
  note?: string | null;
  actorUserId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
};

export const insufficientStock = (available: number) =>
  new AppError(409, 'INSUFFICIENT_STOCK', `Only ${available} available at this location`);

/** Locks (creating if needed) the level row of an offer at a location. */
export async function lockLevel(tx: Transaction, offerId: string, locationId: string) {
  await tx.insert(s.inventoryLevels).values({ offerId, locationId }).onConflictDoNothing();
  const [level] = await tx
    .select()
    .from(s.inventoryLevels)
    .where(and(eq(s.inventoryLevels.offerId, offerId), eq(s.inventoryLevels.locationId, locationId)))
    .for('update');
  return level!;
}

/**
 * Applies an on-hand change and/or a reserved change to one level and records the movement.
 * Throws INSUFFICIENT_STOCK if the result would sell stock that is not there
 * (on hand below zero, or below what is already reserved).
 */
export async function applyChange(
  tx: Transaction,
  offerId: string,
  locationId: string,
  change: { onHand?: number; reserved?: number },
  ctx: MovementContext,
) {
  const level = await lockLevel(tx, offerId, locationId);
  const onHand = level.onHand + (change.onHand ?? 0);
  const reserved = level.reserved + (change.reserved ?? 0);
  if (onHand < 0 || reserved < 0 || reserved > onHand) throw insufficientStock(level.onHand - level.reserved);

  await tx
    .update(s.inventoryLevels)
    .set({ onHand, reserved })
    .where(and(eq(s.inventoryLevels.offerId, offerId), eq(s.inventoryLevels.locationId, locationId)));
  await tx.insert(s.inventoryMovements).values({
    offerId,
    merchantId: ctx.merchantId,
    locationId,
    delta: change.onHand ?? 0,
    quantityAfter: onHand,
    reservedDelta: change.reserved ?? 0,
    reservedAfter: reserved,
    reason: ctx.reason,
    note: ctx.note ?? null,
    actorUserId: ctx.actorUserId ?? null,
    referenceType: ctx.referenceType ?? null,
    referenceId: ctx.referenceId ?? null,
  });
  return { onHand, reserved, available: onHand - reserved };
}

/** Sets on-hand to an absolute value (stock count). No movement is recorded when nothing changes. */
export async function setOnHand(tx: Transaction, offerId: string, locationId: string, target: number, ctx: MovementContext) {
  const level = await lockLevel(tx, offerId, locationId);
  if (level.onHand === target) return { onHand: level.onHand, reserved: level.reserved, available: level.onHand - level.reserved };
  return applyChange(tx, offerId, locationId, { onHand: target - level.onHand }, ctx);
}

/** Offer-wide totals (kept in sync by the database trigger). */
export async function offerTotals(tx: Transaction, offerId: string) {
  const [row] = await tx
    .select({
      onHand: s.offers.onHandQuantity,
      reserved: s.offers.reservedQuantity,
      available: s.offers.availableQuantity,
    })
    .from(s.offers)
    .where(eq(s.offers.id, offerId));
  return row!;
}

export const sumAvailable = sql<number>`coalesce(sum(${s.inventoryLevels.onHand} - ${s.inventoryLevels.reserved}), 0)`.mapWith(Number);
