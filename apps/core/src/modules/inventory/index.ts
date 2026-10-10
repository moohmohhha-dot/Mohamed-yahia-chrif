/**
 * Inventory: locations (warehouses), stock levels (on hand / reserved / available), reservations,
 * transfers, adjustments, bulk import/export and the append-only movement history.
 * The orders module uses reserveStock / releaseStock / consumeStock.
 */
export { inventoryRoutes } from './routes.js';
export { ensureDefaultLocation } from './locations.js';
export { setOnHand, type InventoryReason } from './levels.js';
export {
  consumeStock,
  receiveReturn,
  releaseExpiredReservations,
  releaseStock,
  reserveStock,
  type ReservationLine,
  type StockReference,
} from './reservations.js';
