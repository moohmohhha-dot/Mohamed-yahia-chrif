/**
 * Parcel statuses and the moves allowed between them. The same table is enforced by a database
 * trigger (migration 0013_shipping_guards).
 *
 *   pending ─► in_transit ─► out_for_delivery ─► delivered ─► returning ─► returned
 *      │            └──────► delivery_failed ◄──┘     (retry, or back to the merchant)
 *      ├─► ready_for_pickup ─► delivered (collected) / returned (never collected)
 *      └─► cancelled
 */
import type { schema } from '@aruma/db';

export type ShipmentStatus = (typeof schema.shipmentStatus.enumValues)[number];
export type ShippingMethodType = (typeof schema.shippingMethodType.enumValues)[number];

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending: ['ready_for_pickup', 'in_transit', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['delivered', 'returned'],
  in_transit: ['out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned'],
  out_for_delivery: ['delivered', 'delivery_failed', 'returning', 'returned'],
  delivery_failed: ['in_transit', 'out_for_delivery', 'delivered', 'returning', 'returned'],
  delivered: ['returning', 'returned'],
  returning: ['returned'],
  returned: [],
  cancelled: [],
};

/** Statuses that mean the parcel has left the merchant (the order is then "shipping"). */
export const LEFT_MERCHANT: ShipmentStatus[] = ['ready_for_pickup', 'in_transit', 'out_for_delivery', 'delivery_failed'];

/** The status a parcel takes when it is handed over: collected by the customer, or on the road. */
export const handedOverStatus = (type: ShippingMethodType): ShipmentStatus =>
  type === 'local_pickup' || type === 'pickup_point' ? 'ready_for_pickup' : type === 'merchant_delivery' ? 'out_for_delivery' : 'in_transit';

/** Courier methods need the courier's tracking number before the parcel leaves. */
export const needsTracking = (type: ShippingMethodType) => type === 'courier' || type === 'pickup_point';
