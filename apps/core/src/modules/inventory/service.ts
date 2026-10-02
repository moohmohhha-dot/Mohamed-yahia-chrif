/** Merchant-facing inventory operations: overview, adjustments, stock counts, transfers, history. */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';
import { applyChange, lockLevel, MANUAL_REASONS, offerTotals, setOnHand } from './levels.js';
import { ensureDefaultLocation, getLocation } from './locations.js';

type MemberActor = Actor & { userId: string };

export async function getMerchantOffer(db: Executor, merchantId: string, offerId: string) {
  const [offer] = await db
    .select()
    .from(s.offers)
    .where(and(eq(s.offers.id, offerId), eq(s.offers.merchantId, merchantId)));
  if (!offer) throw notFound('Offer');
  return offer;
}

async function activeLocation(db: Executor, merchantId: string, locationId: string | undefined) {
  const location = locationId ? await getLocation(db, merchantId, locationId) : await ensureDefaultLocation(db, merchantId);
  if (location.status !== 'active') throw conflict('LOCATION_ARCHIVED', 'This location is archived');
  return location;
}

/** Adds or removes stock at a location. Reserved stock can never be removed. */
export async function adjustStock(
  db: Database,
  actor: MemberActor,
  merchantId: string,
  offerId: string,
  input: { locationId?: string; delta: number; reason: (typeof MANUAL_REASONS)[number]; note?: string },
) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId);
    await getMerchantOffer(tx, merchantId, offerId);
    const location = await activeLocation(tx, merchantId, input.locationId);
    const level = await applyChange(tx, offerId, location.id, { onHand: input.delta }, {
      merchantId,
      reason: input.reason,
      note: input.note,
      actorUserId: actor.userId,
    });
    await audit(tx, actor, {
      action: 'inventory.stock.adjusted',
      entityType: 'offer',
      entityId: offerId,
      metadata: { locationId: location.id, delta: input.delta, reason: input.reason },
    });
    await recordEvent(tx, {
      type: 'inventory.stock.adjusted',
      aggregateType: 'offer',
      aggregateId: offerId,
      payload: { merchantId, locationId: location.id, delta: input.delta },
    });
    return { offerId, locationId: location.id, level, totals: await offerTotals(tx, offerId) };
  });
}

/** Stock count: sets on-hand at a location to what was physically counted. */
export async function countStock(
  db: Database,
  actor: MemberActor,
  merchantId: string,
  offerId: string,
  input: { locationId?: string; quantity: number; note?: string },
) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId);
    await getMerchantOffer(tx, merchantId, offerId);
    const location = await activeLocation(tx, merchantId, input.locationId);
    const level = await setOnHand(tx, offerId, location.id, input.quantity, {
      merchantId,
      reason: 'correction',
      note: input.note ?? 'Stock count',
      actorUserId: actor.userId,
    });
    await audit(tx, actor, {
      action: 'inventory.stock.counted',
      entityType: 'offer',
      entityId: offerId,
      metadata: { locationId: location.id, quantity: input.quantity },
    });
    return { offerId, locationId: location.id, level, totals: await offerTotals(tx, offerId) };
  });
}

/** Moves available (not reserved) stock between two of the merchant's locations. */
export async function transferStock(
  db: Database,
  actor: MemberActor,
  merchantId: string,
  input: { offerId: string; fromLocationId: string; toLocationId: string; quantity: number; note?: string },
) {
  if (input.fromLocationId === input.toLocationId) throw badRequest('SAME_LOCATION', 'Choose two different locations');
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    await getMerchantOffer(tx, merchantId, input.offerId);
    const from = await activeLocation(tx, merchantId, input.fromLocationId);
    const to = await activeLocation(tx, merchantId, input.toLocationId);
    const transferId = randomUUID();
    const ctx = { merchantId, note: input.note, actorUserId: actor.userId, referenceType: 'transfer', referenceId: transferId };
    // Lock in a fixed order so two opposite transfers cannot deadlock.
    const [first, second] = [from, to].sort((a, b) => a.id.localeCompare(b.id));
    await lockLevel(tx, input.offerId, first!.id);
    await lockLevel(tx, input.offerId, second!.id);
    const out = await applyChange(tx, input.offerId, from.id, { onHand: -input.quantity }, { ...ctx, reason: 'transfer_out' });
    const into = await applyChange(tx, input.offerId, to.id, { onHand: input.quantity }, { ...ctx, reason: 'transfer_in' });
    await audit(tx, actor, {
      action: 'inventory.stock.transferred',
      entityType: 'offer',
      entityId: input.offerId,
      metadata: { transferId, from: from.code, to: to.code, quantity: input.quantity },
    });
    await recordEvent(tx, {
      type: 'inventory.stock.transferred',
      aggregateType: 'offer',
      aggregateId: input.offerId,
      payload: { merchantId, transferId, fromLocationId: from.id, toLocationId: to.id, quantity: input.quantity },
    });
    return { transferId, from: { locationId: from.id, ...out }, to: { locationId: to.id, ...into } };
  });
}

export async function setLowStockThreshold(db: Database, actor: MemberActor, merchantId: string, offerId: string, threshold: number | null) {
  await requireMembership(db, merchantId, actor.userId);
  await getMerchantOffer(db, merchantId, offerId);
  const [row] = await db.update(s.offers).set({ lowStockThreshold: threshold }).where(eq(s.offers.id, offerId)).returning();
  return { offerId, lowStockThreshold: row!.lowStockThreshold };
}

const isLow = sql<boolean>`${s.offers.lowStockThreshold} is not null and ${s.offers.availableQuantity} <= ${s.offers.lowStockThreshold}`;

/** Every offer with its totals, low-stock flag and per-location levels. */
export async function listInventory(
  db: Database,
  userId: string,
  merchantId: string,
  filter: { lowStock?: boolean; q?: string; locationId?: string } = {},
) {
  await requireMembership(db, merchantId, userId);
  const conditions = [eq(s.offers.merchantId, merchantId)];
  if (filter.lowStock) conditions.push(sql`${isLow} and ${s.offers.status} = 'active'`);
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        ilike(s.offers.sku, pattern),
        inArray(
          s.productVariants.productId,
          db.select({ id: s.productTranslations.productId }).from(s.productTranslations).where(ilike(s.productTranslations.name, pattern)),
        ),
      )!,
    );
  }
  const rows = await db
    .select({
      offer: s.offers,
      variantSku: s.productVariants.sku,
      options: s.productVariants.options,
      productId: s.productVariants.productId,
      lowStock: isLow,
    })
    .from(s.offers)
    .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
    .where(and(...conditions))
    .orderBy(asc(s.offers.sku))
    .limit(500);
  if (rows.length === 0) return [];

  const offerIds = rows.map((r) => r.offer.id);
  const levels = await db
    .select({
      offerId: s.inventoryLevels.offerId,
      locationId: s.inventoryLevels.locationId,
      locationCode: s.inventoryLocations.code,
      onHand: s.inventoryLevels.onHand,
      reserved: s.inventoryLevels.reserved,
    })
    .from(s.inventoryLevels)
    .innerJoin(s.inventoryLocations, eq(s.inventoryLocations.id, s.inventoryLevels.locationId))
    .where(inArray(s.inventoryLevels.offerId, offerIds))
    .orderBy(asc(s.inventoryLocations.code));
  const names = await db
    .select()
    .from(s.productTranslations)
    .where(inArray(s.productTranslations.productId, [...new Set(rows.map((r) => r.productId))]));

  return rows
    .map((r) => ({
      offerId: r.offer.id,
      sku: r.offer.sku,
      variantSku: r.variantSku,
      options: r.options,
      status: r.offer.status,
      productNames: Object.fromEntries(names.filter((n) => n.productId === r.productId).map((n) => [n.locale, n.name])),
      onHand: r.offer.onHandQuantity,
      reserved: r.offer.reservedQuantity,
      available: r.offer.availableQuantity,
      lowStockThreshold: r.offer.lowStockThreshold,
      lowStock: Boolean(r.lowStock),
      locations: levels
        .filter((l) => l.offerId === r.offer.id)
        .map(({ offerId: _o, ...l }) => ({ ...l, available: l.onHand - l.reserved })),
    }))
    .filter((r) => !filter.locationId || r.locations.some((l) => l.locationId === filter.locationId));
}

export async function inventoryHistory(db: Database, userId: string, merchantId: string, offerId: string) {
  await requireMembership(db, merchantId, userId);
  await getMerchantOffer(db, merchantId, offerId);
  return db
    .select({
      id: s.inventoryMovements.id,
      locationCode: s.inventoryLocations.code,
      delta: s.inventoryMovements.delta,
      quantityAfter: s.inventoryMovements.quantityAfter,
      reservedDelta: s.inventoryMovements.reservedDelta,
      reservedAfter: s.inventoryMovements.reservedAfter,
      reason: s.inventoryMovements.reason,
      note: s.inventoryMovements.note,
      referenceType: s.inventoryMovements.referenceType,
      referenceId: s.inventoryMovements.referenceId,
      actor: s.users.displayName,
      createdAt: s.inventoryMovements.createdAt,
    })
    .from(s.inventoryMovements)
    .leftJoin(s.inventoryLocations, eq(s.inventoryLocations.id, s.inventoryMovements.locationId))
    .leftJoin(s.users, eq(s.users.id, s.inventoryMovements.actorUserId))
    .where(eq(s.inventoryMovements.offerId, offerId))
    .orderBy(desc(s.inventoryMovements.createdAt), desc(s.inventoryMovements.id))
    .limit(500);
}

export async function listReservations(
  db: Database,
  userId: string,
  merchantId: string,
  status: 'active' | 'released' | 'consumed' | 'expired' = 'active',
) {
  await requireMembership(db, merchantId, userId);
  return db
    .select({
      id: s.inventoryReservations.id,
      sku: s.offers.sku,
      locationCode: s.inventoryLocations.code,
      quantity: s.inventoryReservations.quantity,
      status: s.inventoryReservations.status,
      referenceType: s.inventoryReservations.referenceType,
      referenceId: s.inventoryReservations.referenceId,
      expiresAt: s.inventoryReservations.expiresAt,
      createdAt: s.inventoryReservations.createdAt,
      closedAt: s.inventoryReservations.closedAt,
    })
    .from(s.inventoryReservations)
    .innerJoin(s.offers, eq(s.offers.id, s.inventoryReservations.offerId))
    .innerJoin(s.inventoryLocations, eq(s.inventoryLocations.id, s.inventoryReservations.locationId))
    .where(and(eq(s.inventoryReservations.merchantId, merchantId), eq(s.inventoryReservations.status, status)))
    .orderBy(desc(s.inventoryReservations.createdAt))
    .limit(500);
}
