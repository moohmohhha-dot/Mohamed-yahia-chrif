/** Identity: users, accounts (login methods), devices, sessions, authentication. */
export { identityRoutes } from './routes.js';
export { authPlugin, authOf, requireAuth, requireRole } from './plugin.js';
export { findUserIdByEmail, type AuthContext } from './service.js';
