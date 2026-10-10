/**
 * ARUMA staff roles (Admin Panel). A person may hold several roles; every grant and revocation is kept
 * (who, when, why), so the history of who could do what is never lost. What each role may do is defined
 * in code (apps/core/src/modules/identity/permissions.ts), reviewed like any other change.
 */
import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';

export const staffRole = pgEnum('staff_role', ['super_admin', 'finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin']);

export const staffRoleGrants = pgTable(
  'staff_role_grants',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: staffRole('role').notNull(),
    /** Null for the first super admin, created from the server's command line. */
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'restrict' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('staff_role_grants_active_uq').on(t.userId, t.role).where(sql`${t.revokedAt} is null`),
    index('staff_role_grants_user_idx').on(t.userId),
  ],
);
