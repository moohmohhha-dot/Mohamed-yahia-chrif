/**
 * How a merchant delivers: delivery zones, methods (own delivery, courier, local pickup) and their
 * prices. Only owners and managers change these; every change is audited.
 */
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { sequential, type Executor } from '../../shared/db.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';
import type { SecretBox } from '../platform/index.js';
import type { CourierRegistry } from './couriers/types.js';
import type { ShippingMethodType } from './statuses.js';

type Method = typeof s.shippingMethods.$inferSelect;
type Rate = typeof s.shippingRates.$inferSelect;
export type PickupLocation = NonNullable<Method['pickupLocation']>;

const serializeRate = (r: Rate) => ({
  id: r.id,
  zoneId: r.zoneId,
  currency: r.currency,
  priceMinor: Number(r.priceMinor),
  freeAboveMinor: r.freeAboveMinor === null ? null : Number(r.freeAboveMinor),
  minDays: r.minDays,
  maxDays: r.maxDays,
});

/** Everything the merchant's shipping settings page shows. */
export async function shippingSettings(db: Executor, merchantId: string) {
  const [methods, zones, merchant] = await sequential([
    db.select().from(s.shippingMethods).where(eq(s.shippingMethods.merchantId, merchantId)).orderBy(asc(s.shippingMethods.createdAt)),
    db
      .select()
      .from(s.shippingZones)
      .where(and(eq(s.shippingZones.merchantId, merchantId), isNull(s.shippingZones.archivedAt)))
      .orderBy(asc(s.shippingZones.createdAt)),
    db.select({ country: s.merchants.country }).from(s.merchants).where(eq(s.merchants.id, merchantId)),
  ]);
  const [rates, areas, couriers, accounts] = await sequential([
    methods.length ? db.select().from(s.shippingRates).where(inArray(s.shippingRates.methodId, methods.map((m) => m.id))) : Promise.resolve([] as Rate[]),
    zones.length
      ? db
          .select({ zoneId: s.shippingZoneAreas.zoneId, id: s.geoAreas.id, level: s.geoAreas.level, names: s.geoAreas.names })
          .from(s.shippingZoneAreas)
          .innerJoin(s.geoAreas, eq(s.geoAreas.id, s.shippingZoneAreas.areaId))
          .where(inArray(s.shippingZoneAreas.zoneId, zones.map((z) => z.id)))
      : Promise.resolve([]),
    db.select().from(s.couriers).where(and(eq(s.couriers.active, true), eq(s.couriers.country, merchant[0]?.country ?? 'DZ'))).orderBy(asc(s.couriers.name)),
    listCourierAccounts(db, merchantId),
  ]);
  const liveZones = new Set(zones.map((z) => z.id));
  return {
    country: merchant[0]?.country ?? null,
    methods: methods.map((m) => ({
      id: m.id,
      type: m.type,
      name: m.name,
      courierCode: m.courierCode,
      courierAccountId: m.courierAccountId,
      pickupLocation: m.pickupLocation,
      cashOnDelivery: m.cashOnDelivery,
      active: m.active,
      rates: rates.filter((r) => r.methodId === m.id && (r.zoneId === null || liveZones.has(r.zoneId))).map(serializeRate),
    })),
    zones: zones.map((z) => ({ id: z.id, name: z.name, country: z.country, areas: areas.filter((a) => a.zoneId === z.id).map(({ zoneId: _z, ...a }) => a) })),
    couriers: couriers.map((c) => ({ code: c.code, name: c.name, integration: c.integration })),
    courierAccounts: accounts,
  };
}

async function checkAreas(db: Executor, country: string, areaIds: string[]) {
  const unique = [...new Set(areaIds)];
  const found = unique.length
    ? await db.select({ id: s.geoAreas.id }).from(s.geoAreas).where(and(inArray(s.geoAreas.id, unique), eq(s.geoAreas.country, country)))
    : [];
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new AppError(400, 'UNKNOWN_AREA', 'Some areas do not exist in this country', { areaIds: missing });
  return unique;
}

async function loadZone(db: Executor, merchantId: string, zoneId: string) {
  const [zone] = await db
    .select()
    .from(s.shippingZones)
    .where(and(eq(s.shippingZones.id, zoneId), eq(s.shippingZones.merchantId, merchantId), isNull(s.shippingZones.archivedAt)));
  if (!zone) throw notFound('Zone');
  return zone;
}

export async function saveZone(
  db: Database,
  actor: Actor,
  merchantId: string,
  zoneId: string | null,
  input: { name: string; country: string; areaIds: string[] },
) {
  return db.transaction(async (tx) => {
    const areaIds = await checkAreas(tx, input.country, input.areaIds);
    if (!areaIds.length) throw badRequest('AREAS_REQUIRED', 'A zone needs at least one Wilaya, Daïra or Commune');
    let id = zoneId;
    if (id) {
      const zone = await loadZone(tx, merchantId, id);
      if (zone.country !== input.country) throw badRequest('COUNTRY_LOCKED', 'The country of a zone cannot change');
      await tx.update(s.shippingZones).set({ name: input.name }).where(eq(s.shippingZones.id, id));
      await tx.delete(s.shippingZoneAreas).where(eq(s.shippingZoneAreas.zoneId, id));
    } else {
      const [zone] = await tx.insert(s.shippingZones).values({ merchantId, name: input.name, country: input.country }).returning();
      id = zone!.id;
    }
    await tx.insert(s.shippingZoneAreas).values(areaIds.map((areaId) => ({ zoneId: id!, areaId })));
    await audit(tx, actor, { action: zoneId ? 'shipping.zone.updated' : 'shipping.zone.created', entityType: 'shipping_zone', entityId: id!, metadata: { name: input.name, areaIds } });
    return id!;
  });
}

/** Zones are archived, not deleted (past orders may refer to their prices). */
export async function archiveZone(db: Database, actor: Actor, merchantId: string, zoneId: string) {
  await db.transaction(async (tx) => {
    await loadZone(tx, merchantId, zoneId);
    await tx.update(s.shippingZones).set({ archivedAt: new Date() }).where(eq(s.shippingZones.id, zoneId));
    await audit(tx, actor, { action: 'shipping.zone.archived', entityType: 'shipping_zone', entityId: zoneId });
  });
}

export type MethodInput = {
  type: ShippingMethodType;
  name: string;
  courierCode?: string | null;
  courierAccountId?: string | null;
  pickupLocation?: PickupLocation | null;
  cashOnDelivery: boolean;
  active: boolean;
};

async function checkMethod(db: Executor, merchantId: string, input: MethodInput) {
  if (input.type === 'courier' || input.type === 'pickup_point') {
    if (!input.courierCode) throw badRequest('COURIER_REQUIRED', 'Choose the courier company');
    const [courier] = await db.select().from(s.couriers).where(and(eq(s.couriers.code, input.courierCode), eq(s.couriers.active, true)));
    if (!courier) throw badRequest('UNKNOWN_COURIER', 'This courier is not available');
  } else if (input.courierCode || input.courierAccountId) {
    throw badRequest('COURIER_NOT_ALLOWED', 'Only courier methods have a courier');
  }
  if (input.courierAccountId) {
    const [account] = await db
      .select()
      .from(s.courierAccounts)
      .where(
        and(
          eq(s.courierAccounts.id, input.courierAccountId),
          eq(s.courierAccounts.courierCode, input.courierCode!),
          eq(s.courierAccounts.active, true),
          // The merchant's own contract, or a platform account (ARUMA Logistics later).
          or(eq(s.courierAccounts.merchantId, merchantId), isNull(s.courierAccounts.merchantId)),
        ),
      );
    if (!account) throw badRequest('UNKNOWN_COURIER_ACCOUNT', 'This courier account is not available');
  }
  if (input.type === 'local_pickup' && !input.pickupLocation?.address) {
    throw badRequest('PICKUP_LOCATION_REQUIRED', 'Say where customers collect their orders');
  }
}

export async function saveMethod(db: Database, actor: Actor, merchantId: string, methodId: string | null, input: MethodInput) {
  return db.transaction(async (tx) => {
    let id = methodId;
    if (id) {
      const [method] = await tx.select().from(s.shippingMethods).where(and(eq(s.shippingMethods.id, id), eq(s.shippingMethods.merchantId, merchantId)));
      if (!method) throw notFound('Shipping method');
      // The type defines the method; a different way of delivering is a new method.
      if (method.type !== input.type) throw badRequest('TYPE_LOCKED', 'The type of a method cannot change; create a new method');
    }
    await checkMethod(tx, merchantId, input);
    const values = {
      type: input.type,
      name: input.name,
      courierCode: input.courierCode ?? null,
      courierAccountId: input.courierAccountId ?? null,
      pickupLocation: input.type === 'local_pickup' ? input.pickupLocation! : null,
      cashOnDelivery: input.cashOnDelivery,
      active: input.active,
    };
    if (id) await tx.update(s.shippingMethods).set(values).where(eq(s.shippingMethods.id, id));
    else id = (await tx.insert(s.shippingMethods).values({ merchantId, ...values }).returning())[0]!.id;
    await audit(tx, actor, { action: methodId ? 'shipping.method.updated' : 'shipping.method.created', entityType: 'shipping_method', entityId: id!, metadata: values });
    return id!;
  });
}

export type RateInput = { zoneId: string | null; currency: string; priceMinor: number; freeAboveMinor: number | null; minDays: number; maxDays: number };

export async function saveRate(db: Database, actor: Actor, merchantId: string, methodId: string, input: RateInput) {
  return db.transaction(async (tx) => {
    const [method] = await tx.select().from(s.shippingMethods).where(and(eq(s.shippingMethods.id, methodId), eq(s.shippingMethods.merchantId, merchantId)));
    if (!method) throw notFound('Shipping method');
    if (input.zoneId) await loadZone(tx, merchantId, input.zoneId);
    if (input.maxDays < input.minDays) throw badRequest('INVALID_DAYS', 'The maximum delay must not be shorter than the minimum');
    const values = {
      priceMinor: BigInt(input.priceMinor),
      freeAboveMinor: input.freeAboveMinor === null ? null : BigInt(input.freeAboveMinor),
      minDays: input.minDays,
      maxDays: input.maxDays,
    };
    const [rate] = await tx
      .insert(s.shippingRates)
      .values({ methodId, zoneId: input.zoneId, currency: input.currency, ...values })
      .onConflictDoUpdate({ target: [s.shippingRates.methodId, s.shippingRates.zoneId, s.shippingRates.currency], set: values })
      .returning();
    await audit(tx, actor, { action: 'shipping.rate.saved', entityType: 'shipping_method', entityId: methodId, metadata: { ...input } });
    return serializeRate(rate!);
  });
}

export async function deleteRate(db: Database, actor: Actor, merchantId: string, methodId: string, rateId: string) {
  await db.transaction(async (tx) => {
    const [method] = await tx.select().from(s.shippingMethods).where(and(eq(s.shippingMethods.id, methodId), eq(s.shippingMethods.merchantId, merchantId)));
    if (!method) throw notFound('Shipping method');
    const deleted = await tx.delete(s.shippingRates).where(and(eq(s.shippingRates.id, rateId), eq(s.shippingRates.methodId, methodId))).returning();
    if (!deleted.length) throw notFound('Rate');
    await audit(tx, actor, { action: 'shipping.rate.deleted', entityType: 'shipping_method', entityId: methodId, metadata: { zoneId: deleted[0]!.zoneId, currency: deleted[0]!.currency } });
  });
}

// --- Courier accounts (API credentials) ---------------------------------------------------------------

export async function listCourierAccounts(db: Executor, merchantId: string) {
  const rows = await db
    .select({ id: s.courierAccounts.id, courierCode: s.courierAccounts.courierCode, label: s.courierAccounts.label, active: s.courierAccounts.active, createdAt: s.courierAccounts.createdAt })
    .from(s.courierAccounts)
    .where(eq(s.courierAccounts.merchantId, merchantId))
    .orderBy(asc(s.courierAccounts.createdAt));
  return rows; // credentials are never returned
}

/** Connects the merchant's own account with a courier that has an API integration. Credentials are encrypted. */
export async function connectCourierAccount(
  db: Database,
  deps: { secrets: SecretBox; couriers: CourierRegistry },
  actor: Actor,
  merchantId: string,
  input: { courierCode: string; label: string; credentials: Record<string, string> },
) {
  const [courier] = await db.select().from(s.couriers).where(and(eq(s.couriers.code, input.courierCode), eq(s.couriers.active, true)));
  const adapter = deps.couriers[input.courierCode];
  if (!courier || courier.integration !== 'api' || !adapter) {
    throw badRequest('COURIER_HAS_NO_API', 'ARUMA has no API integration with this courier yet; enter tracking numbers by hand');
  }
  const missing = adapter.credentialFields.filter((f) => !input.credentials[f]?.trim());
  if (missing.length) throw new AppError(400, 'CREDENTIALS_REQUIRED', 'Some credentials are missing', { fields: missing });
  const credentials = Object.fromEntries(adapter.credentialFields.map((f) => [f, input.credentials[f]!.trim()]));
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(s.courierAccounts)
      .values({ courierCode: input.courierCode, merchantId, label: input.label, credentialsEncrypted: deps.secrets.seal(JSON.stringify(credentials)) })
      .returning();
    await audit(tx, actor, { action: 'shipping.courier_account.connected', entityType: 'courier_account', entityId: account!.id, metadata: { courierCode: input.courierCode } });
    return { id: account!.id, courierCode: account!.courierCode, label: account!.label, active: account!.active, createdAt: account!.createdAt };
  });
}

export async function deactivateCourierAccount(db: Database, actor: Actor, merchantId: string, accountId: string) {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(s.courierAccounts)
      .set({ active: false })
      .where(and(eq(s.courierAccounts.id, accountId), eq(s.courierAccounts.merchantId, merchantId)))
      .returning();
    if (!updated.length) throw notFound('Courier account');
    await audit(tx, actor, { action: 'shipping.courier_account.deactivated', entityType: 'courier_account', entityId: accountId });
  });
}

export async function courierCredentials(db: Executor, secrets: SecretBox, accountId: string) {
  const [account] = await db.select().from(s.courierAccounts).where(eq(s.courierAccounts.id, accountId));
  if (!account) throw notFound('Courier account');
  return { account, credentials: JSON.parse(secrets.open(account.credentialsEncrypted)) as Record<string, string> };
}
