/**
 * Shipping cost. Always computed by the server from the merchant's rates: a price sent by the browser is
 * never used. For each method the most specific zone wins (Commune › Daïra › Wilaya › anywhere), then
 * the free-delivery threshold applies to the merchant's part of the cart.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema as s, type OrderDelivery, type ShippingAddress } from '@aruma/db';
import { sequential, type Executor } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { addressAreas, areaChain } from './geo.js';

export type DeliveryOption = {
  methodId: string;
  type: OrderDelivery['type'];
  name: string;
  courierCode: string | null;
  courierName: string | null;
  priceMinor: bigint;
  /** Delivery is free because the cart reached the merchant's threshold. */
  free: boolean;
  freeAboveMinor: bigint | null;
  minDays: number;
  maxDays: number;
  cashOnDelivery: boolean;
  pickupLocation: OrderDelivery['pickupLocation'];
};

/** Every way this merchant can deliver to this address, with its price. */
export async function deliveryOptions(
  db: Executor,
  input: { merchantId: string; address: Pick<ShippingAddress, 'country' | 'cityId' | 'districtId' | 'regionId'>; subtotalMinor: bigint; currency: string; pickupPoints: boolean },
): Promise<DeliveryOption[]> {
  const [merchant] = await db.select({ country: s.merchants.country }).from(s.merchants).where(eq(s.merchants.id, input.merchantId));
  const methods = await db
    .select({ method: s.shippingMethods, courierName: s.couriers.name, courierActive: s.couriers.active })
    .from(s.shippingMethods)
    .leftJoin(s.couriers, eq(s.couriers.code, s.shippingMethods.courierCode))
    .where(and(eq(s.shippingMethods.merchantId, input.merchantId), eq(s.shippingMethods.active, true)));
  const usable = methods.filter((m) => m.courierActive !== false && (input.pickupPoints || m.method.type !== 'pickup_point'));
  if (!usable.length) return [];

  const areas = addressAreas(input.address as ShippingAddress); // [Commune, Daïra, Wilaya]
  const [rates, zoneAreas] = await sequential([
    db
      .select()
      .from(s.shippingRates)
      .where(and(inArray(s.shippingRates.methodId, usable.map((m) => m.method.id)), eq(s.shippingRates.currency, input.currency))),
    areas.length
      ? db
          .select({ zoneId: s.shippingZoneAreas.zoneId, areaId: s.shippingZoneAreas.areaId })
          .from(s.shippingZoneAreas)
          .innerJoin(s.shippingZones, eq(s.shippingZones.id, s.shippingZoneAreas.zoneId))
          .where(
            and(
              inArray(s.shippingZoneAreas.areaId, areas),
              eq(s.shippingZones.merchantId, input.merchantId),
              eq(s.shippingZones.country, input.address.country),
              isNull(s.shippingZones.archivedAt),
            ),
          )
      : Promise.resolve([] as { zoneId: string; areaId: string }[]),
  ]);

  /** 3 = the Commune itself, 2 = its Daïra, 1 = its Wilaya, 0 = anywhere in the merchant's country, -1 = no match. */
  const specificity = (zoneId: string | null) => {
    if (zoneId === null) return input.address.country === merchant?.country ? 0 : -1;
    const hits = zoneAreas.filter((z) => z.zoneId === zoneId).map((z) => areas.length - areas.indexOf(z.areaId));
    return hits.length ? Math.max(...hits) : -1;
  };

  const options: DeliveryOption[] = [];
  for (const { method, courierName } of usable) {
    const best = rates
      .filter((r) => r.methodId === method.id)
      .map((r) => ({ r, score: specificity(r.zoneId) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || Number(a.r.priceMinor - b.r.priceMinor))[0];
    if (!best) continue;
    const free = best.r.freeAboveMinor !== null && input.subtotalMinor >= best.r.freeAboveMinor;
    options.push({
      methodId: method.id,
      type: method.type,
      name: method.name,
      courierCode: method.courierCode,
      courierName: courierName ?? null,
      priceMinor: free ? 0n : best.r.priceMinor,
      free,
      freeAboveMinor: best.r.freeAboveMinor,
      minDays: best.r.minDays,
      maxDays: best.r.maxDays,
      cashOnDelivery: method.cashOnDelivery,
      pickupLocation: method.pickupLocation ? { address: method.pickupLocation.address, hours: method.pickupLocation.hours, phone: method.pickupLocation.phone } : null,
    });
  }
  return options.sort((a, b) => Number(a.priceMinor - b.priceMinor) || a.name.localeCompare(b.name));
}

/**
 * The customer's choice for one merchant, checked: the method exists for this address, accepts the
 * payment method, and (for pickup points) the point is valid. Returns the price and what the order keeps.
 */
export async function chooseDelivery(
  db: Executor,
  input: {
    merchantId: string;
    methodId: string;
    pickupPointId?: string;
    address: ShippingAddress;
    subtotalMinor: bigint;
    currency: string;
    paymentMethod: 'cash_on_delivery' | 'online';
    pickupPoints: boolean;
  },
): Promise<{ priceMinor: bigint; delivery: OrderDelivery }> {
  const options = await deliveryOptions(db, input);
  const option = options.find((o) => o.methodId === input.methodId);
  if (!option) {
    throw new AppError(409, 'DELIVERY_UNAVAILABLE', 'This delivery method is not available for this address', {
      merchantId: input.merchantId,
      methodId: input.methodId,
    });
  }
  if (input.paymentMethod === 'cash_on_delivery' && !option.cashOnDelivery) {
    throw new AppError(409, 'CASH_ON_DELIVERY_UNAVAILABLE', 'Cash on delivery is not possible with this delivery method', { merchantId: input.merchantId });
  }
  let pickupPoint: OrderDelivery['pickupPoint'] = null;
  if (option.type === 'pickup_point') {
    if (!input.pickupPointId) throw badRequest('PICKUP_POINT_REQUIRED', 'Choose the pickup point');
    const [point] = await db
      .select()
      .from(s.pickupPoints)
      .where(and(eq(s.pickupPoints.id, input.pickupPointId), eq(s.pickupPoints.active, true), eq(s.pickupPoints.courierCode, option.courierCode!)));
    if (!point) throw badRequest('UNKNOWN_PICKUP_POINT', 'This pickup point is not available for this courier');
    const pointRegion = (await areaChain(db, point.areaId)).find((a) => a.level === 'region');
    if (!pointRegion || pointRegion.id !== input.address.regionId) {
      throw badRequest('PICKUP_POINT_TOO_FAR', 'Choose a pickup point in your Wilaya');
    }
    pickupPoint = { id: point.id, name: point.name, address: point.address, hours: point.hours };
  }
  return {
    priceMinor: option.priceMinor,
    delivery: {
      methodId: option.methodId,
      type: option.type,
      name: option.name,
      courierCode: option.courierCode,
      courierName: option.courierName,
      minDays: option.minDays,
      maxDays: option.maxDays,
      pickupLocation: option.type === 'local_pickup' ? option.pickupLocation : null,
      pickupPoint,
    },
  };
}
