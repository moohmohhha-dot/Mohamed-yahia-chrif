/**
 * Administrative areas and addresses. In Algeria: region = Wilaya, district = Daïra, locality = Commune.
 * The customer picks a Commune; the server derives the Daïra and Wilaya from it, so an address can never
 * be inconsistent (a Commune in the wrong Wilaya).
 */
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import { schema as s, type ShippingAddress } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';

export type AddressInput = {
  fullName: string;
  phone: string;
  country: string;
  /** Commune id (e.g. DZ-16-C-alger-centre). Required in countries whose areas are known (Algeria). */
  localityId?: string;
  /** Free text, only for countries without area data. */
  city?: string;
  region?: string;
  line1: string;
  line2?: string;
  postalCode?: string;
  deliveryNotes?: string;
};

type Area = typeof s.geoAreas.$inferSelect;

export const areaName = (a: Pick<Area, 'names'>, locale = 'fr') => a.names[locale] ?? a.names.fr ?? Object.values(a.names)[0] ?? '';

export async function listAreas(db: Executor, country: string, parentId: string | null, level?: Area['level']) {
  const where: SQL[] = [eq(s.geoAreas.country, country), eq(s.geoAreas.active, true)];
  where.push(parentId ? eq(s.geoAreas.parentId, parentId) : isNull(s.geoAreas.parentId));
  if (level) where.push(eq(s.geoAreas.level, level));
  return db
    .select({ id: s.geoAreas.id, level: s.geoAreas.level, parentId: s.geoAreas.parentId, code: s.geoAreas.code, names: s.geoAreas.names })
    .from(s.geoAreas)
    .where(and(...where))
    .orderBy(asc(s.geoAreas.code), asc(s.geoAreas.id));
}

/** The area and its parents, most specific first: [Commune, Daïra, Wilaya]. */
export async function areaChain(db: Executor, areaId: string): Promise<Area[]> {
  const chain: Area[] = [];
  let next: string | null = areaId;
  while (next && chain.length < 5) {
    const [area] = await db.select().from(s.geoAreas).where(eq(s.geoAreas.id, next));
    if (!area) break;
    chain.push(area);
    next = area.parentId;
  }
  return chain;
}

async function countryHasAreas(db: Executor, country: string) {
  const [row] = await db.select({ id: s.geoAreas.id }).from(s.geoAreas).where(eq(s.geoAreas.country, country)).limit(1);
  return Boolean(row);
}

/**
 * Phone numbers are stored in international format. Algerian numbers may be typed the local way:
 * 0555 12 34 56 → +213555123456 (mobiles 05/06/07, landlines 02x-04x).
 */
export function normalizePhone(country: string, raw: string): string {
  const compact = raw.replace(/[\s.\-()]/g, '');
  if (country === 'DZ') {
    const local = compact.replace(/^(\+213|00213|0)/, '');
    if (!/^([5-7]\d{8}|[2-4]\d{7})$/.test(local)) throw badRequest('INVALID_PHONE', 'Enter an Algerian phone number, e.g. 0555 12 34 56');
    return `+213${local}`;
  }
  const intl = compact.replace(/^00/, '+');
  if (!/^\+[1-9]\d{6,14}$/.test(intl)) throw badRequest('INVALID_PHONE', 'Enter the phone number in international format, e.g. +33612345678');
  return intl;
}

/** Checks an address and returns it complete (Commune, Daïra, Wilaya names and ids filled by the server). */
export async function resolveAddress(db: Executor, input: AddressInput): Promise<ShippingAddress> {
  const base = {
    fullName: input.fullName.trim(),
    phone: normalizePhone(input.country, input.phone),
    country: input.country,
    line1: input.line1.trim(),
    ...(input.line2?.trim() ? { line2: input.line2.trim() } : {}),
    ...(input.postalCode?.trim() ? { postalCode: input.postalCode.trim() } : {}),
    ...(input.deliveryNotes?.trim() ? { deliveryNotes: input.deliveryNotes.trim() } : {}),
  };
  const area = await resolveLocality(db, input.country, input.localityId);
  if (area) return { ...base, ...area };
  if (!input.city?.trim() || !input.region?.trim()) throw badRequest('CITY_REQUIRED', 'Enter the city and the region');
  return { ...base, city: input.city.trim(), region: input.region.trim() };
}

/**
 * Commune, Daïra and Wilaya (ids and names) of a Commune id. Returns null for countries without area
 * data; throws when the country has areas but the Commune is missing or wrong.
 */
export async function resolveLocality(db: Executor, country: string, localityId: string | undefined) {
  if (!(await countryHasAreas(db, country))) return null;
  if (!localityId) throw badRequest('LOCALITY_REQUIRED', 'Choose the Commune (and so the Daïra and Wilaya)');
  const chain = await areaChain(db, localityId);
  const locality = chain[0];
  if (!locality || locality.level !== 'locality' || locality.country !== country || !locality.active) {
    throw new AppError(400, 'UNKNOWN_LOCALITY', 'This Commune does not exist in that country', { localityId });
  }
  const district = chain.find((a) => a.level === 'district');
  const region = chain.find((a) => a.level === 'region')!;
  return {
    regionId: region.id,
    region: areaName(region),
    ...(district ? { districtId: district.id, district: areaName(district) } : {}),
    cityId: locality.id,
    city: areaName(locality),
  };
}

/** Area ids of an address, most specific first, used to find its delivery zone. */
export const addressAreas = (a: ShippingAddress) => [a.cityId, a.districtId, a.regionId].filter((v): v is string => Boolean(v));
