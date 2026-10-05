/** Users and ARUMA staff, as seen from the Admin Panel. */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, badRequest, forbidden, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { activeStaffRoles, ROLE_PERMISSIONS, type AuthContext, type StaffRole } from '../identity/index.js';
import { audit, recordEvent } from '../platform/index.js';

type Staff = AuthContext & { ip: string | null };
const actorOf = (a: Staff): Actor => ({ userId: a.userId, ip: a.ip });

export async function listUsers(db: Database, q: { q?: string; status?: 'active' | 'suspended' | 'deleted'; staff?: boolean; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.q) {
    const pattern = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(s.users.email, pattern), ilike(s.users.displayName, pattern), ilike(s.users.phone, pattern))!);
  }
  if (q.status) where.push(eq(s.users.status, q.status));
  const staffIds = db.select({ id: s.staffRoleGrants.userId }).from(s.staffRoleGrants).where(isNull(s.staffRoleGrants.revokedAt));
  if (q.staff) where.push(inArray(s.users.id, staffIds));
  const rows = await db
    .select({ id: s.users.id, email: s.users.email, phone: s.users.phone, displayName: s.users.displayName, country: s.users.country, status: s.users.status, emailVerifiedAt: s.users.emailVerifiedAt, createdAt: s.users.createdAt })
    .from(s.users)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.users.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const ids = rows.map((r) => r.id);
  const [roles, members] = ids.length
    ? [
        await db.select({ userId: s.staffRoleGrants.userId, role: s.staffRoleGrants.role }).from(s.staffRoleGrants).where(and(inArray(s.staffRoleGrants.userId, ids), isNull(s.staffRoleGrants.revokedAt))),
        await db.select({ userId: s.merchantMembers.userId, n: sql<number>`count(*)::int` }).from(s.merchantMembers).where(inArray(s.merchantMembers.userId, ids)).groupBy(s.merchantMembers.userId),
      ]
    : [[], []];
  return rows.map((u) => ({
    ...u,
    staffRoles: roles.filter((r) => r.userId === u.id).map((r) => r.role),
    merchants: members.find((m) => m.userId === u.id)?.n ?? 0,
  }));
}

export async function describeUser(db: Database, viewer: Staff, userId: string) {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!user) throw notFound('User');
  const seeStaff = viewer.permissions.has('staff.manage') || viewer.permissions.has('security.read');
  const [memberships, orders, sessions, grants, credit] = [
    await db
      .select({ merchantId: s.merchants.id, name: s.merchants.name, role: s.merchantMembers.role, verificationStatus: s.merchants.verificationStatus })
      .from(s.merchantMembers)
      .innerJoin(s.merchants, eq(s.merchants.id, s.merchantMembers.merchantId))
      .where(eq(s.merchantMembers.userId, userId)),
    await db
      .select({ currency: s.orders.currency, n: sql<number>`count(*)::int`, totalMinor: sql<string>`coalesce(sum(${s.orders.totalMinor}), 0)::text` })
      .from(s.orders)
      .where(eq(s.orders.customerUserId, userId))
      .groupBy(s.orders.currency),
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.sessions)
      .where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt), sql`${s.sessions.expiresAt} > now()`)),
    seeStaff
      ? await db
          .select({ role: s.staffRoleGrants.role, reason: s.staffRoleGrants.reason, grantedAt: s.staffRoleGrants.grantedAt, grantedBy: s.staffRoleGrants.grantedBy, revokedAt: s.staffRoleGrants.revokedAt, revokeReason: s.staffRoleGrants.revokeReason })
          .from(s.staffRoleGrants)
          .where(eq(s.staffRoleGrants.userId, userId))
          .orderBy(asc(s.staffRoleGrants.grantedAt))
      : [],
    viewer.permissions.has('finance.read')
      ? await db.select({ currency: s.storeCreditAccounts.currency, balanceMinor: s.storeCreditAccounts.balanceMinor }).from(s.storeCreditAccounts).where(eq(s.storeCreditAccounts.customerUserId, userId))
      : null,
  ];
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    displayName: user.displayName,
    locale: user.locale,
    country: user.country,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    phoneVerified: user.phoneVerifiedAt !== null,
    createdAt: user.createdAt,
    staffRoles: await activeStaffRoles(db, userId),
    staffHistory: seeStaff ? grants : undefined,
    merchants: memberships,
    orders: orders.map((o) => ({ currency: o.currency, count: o.n, totalMinor: Number(o.totalMinor) })),
    activeSessions: sessions[0]?.n ?? 0,
    storeCredit: credit?.map((c) => ({ currency: c.currency, balanceMinor: Number(c.balanceMinor) })) ?? undefined,
  };
}

/** Protects staff accounts: only a super admin acts on another staff member's account. */
async function guardTarget(db: Database, actor: Staff, userId: string) {
  if (userId === actor.userId) throw forbidden('You cannot do this to your own account');
  const roles = await activeStaffRoles(db, userId);
  if (roles.length && !actor.permissions.has('staff.manage')) throw forbidden('Only a super admin acts on a staff account');
}

/** Suspension ends every session at once; the person cannot sign in until reactivated. */
export async function suspendUser(db: Database, actor: Staff, userId: string, reason: string) {
  await guardTarget(db, actor, userId);
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for('update');
    if (!user) throw notFound('User');
    if (user.status !== 'active') throw new AppError(409, 'INVALID_USER_STATUS', `This account is ${user.status}`);
    await tx.update(s.users).set({ status: 'suspended' }).where(eq(s.users.id, userId));
    const ended = await tx.update(s.sessions).set({ revokedAt: new Date() }).where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt))).returning({ id: s.sessions.id });
    await audit(tx, actorOf(actor), { action: 'identity.user.suspended', entityType: 'user', entityId: userId, metadata: { reason, sessionsEnded: ended.length } });
    await recordEvent(tx, { type: 'identity.user.suspended', aggregateType: 'user', aggregateId: userId, payload: {} });
    return { status: 'suspended' as const, sessionsEnded: ended.length };
  });
}

export async function reactivateUser(db: Database, actor: Staff, userId: string, note: string) {
  await guardTarget(db, actor, userId);
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for('update');
    if (!user) throw notFound('User');
    if (user.status !== 'suspended') throw new AppError(409, 'INVALID_USER_STATUS', `This account is ${user.status}`);
    await tx.update(s.users).set({ status: 'active' }).where(eq(s.users.id, userId));
    await audit(tx, actorOf(actor), { action: 'identity.user.reactivated', entityType: 'user', entityId: userId, metadata: { note } });
    return { status: 'active' as const };
  });
}

/** Signs the person out everywhere (e.g. a stolen phone or password). */
export async function endSessions(db: Database, actor: Staff, userId: string, reason: string) {
  await guardTarget(db, actor, userId);
  return db.transaction(async (tx) => {
    const ended = await tx.update(s.sessions).set({ revokedAt: new Date() }).where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt))).returning({ id: s.sessions.id });
    await audit(tx, actorOf(actor), { action: 'identity.sessions.ended_by_staff', entityType: 'user', entityId: userId, metadata: { reason, count: ended.length } });
    return { sessionsEnded: ended.length };
  });
}

// --- Staff roles ----------------------------------------------------------------------------------------

export async function listStaff(db: Database) {
  const rows = await db
    .select({
      id: s.staffRoleGrants.id,
      userId: s.staffRoleGrants.userId,
      displayName: s.users.displayName,
      email: s.users.email,
      userStatus: s.users.status,
      role: s.staffRoleGrants.role,
      reason: s.staffRoleGrants.reason,
      grantedAt: s.staffRoleGrants.grantedAt,
      grantedBy: s.staffRoleGrants.grantedBy,
      revokedAt: s.staffRoleGrants.revokedAt,
      revokedBy: s.staffRoleGrants.revokedBy,
      revokeReason: s.staffRoleGrants.revokeReason,
    })
    .from(s.staffRoleGrants)
    .innerJoin(s.users, eq(s.users.id, s.staffRoleGrants.userId))
    .orderBy(desc(s.staffRoleGrants.grantedAt));
  const deciders = [...new Set(rows.flatMap((r) => [r.grantedBy, r.revokedBy]).filter((x): x is string => !!x))];
  const names = new Map(
    deciders.length ? (await db.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, deciders))).map((u) => [u.id, u.name]) : [],
  );
  return {
    roles: Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, [...perms]])),
    active: rows.filter((r) => !r.revokedAt).map((r) => ({ ...r, grantedByName: r.grantedBy ? names.get(r.grantedBy) ?? null : null })),
    history: rows.map((r) => ({ ...r, grantedByName: r.grantedBy ? names.get(r.grantedBy) ?? null : null, revokedByName: r.revokedBy ? names.get(r.revokedBy) ?? null : null })),
  };
}

export async function grantStaffRole(db: Database, actor: Staff, userId: string, role: StaffRole, reason: string) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for('update');
    if (!user) throw notFound('User');
    if (user.status !== 'active') throw new AppError(409, 'INVALID_USER_STATUS', 'Only an active account can become staff');
    if (!user.email) throw badRequest('EMAIL_REQUIRED', 'Staff accounts need an email address');
    const [held] = await tx
      .select({ id: s.staffRoleGrants.id })
      .from(s.staffRoleGrants)
      .where(and(eq(s.staffRoleGrants.userId, userId), eq(s.staffRoleGrants.role, role), isNull(s.staffRoleGrants.revokedAt)));
    if (held) throw new AppError(409, 'ROLE_ALREADY_HELD', 'This person already has this role');
    const [grant] = await tx.insert(s.staffRoleGrants).values({ userId, role, reason, grantedBy: actor.userId }).returning();
    await audit(tx, actorOf(actor), { action: 'staff.role.granted', entityType: 'user', entityId: userId, metadata: { role, reason } });
    return grant!;
  });
}

export async function revokeStaffRole(db: Database, actor: Staff, userId: string, role: StaffRole, reason: string) {
  return db.transaction(async (tx) => {
    // Serialise role changes so two super admins cannot remove each other at the same moment.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('staff_role_grants'))`);
    const [grant] = await tx
      .select()
      .from(s.staffRoleGrants)
      .where(and(eq(s.staffRoleGrants.userId, userId), eq(s.staffRoleGrants.role, role), isNull(s.staffRoleGrants.revokedAt)));
    if (!grant) throw notFound('Role');
    if (role === 'super_admin') {
      if (userId === actor.userId) throw forbidden('Another super admin must remove your super admin role');
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.staffRoleGrants)
        .innerJoin(s.users, eq(s.users.id, s.staffRoleGrants.userId))
        .where(and(eq(s.staffRoleGrants.role, 'super_admin'), isNull(s.staffRoleGrants.revokedAt), eq(s.users.status, 'active')))) as [{ n: number }];
      if (n <= 1) throw new AppError(409, 'LAST_SUPER_ADMIN', 'ARUMA must keep at least one super admin');
    }
    await tx.update(s.staffRoleGrants).set({ revokedAt: new Date(), revokedBy: actor.userId, revokeReason: reason }).where(eq(s.staffRoleGrants.id, grant.id));
    await audit(tx, actorOf(actor), { action: 'staff.role.revoked', entityType: 'user', entityId: userId, metadata: { role, reason } });
    return { revoked: role };
  });
}
