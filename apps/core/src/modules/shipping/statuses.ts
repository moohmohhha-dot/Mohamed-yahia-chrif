/**
 * Parcel statuses and the moves allowed between them. The same table is enforced by a database
 * trigger (migration 0013_shipping_guards).
 *
 *   pending ─► in_transit ─► out_for_delivery ─► delivered ─► returning ─► returned
 *      │            └──────► delivery_failed ◄──┘     (retry, or back to the merchant)
 *      ├─► ready_for_pickup ─► delivered (collected) / returning, returned (never collected)
 *      │   (pickup points: in_transit ─► ready_for_pickup)
 *      └─► cancelled
 */
import type { schema } from '@aruma/db';

export type ShipmentStatus = (typeof schema.shipmentStatus.enumValues)[number];
export type ShippingMethodType = (typeof schema.shippingMethodType.enumValues)[number];

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending: ['ready_for_pickup', 'in_transit', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['delivered', 'returning', 'returned'],
  in_transit: ['ready_for_pickup', 'out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned'],
  out_for_delivery: ['delivered', 'delivery_failed', 'returning', 'returned'],
  delivery_failed: ['in_transit', 'out_for_delivery', 'delivered', 'returning', 'returned'],
  delivered: ['returning', 'returned'],
  returning: ['returned'],
  returned: [],
  cancelled: [],
};

/** Statuses that mean the parcel has left the merchant (the order is then "shipping"). */
export const LEFT_MERCHANT: ShipmentStatus[] = ['ready_for_pickup', 'in_transit', 'out_for_delivery', 'delivery_failed'];

/** The status a parcel takes when it leaves: ready at the shop, with the merchant's driver, or with the courier. */
export const handedOverStatus = (type: ShippingMethodType): ShipmentStatus =>
  type === 'local_pickup' ? 'ready_for_pickup' : type === 'merchant_delivery' ? 'out_for_delivery' : 'in_transit';

/** Courier methods need the courier's tracking number before the parcel leaves. */
export const needsTracking = (type: ShippingMethodType) => type === 'courier' || type === 'pickup_point';
