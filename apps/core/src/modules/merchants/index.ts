/** Merchants: individuals and businesses, staff, verification (phone, email, identity, business, payout), stores. */
export { merchantRoutes } from './routes.js';
export { merchantAdminRoutes } from './admin-routes.js';
export { assertNoConflictOfInterest, requireMembership, type MerchantRole } from './service.js';
