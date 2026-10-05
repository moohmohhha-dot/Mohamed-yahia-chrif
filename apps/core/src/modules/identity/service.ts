import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { conflict, forbidden, unauthorized } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, recordEvent } from '../platform/index.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { permissionsOf, type Permission, type StaffRole } from './permissions.js';
import { generateToken, hashToken } from './tokens.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type ClientInfo = {
  ip: string | null;
  userAgent: string | null;
  clientDeviceId: string | null;
  platform: 'web' | 'ios' | 'android';
};

/** `staffRoles` is empty for customers and merchants; `permissions` is what those roles allow (permissions.ts). */
export type AuthContext = { userId: string; sessionId: string; staffRoles: StaffRole[]; permissions: ReadonlySet<Permission> };

export type PublicUser = {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  locale: string | null;
  country: string | null;
  emailVerified: boolean;
  createdAt: Date;
};

export function toPublicUser(u: typeof s.users.$inferSelect): PublicUser {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    displayName: u.displayName,
    locale: u.locale,
    country: u.country,
    emailVerified: u.emailVerifiedAt !== null,
    createdAt: u.createdAt,
  };
}

async function upsertDevice(db: Executor, userId: string, client: ClientInfo): Promise<string> {
  const values = { userId, platform: client.platform, userAgent: client.userAgent, lastSeenAt: new Date() };
  if (!client.clientDeviceId) {
    const [d] = await db.insert(s.devices).values(values).returning({ id: s.devices.id });
    return d!.id;
  }
  const [d] = await db
    .insert(s.devices)
    .values({ ...values, clientDeviceId: client.clientDeviceId })
    .onConflictDoUpdate({
      target: [s.devices.userId, s.devices.clientDeviceId],
      targetWhere: sql`${s.devices.clientDeviceId} is not null`,
      set: { platform: client.platform, userAgent: client.userAgent, lastSeenAt: new Date() },
    })
    .returning({ id: s.devices.id });
  return d!.id;
}

async function createSession(db: Executor, userId: string, client: ClientInfo) {
  const deviceId = await upsertDevice(db, userId, client);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(s.sessions)
    .values({ userId, deviceId, tokenHash: hashToken(token), ip: client.ip, userAgent: client.userAgent, expiresAt })
    .returning({ id: s.sessions.id });
  return { token, expiresAt, sessionId: session!.id };
}

export async function register(
  db: Database,
  input: { email: string; password: string; displayName: string; locale?: string; country?: string },
  client: ClientInfo,
) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email));
    if (taken) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');

    const [user] = await tx
      .insert(s.users)
      .values({ email, displayName: input.displayName.trim(), locale: input.locale, country: input.country })
      .returning();
    await tx.insert(s.accounts).values({ userId: user!.id, provider: 'password', providerAccountId: email, passwordHash });
    const session = await createSession(tx, user!.id, client);

    const actor: Actor = { userId: user!.id, ip: client.ip };
    await audit(tx, actor, { action: 'identity.user.registered', entityType: 'user', entityId: user!.id });
    await recordEvent(tx, {
      type: 'identity.user.registered',
      aggregateType: 'user',
      aggregateId: user!.id,
      payload: { locale: user!.locale, country: user!.country },
    });
    return { user: toPublicUser(user!), token: session.token, expiresAt: session.expiresAt };
  });
}

export async function login(db: Database, input: { email: string; password: string }, client: ClientInfo) {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .select({ user: s.users, passwordHash: s.accounts.passwordHash })
    .from(s.accounts)
    .innerJoin(s.users, eq(s.users.id, s.accounts.userId))
    .where(and(eq(s.accounts.provider, 'password'), eq(s.accounts.providerAccountId, email)));

  const ok = await verifyPassword(input.password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) {
    if (row) {
      await audit(db, { userId: null, ip: client.ip }, {
        action: 'identity.login.failed',
        entityType: 'user',
        entityId: row.user.id,
      });
    }
    throw unauthorized('Invalid email or password');
  }
  if (row.user.status !== 'active') throw forbidden('This account is not active');

  return db.transaction(async (tx) => {
    const session = await createSession(tx, row.user.id, client);
    await audit(tx, { userId: row.user.id, ip: client.ip }, {
      action: 'identity.login.succeeded',
      entityType: 'session',
      entityId: session.sessionId,
    });
    return { user: toPublicUser(row.user), token: session.token, expiresAt: session.expiresAt };
  });
}

export async function activeStaffRoles(db: Executor, userId: string): Promise<StaffRole[]> {
  const rows = await db
    .select({ role: s.staffRoleGrants.role })
    .from(s.staffRoleGrants)
    .where(and(eq(s.staffRoleGrants.userId, userId), isNull(s.staffRoleGrants.revokedAt)));
  return rows.map((r) => r.role);
}

/** Resolves a bearer token to its session, or null if unknown, expired, revoked or the user is inactive. */
export async function authenticate(db: Database, token: string): Promise<AuthContext | null> {
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: s.sessions.id,
      userId: s.users.id,
      status: s.users.status,
      lastUsedAt: s.sessions.lastUsedAt,
    })
    .from(s.sessions)
    .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
    .where(and(eq(s.sessions.tokenHash, hashToken(token)), isNull(s.sessions.revokedAt), gt(s.sessions.expiresAt, now)));
  if (!row || row.status !== 'active') return null;

  if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(s.sessions).set({ lastUsedAt: now }).where(eq(s.sessions.id, row.sessionId));
  }
  const staffRoles = await activeStaffRoles(db, row.userId);
  return { sessionId: row.sessionId, userId: row.userId, staffRoles, permissions: permissionsOf(staffRoles) };
}

export async function getUser(db: Executor, userId: string): Promise<PublicUser> {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!user) throw unauthorized();
  return toPublicUser(user);
}

export async function findUserIdByEmail(db: Executor, email: string): Promise<string | null> {
  const [u] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email.trim().toLowerCase()));
  return u?.id ?? null;
}

export async function listSessions(db: Database, auth: AuthContext) {
  const rows = await db
    .select({
      id: s.sessions.id,
      createdAt: s.sessions.createdAt,
      lastUsedAt: s.sessions.lastUsedAt,
      expiresAt: s.sessions.expiresAt,
      userAgent: s.sessions.userAgent,
      platform: s.devices.platform,
    })
    .from(s.sessions)
    .leftJoin(s.devices, eq(s.devices.id, s.sessions.deviceId))
    .where(and(eq(s.sessions.userId, auth.userId), isNull(s.sessions.revokedAt), gt(s.sessions.expiresAt, new Date())))
    .orderBy(desc(s.sessions.lastUsedAt));
  return rows.map((r) => ({ ...r, current: r.id === auth.sessionId }));
}

/** Revokes one of the user's own sessions. Returns false if it does not exist or belongs to someone else. */
export async function revokeSession(db: Database, auth: AuthContext, sessionId: string, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(s.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.id, sessionId), eq(s.sessions.userId, auth.userId), isNull(s.sessions.revokedAt)))
      .returning({ id: s.sessions.id });
    if (revoked.length === 0) return false;
    await audit(tx, actor, { action: 'identity.session.revoked', entityType: 'session', entityId: sessionId });
    return true;
  });
}
