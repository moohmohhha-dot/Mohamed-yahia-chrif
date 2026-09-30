import { and, desc, eq, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';

export type InventoryReason = (typeof s.inventoryReason.enumValues)[number];
/** Reasons a merchant may use by hand. `sale` / `sale_cancelled` are written by the orders module only. */
export const MANUAL_REASONS = ['restock', 'correction', 'damaged', 'returned'] as const;

export async function recordMovement(db: Executor, movement: typeof s.inventoryMovements.$inferInsert) {
  await db.insert(s.inventoryMovements).values(movement);
}

/**
 * Changes stock by `delta` atomically and records why. Stock can never go below zero:
 * the database check constraint rejects it and we report INSUFFICIENT_STOCK.
 */
export async function adjustInventory(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  offerId: string,
  input: { delta: number; reason: (typeof MANUAL_REASONS)[number]; note?: string },
) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId);
    const [current] = await tx
      .select({ stock: s.offers.stockQuantity })
      .from(s.offers)
      .where(and(eq(s.offers.id, offerId), eq(s.offers.merchantId, merchantId)))
      .for('update');
    if (!current) throw notFound('Offer');
    if (current.stock + input.delta < 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${current.stock} in stock`);
    }
    const [offer] = await tx
      .update(s.offers)
      .set({ stockQuantity: sql`${s.offers.stockQuantity} + ${input.delta}` })
      .where(eq(s.offers.id, offerId))
      .returning();
    await recordMovement(tx, {
      offerId,
      merchantId,
      delta: input.delta,
      quantityAfter: offer!.stockQuantity,
      reason: input.reason,
      note: input.note ?? null,
      actorUserId: actor.userId,
    });
    await audit(tx, actor, {
      action: 'offers.inventory.adjusted',
      entityType: 'offer',
      entityId: offerId,
      metadata: { delta: input.delta, reason: input.reason, quantityAfter: offer!.stockQuantity },
    });
    await recordEvent(tx, {
      type: 'offers.inventory.adjusted',
      aggregateType: 'offer',
      aggregateId: offerId,
      payload: { merchantId, delta: input.delta, quantityAfter: offer!.stockQuantity },
    });
    return { offerId, stockQuantity: offer!.stockQuantity };
  });
}

export async function inventoryHistory(db: Database, userId: string, merchantId: string, offerId: string) {
  await requireMembership(db, merchantId, userId);
  const [offer] = await db
    .select({ id: s.offers.id })
    .from(s.offers)
    .where(and(eq(s.offers.id, offerId), eq(s.offers.merchantId, merchantId)));
  if (!offer) throw notFound('Offer');
  return db
    .select({
      id: s.inventoryMovements.id,
      delta: s.inventoryMovements.delta,
      quantityAfter: s.inventoryMovements.quantityAfter,
      reason: s.inventoryMovements.reason,
      note: s.inventoryMovements.note,
      actor: s.users.displayName,
      createdAt: s.inventoryMovements.createdAt,
    })
    .from(s.inventoryMovements)
    .leftJoin(s.users, eq(s.users.id, s.inventoryMovements.actorUserId))
    .where(eq(s.inventoryMovements.offerId, offerId))
    .orderBy(desc(s.inventoryMovements.createdAt))
    .limit(200);
}
