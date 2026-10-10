/**
 * Makes an existing user a Super Admin, from the server's command line. This is how the first super
 * admin is created; after that, super admins grant roles from the Admin Panel.
 *   pnpm --filter @aruma/core make-admin someone@example.com
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { audit } from '../modules/platform/index.js';

const email = process.argv[2]?.trim().toLowerCase();
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error('Usage: DATABASE_URL=... pnpm --filter @aruma/core make-admin <email>');
  process.exit(1);
}

const { db, pool } = createDb(url);
try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(s.users).where(eq(s.users.email, email));
    if (!user) throw new Error(`No user with email ${email}`);
    const [held] = await tx
      .select()
      .from(s.staffRoleGrants)
      .where(and(eq(s.staffRoleGrants.userId, user.id), eq(s.staffRoleGrants.role, 'super_admin'), isNull(s.staffRoleGrants.revokedAt)));
    if (held) return;
    await tx.insert(s.staffRoleGrants).values({ userId: user.id, role: 'super_admin', reason: 'Granted from the server command line' });
    await audit(tx, null, { action: 'staff.role.granted', entityType: 'user', entityId: user.id, metadata: { role: 'super_admin', via: 'cli' } });
  });
  console.log(`${email} is a super admin`);
} finally {
  await pool.end();
}
