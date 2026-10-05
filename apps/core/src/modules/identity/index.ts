/** Identity: users, accounts (login methods), devices, sessions, authentication. */
export { identityRoutes } from './routes.js';
export { authPlugin, authOf, can, requireAuth, requirePermission } from './plugin.js';
export { PERMISSIONS, permissionsOf, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type StaffRole } from './permissions.js';
export { activeStaffRoles, findUserIdByEmail, type AuthContext } from './service.js';
