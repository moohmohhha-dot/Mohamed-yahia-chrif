/** Promotes an existing user to platform admin: pnpm --filter @aruma/core make-admin someone@example.com */
import { eq } from 'drizzle-orm';
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
    const [user] = await tx.update(s.users).set({ role: 'admin' }).where(eq(s.users.email, email)).returning();
    if (!user) throw new Error(`No user with email ${email}`);
    await audit(tx, null, { action: 'identity.user.promoted_admin', entityType: 'user', entityId: user.id });
  });
  console.log(`${email} is now an admin`);
} finally {
  await pool.end();
}
