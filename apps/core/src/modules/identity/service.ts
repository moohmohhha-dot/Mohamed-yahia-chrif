import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, recordEvent, type SecretBox } from '../platform/index.js';
import { createChallenge, isMfaEnabled, passChallenge } from './mfa.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { permissionsOf, type Permission, type StaffRole } from './permissions.js';
import { generateToken, hashToken } from './tokens.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** ARUMA staff sessions are short: 12 hours at most, ended after 30 minutes without activity. */
export const STAFF_SESSION_MAX_MS = 12 * 3600_000;
export const STAFF_SESSION_IDLE_MS = 30 * 60_000;
/** After 10 wrong passwords in 15 minutes, the account refuses sign-in for 15 minutes (even with the right password). */
const LOCKOUT_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60_000;

export type ClientInfo = {
  ip: string | null;
  userAgent: string | null;
  clientDeviceId: string | null;
  platform: 'web' | 'ios' | 'android';
};

/** `staffRoles` is empty for customers and merchants; `permissions` is what those roles allow (permissions.ts). */
export type AuthContext = {
  userId: string;
  sessionId: string;
  staffRoles: StaffRole[];
  permissions: ReadonlySet<Permission>;
  /** This sign-in was confirmed with two-step verification. */
  mfa: boolean;
};

/** Common passwords people try first; refused whatever their length. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'motdepasse', 'azertyuiop', 'qwertyuiop', '1234567890', '12345678910', '0123456789',
  'iloveyou123', 'algerie123', 'algeria123', 'dzdzdzdzdz', 'aaaaaaaaaa', 'abcdefghij', '1111111111', 'azerty1234', 'qwerty1234',
  'welcome123', 'bienvenue1', 'admin12345', 'aruma12345', 'mbparfum123', 'parfum1234', 'soleil1234', 'football12',
]);

/** At least 10 characters, not a common password, not built on the email address. */
export function checkPasswordStrength(password: string, email?: string) {
  const lower = password.toLowerCase();
  const local = email?.split('@')[0]?.toLowerCase();
  if (password.length < 10) throw badRequest('WEAK_PASSWORD', 'Use at least 10 characters');
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password) || (local && local.length >= 4 && lower.includes(local))) {
    throw badRequest('WEAK_PASSWORD', 'This password is too easy to guess');
  }
}

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

export async function createSession(db: Executor, userId: string, client: ClientInfo, mfaVerified = false) {
  const deviceId = await upsertDevice(db, userId, client);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(s.sessions)
    .values({ userId, deviceId, tokenHash: hashToken(token), ip: client.ip, userAgent: client.userAgent, expiresAt, mfaVerifiedAt: mfaVerified ? new Date() : null })
    .returning({ id: s.sessions.id });
  return { token, expiresAt, sessionId: session!.id };
}

export async function register(
  db: Database,
  input: { email: string; password: string; displayName: string; locale?: string; country?: string },
  client: ClientInfo,
) {
  const email = input.email.trim().toLowerCase();
  checkPasswordStrength(input.password, email);
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
  if (row) {
    const [{ failures }] = (await db
      .select({ failures: sql<number>`count(*)::int` })
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.entityType, 'user'),
          eq(s.auditLogs.entityId, row.user.id),
          eq(s.auditLogs.action, 'identity.login.failed'),
          gt(s.auditLogs.createdAt, new Date(Date.now() - LOCKOUT_WINDOW_MS)),
        ),
      )) as [{ failures: number }];
    if (failures >= LOCKOUT_FAILURES) {
      await audit(db, { userId: null, ip: client.ip }, { action: 'identity.login.locked', entityType: 'user', entityId: row.user.id });
      throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many wrong passwords: try again in 15 minutes');
    }
  }
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
    // Two-step verification on: the password is right, the code comes next (no session yet).
    if (await isMfaEnabled(tx, row.user.id)) {
      const challenge = await createChallenge(tx, row.user.id);
      await audit(tx, { userId: null, ip: client.ip }, { action: 'identity.login.password_ok', entityType: 'user', entityId: row.user.id });
      return { mfaRequired: true as const, ...challenge };
    }
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
      createdAt: s.sessions.createdAt,
      mfaVerifiedAt: s.sessions.mfaVerifiedAt,
    })
    .from(s.sessions)
    .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
    .where(and(eq(s.sessions.tokenHash, hashToken(token)), isNull(s.sessions.revokedAt), gt(s.sessions.expiresAt, now)));
  if (!row || row.status !== 'active') return null;

  const staffRoles = await activeStaffRoles(db, row.userId);
  if (staffRoles.length && (now.getTime() - row.createdAt.getTime() > STAFF_SESSION_MAX_MS || now.getTime() - row.lastUsedAt.getTime() > STAFF_SESSION_IDLE_MS)) {
    await db.update(s.sessions).set({ revokedAt: now }).where(eq(s.sessions.id, row.sessionId));
    return null;
  }
  if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(s.sessions).set({ lastUsedAt: now }).where(eq(s.sessions.id, row.sessionId));
  }
  return { sessionId: row.sessionId, userId: row.userId, staffRoles, permissions: permissionsOf(staffRoles), mfa: row.mfaVerifiedAt !== null };
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

/** Second step of sign-in: the code from the authenticator app (or a recovery code) opens the session. */
export async function completeMfaLogin(db: Database, secrets: SecretBox, input: { challengeToken: string; code: string }, client: ClientInfo) {
  const result = await passChallenge(db, secrets, input, client.ip);
  if (!result.ok) throw new AppError(401, 'INVALID_CODE', 'This code is not valid');
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(s.users).where(eq(s.users.id, result.userId));
    if (!user || user.status !== 'active') throw forbidden('This account is not active');
    const session = await createSession(tx, user.id, client, true);
    await audit(tx, { userId: user.id, ip: client.ip }, { action: 'identity.login.succeeded', entityType: 'session', entityId: session.sessionId, metadata: { mfa: result.method } });
    return { user: toPublicUser(user), token: session.token, expiresAt: session.expiresAt };
  });
}

/** A new password ends every other session (someone may know the old one). */
export async function changePassword(db: Database, auth: AuthContext, input: { currentPassword: string; newPassword: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: s.accounts.id, hash: s.accounts.passwordHash, email: s.users.email })
      .from(s.accounts)
      .innerJoin(s.users, eq(s.users.id, s.accounts.userId))
      .where(and(eq(s.accounts.userId, auth.userId), eq(s.accounts.provider, 'password')));
    if (!row?.hash || !(await verifyPassword(input.currentPassword, row.hash))) throw unauthorized('Wrong password');
    checkPasswordStrength(input.newPassword, row.email ?? undefined);
    await tx.update(s.accounts).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(s.accounts.id, row.id));
    const ended = await tx
      .update(s.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, auth.userId), ne(s.sessions.id, auth.sessionId), isNull(s.sessions.revokedAt)))
      .returning({ id: s.sessions.id });
    await audit(tx, actor, { action: 'identity.password.changed', entityType: 'user', entityId: auth.userId, metadata: { otherSessionsEnded: ended.length } });
    return { otherSessionsEnded: ended.length };
  });
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
