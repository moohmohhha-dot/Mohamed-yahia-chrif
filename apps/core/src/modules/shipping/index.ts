/**
 * Shipping: Algerian (and future) addresses, merchants' delivery methods, zones and prices, courier
 * integrations, pickup points, and parcels with their tracking history.
 */
export { shippingRoutes } from './routes.js';
export { resolveAddress, resolveLocality, normalizePhone, type AddressInput } from './geo.js';
export { chooseDelivery, deliveryOptions, type DeliveryOption } from './quotes.js';
export {
  activeShipment,
  describeShipment,
  destinationOf,
  findShipmentByTracking,
  openShipment,
  recordShipmentStatus,
  shipmentOfOrder,
  type Shipment,
  type ShipmentSource,
} from './shipments.js';
export { courierCredentials } from './settings.js';
export { handedOverStatus, LEFT_MERCHANT, needsTracking, SHIPMENT_TRANSITIONS, type ShipmentStatus } from './statuses.js';
export { createSandboxCourier, sandboxSignature } from './couriers/sandbox.js';
export type { CourierAdapter, CourierEvent, CourierRegistry } from './couriers/types.js';
