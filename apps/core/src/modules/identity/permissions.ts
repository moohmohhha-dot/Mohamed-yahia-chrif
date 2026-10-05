/**
 * ARUMA staff roles and what each may do in the Admin Panel. The server checks the permission on every
 * admin route; the panel only hides what a role cannot do. Changing this table is a code change,
 * reviewed and tested (test/admin.test.ts), never a setting someone can flip quietly.
 */
export const STAFF_ROLES = ['super_admin', 'finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  'overview.read',
  'analytics.read',
  'users.read',
  'users.manage', // suspend, reactivate
  'staff.manage', // grant and revoke staff roles
  'merchants.read',
  'merchants.manage', // suspend, unsuspend, activity rules
  'verification.review',
  'catalog.read',
  'catalog.moderate', // block / unblock products
  'inventory.read',
  'orders.read',
  'orders.manage', // status, shipment, confirmation calls
  'payments.read',
  'refunds.execute', // send or record refunds (orders, returns, disputes)
  'finance.read',
  'finance.manage', // settlements, releases, provider settlements, reconciliation, finance settings
  'commission.manage',
  'payouts.manage',
  'shipping.manage',
  'cod.policy',
  'returns.read',
  'returns.decide',
  'returns.policy',
  'disputes.read',
  'disputes.handle', // messages, internal notes, files, start the review
  'disputes.decide', // decisions and appeal decisions
  'reviews.moderate',
  'fraud.manage', // risk signals, cash-on-delivery blocks
  'security.read', // audit log, staff list
  'security.manage', // end a user's sessions
  'flags.read',
  'flags.manage',
  // Modules of later phases: the permission exists so roles are ready when the module ships.
  'ads.manage',
  'coupons.manage',
  'rewards.manage',
  'support.manage',
  'cms.manage',
  'ai.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL_STAFF: Permission[] = ['overview.read', 'flags.read'];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  /** Everything, including who is staff. Keep this role to very few people. */
  super_admin: PERMISSIONS,
  /** Money: ledger, commission, settlements, payouts, refunds. */
  finance_admin: [
    ...ALL_STAFF,
    'analytics.read', 'users.read', 'merchants.read', 'orders.read', 'payments.read', 'refunds.execute',
    'finance.read', 'finance.manage', 'commission.manage', 'payouts.manage', 'returns.read', 'disputes.read',
  ],
  /** Customers and merchants with a problem: orders, returns, disputes, support. Refunds are sent by Finance. */
  support_admin: [
    ...ALL_STAFF,
    'users.read', 'merchants.read', 'catalog.read', 'inventory.read', 'orders.read', 'orders.manage', 'payments.read',
    'returns.read', 'returns.decide', 'disputes.read', 'disputes.handle', 'disputes.decide', 'support.manage',
  ],
  /** What customers see: products, reviews, pages, ads. */
  content_admin: [...ALL_STAFF, 'analytics.read', 'merchants.read', 'catalog.read', 'catalog.moderate', 'reviews.moderate', 'cms.manage', 'ads.manage'],
  /** Accounts, fraud and the audit trail. */
  security_admin: [
    ...ALL_STAFF,
    'users.read', 'users.manage', 'merchants.read', 'merchants.manage', 'orders.read', 'payments.read',
    'fraud.manage', 'security.read', 'security.manage',
  ],
  /** Running the marketplace: merchants, verification, catalog, orders, delivery, cash on delivery, returns policy. */
  operations_admin: [
    ...ALL_STAFF,
    'analytics.read', 'users.read', 'merchants.read', 'merchants.manage', 'verification.review', 'catalog.read',
    'inventory.read', 'orders.read', 'orders.manage', 'payments.read', 'shipping.manage', 'cod.policy',
    'returns.read', 'returns.policy', 'disputes.read', 'coupons.manage', 'rewards.manage',
  ],
};

export const permissionsOf = (roles: readonly StaffRole[]): ReadonlySet<Permission> => new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]));
