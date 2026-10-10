import { and, asc, eq, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { conflict, isUniqueViolation, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit } from '../platform/index.js';

type Location = typeof s.inventoryLocations.$inferSelect;

/** Every merchant has exactly one default location; it is created the first time stock is involved. */
export async function ensureDefaultLocation(db: Executor, merchantId: string): Promise<Location> {
  const [existing] = await db
    .select()
    .from(s.inventoryLocations)
    .where(and(eq(s.inventoryLocations.merchantId, merchantId), eq(s.inventoryLocations.isDefault, true)));
  if (existing) return existing;
  const [merchant] = await db.select({ country: s.merchants.country }).from(s.merchants).where(eq(s.merchants.id, merchantId));
  const [created] = await db
    .insert(s.inventoryLocations)
    .values({ merchantId, code: 'MAIN', name: 'Main warehouse', country: merchant?.country ?? null, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Created concurrently by another request.
  const [row] = await db
    .select()
    .from(s.inventoryLocations)
    .where(and(eq(s.inventoryLocations.merchantId, merchantId), eq(s.inventoryLocations.isDefault, true)));
  return row!;
}

export async function getLocation(db: Executor, merchantId: string, locationId: string): Promise<Location> {
  const [row] = await db
    .select()
    .from(s.inventoryLocations)
    .where(and(eq(s.inventoryLocations.id, locationId), eq(s.inventoryLocations.merchantId, merchantId)));
  if (!row) throw notFound('Location');
  return row;
}

export async function listLocations(db: Database, userId: string, merchantId: string) {
  await requireMembership(db, merchantId, userId);
  await ensureDefaultLocation(db, merchantId);
  return db
    .select({
      location: s.inventoryLocations,
      onHand: sql<number>`coalesce(sum(${s.inventoryLevels.onHand}), 0)`.mapWith(Number),
      reserved: sql<number>`coalesce(sum(${s.inventoryLevels.reserved}), 0)`.mapWith(Number),
    })
    .from(s.inventoryLocations)
    .leftJoin(s.inventoryLevels, eq(s.inventoryLevels.locationId, s.inventoryLocations.id))
    .where(eq(s.inventoryLocations.merchantId, merchantId))
    .groupBy(s.inventoryLocations.id)
    .orderBy(sql`${s.inventoryLocations.isDefault} desc`, asc(s.inventoryLocations.code))
    .then((rows) => rows.map((r) => ({ ...r.location, onHand: r.onHand, reserved: r.reserved })));
}

export type LocationInput = {
  code: string;
  name: string;
  type?: 'warehouse' | 'shop' | 'fulfillment_center' | 'dropship';
  country?: string;
  region?: string;
  city?: string;
  addressLine?: string;
};

export async function createLocation(db: Database, actor: Actor & { userId: string }, merchantId: string, input: LocationInput) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  try {
    return await db.transaction(async (tx) => {
      await ensureDefaultLocation(tx, merchantId);
      const [row] = await tx.insert(s.inventoryLocations).values({ merchantId, ...input }).returning();
      await audit(tx, actor, { action: 'inventory.location.created', entityType: 'inventory_location', entityId: row!.id });
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('LOCATION_CODE_TAKEN', 'A location with this code already exists');
    throw error;
  }
}

/** Rename, re-address, make default, or archive a location. A location holding stock cannot be archived. */
export async function updateLocation(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  locationId: string,
  input: Partial<Omit<LocationInput, 'code'>> & { isDefault?: true; status?: 'active' | 'archived' },
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  return db.transaction(async (tx) => {
    const location = await getLocation(tx, merchantId, locationId);
    const { isDefault, ...rest } = input;
    if (input.status === 'archived') {
      if (location.isDefault) throw conflict('DEFAULT_LOCATION', 'Choose another default location first');
      const [held] = await tx
        .select({ n: sql<number>`coalesce(sum(${s.inventoryLevels.onHand}), 0)`.mapWith(Number) })
        .from(s.inventoryLevels)
        .where(eq(s.inventoryLevels.locationId, locationId));
      if (held!.n > 0) throw conflict('LOCATION_NOT_EMPTY', 'Transfer the stock out of this location first');
    }
    if (isDefault && !location.isDefault) {
      if (location.status !== 'active' && input.status !== 'active') throw conflict('LOCATION_ARCHIVED', 'Archived locations cannot be default');
      await tx
        .update(s.inventoryLocations)
        .set({ isDefault: false })
        .where(and(eq(s.inventoryLocations.merchantId, merchantId), eq(s.inventoryLocations.isDefault, true)));
    }
    const [row] = await tx
      .update(s.inventoryLocations)
      .set({ ...rest, ...(isDefault ? { isDefault: true } : {}) })
      .where(eq(s.inventoryLocations.id, locationId))
      .returning();
    await audit(tx, actor, {
      action: 'inventory.location.updated',
      entityType: 'inventory_location',
      entityId: locationId,
      metadata: { fields: Object.keys(input) },
    });
    return row!;
  });
}
