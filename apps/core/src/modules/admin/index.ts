/**
 * Admin Panel API: what ARUMA staff need across modules (users and staff roles, catalog moderation,
 * payments, analytics, audit log, feature flags). Each module keeps its own admin routes too.
 */
export { adminRoutes } from './routes.js';
export { securityAlerts, type Alert } from './security.js';
