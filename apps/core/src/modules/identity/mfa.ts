/**
 * Two-step verification: password, then a 6-digit code from an authenticator app (or a single-use
 * recovery code). Setting it up signs out every other device; it is mandatory for ARUMA staff.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, notFound, unauthorized } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, type SecretBox } from '../platform/index.js';
import { verifyPassword } from './password.js';
import { generateToken, hashToken } from './tokens.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODES = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const newRecoveryCode = () => {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

export async function mfaStatus(db: Executor, userId: string) {
  const [row] = await db.select({ enabledAt: s.userMfa.enabledAt }).from(s.userMfa).where(eq(s.userMfa.userId, userId));
  const [{ left }] = (await db
    .select({ left: sql<number>`count(*)::int` })
    .from(s.mfaRecoveryCodes)
    .where(and(eq(s.mfaRecoveryCodes.userId, userId), isNull(s.mfaRecoveryCodes.usedAt)))) as [{ left: number }];
  return { enabled: Boolean(row?.enabledAt), enabledAt: row?.enabledAt ?? null, recoveryCodesLeft: row?.enabledAt ? left : 0 };
}

export const isMfaEnabled = async (db: Executor, userId: string) => (await mfaStatus(db, userId)).enabled;

/** Starts (or restarts) the setup: a new secret, shown once, to add to the authenticator app. */
export async function startMfaSetup(db: Database, secrets: SecretBox, userId: string) {
  const [user] = await db.select({ email: s.users.email, phone: s.users.phone }).from(s.users).where(eq(s.users.id, userId));
  if (await isMfaEnabled(db, userId)) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already on');
  const secret = newTotpSecret();
  await db
    .insert(s.userMfa)
    .values({ userId, secretEncrypted: secrets.seal(secret) })
    .onConflictDoUpdate({ target: s.userMfa.userId, set: { secretEncrypted: secrets.seal(secret), enabledAt: null, lastUsedStep: null } });
  return { secret, otpauthUri: otpauthUri(secret, user?.email ?? user?.phone ?? userId) };
}

/**
 * Checks a code from the authenticator app (never the same code twice) or an unused recovery code.
 * Returns how the person proved it, or null.
 */
async function checkSecondFactor(tx: Executor, secrets: SecretBox, userId: string, code: string, allowRecovery = true): Promise<'totp' | 'recovery_code' | null> {
  const [row] = await tx.select().from(s.userMfa).where(eq(s.userMfa.userId, userId)).for('update');
  if (!row) return null;
  const trimmed = code.trim();
  const step = verifyTotp(secrets.open(row.secretEncrypted), trimmed.replace(/\s/g, ''), row.lastUsedStep);
  if (step !== null) {
    await tx.update(s.userMfa).set({ lastUsedStep: step }).where(eq(s.userMfa.userId, userId));
    return 'totp';
  }
  if (!allowRecovery || !row.enabledAt) return null;
  const used = await tx
    .update(s.mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(s.mfaRecoveryCodes.userId, userId), eq(s.mfaRecoveryCodes.codeHash, hashCode(trimmed)), isNull(s.mfaRecoveryCodes.usedAt)))
    .returning({ id: s.mfaRecoveryCodes.id });
  return used.length ? 'recovery_code' : null;
}

async function issueRecoveryCodes(tx: Executor, userId: string) {
  await tx.update(s.mfaRecoveryCodes).set({ usedAt: new Date() }).where(and(eq(s.mfaRecoveryCodes.userId, userId), isNull(s.mfaRecoveryCodes.usedAt)));
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await tx.insert(s.mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashCode(c) })));
  return codes;
}

/** First code confirmed: two-step verification is on. Other devices are signed out; this session counts as verified. */
export async function enableMfa(db: Database, secrets: SecretBox, actor: Actor & { userId: string }, sessionId: string, code: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(s.userMfa).where(eq(s.userMfa.userId, actor.userId)).for('update');
    if (!row) throw new AppError(409, 'MFA_NOT_STARTED', 'Start the setup first');
    if (row.enabledAt) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already on');
    if (!(await checkSecondFactor(tx, secrets, actor.userId, code, false))) throw new AppError(400, 'INVALID_CODE', 'This code is not valid');
    await tx.update(s.userMfa).set({ enabledAt: new Date() }).where(eq(s.userMfa.userId, actor.userId));
    const recoveryCodes = await issueRecoveryCodes(tx, actor.userId);
    await tx.update(s.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(s.sessions.id, sessionId));
    const ended = await tx
      .update(s.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, actor.userId), ne(s.sessions.id, sessionId), isNull(s.sessions.revokedAt)))
      .returning({ id: s.sessions.id });
    await audit(tx, actor, { action: 'identity.mfa.enabled', entityType: 'user', entityId: actor.userId, metadata: { otherSessionsEnded: ended.length } });
    return { recoveryCodes };
  });
}

export async function regenerateRecoveryCodes(db: Database, secrets: SecretBox, actor: Actor & { userId: string }, code: string) {
  return db.transaction(async (tx) => {
    if (!(await isMfaEnabled(tx, actor.userId))) throw new AppError(409, 'MFA_NOT_ENABLED', 'Two-step verification is off');
    if ((await checkSecondFactor(tx, secrets, actor.userId, code, false)) !== 'totp') throw new AppError(400, 'INVALID_CODE', 'This code is not valid');
    const recoveryCodes = await issueRecoveryCodes(tx, actor.userId);
    await audit(tx, actor, { action: 'identity.mfa.recovery_codes_renewed', entityType: 'user', entityId: actor.userId });
    return { recoveryCodes };
  });
}

/** Turning it off needs the password and a current code. Staff cannot turn it off while it is required. */
export async function disableMfa(
  db: Database,
  secrets: SecretBox,
  actor: Actor & { userId: string },
  input: { password: string; code: string },
  opts: { isStaff: boolean; staffMfaRequired: boolean },
) {
  if (opts.isStaff && opts.staffMfaRequired) throw new AppError(409, 'MFA_REQUIRED_FOR_STAFF', 'ARUMA staff must keep two-step verification on');
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ hash: s.accounts.passwordHash }).from(s.accounts).where(and(eq(s.accounts.userId, actor.userId), eq(s.accounts.provider, 'password')));
    if (!account?.hash || !(await verifyPassword(input.password, account.hash))) throw unauthorized('Wrong password');
    if (!(await checkSecondFactor(tx, secrets, actor.userId, input.code))) throw new AppError(400, 'INVALID_CODE', 'This code is not valid');
    await tx.delete(s.mfaRecoveryCodes).where(eq(s.mfaRecoveryCodes.userId, actor.userId));
    await tx.delete(s.userMfa).where(eq(s.userMfa.userId, actor.userId));
    await audit(tx, actor, { action: 'identity.mfa.disabled', entityType: 'user', entityId: actor.userId });
  });
}

/** After a correct password, when two-step verification is on: a short-lived ticket for the code step. */
export async function createChallenge(tx: Executor, userId: string) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await tx.insert(s.mfaChallenges).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { challengeToken: token, expiresAt };
}

/** Second step of sign-in. Returns the user id once the code is right; five wrong codes end the ticket. */
export async function passChallenge(db: Database, secrets: SecretBox, input: { challengeToken: string; code: string }, ip: string | null) {
  return db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(s.mfaChallenges)
      .where(and(eq(s.mfaChallenges.tokenHash, hashToken(input.challengeToken)), isNull(s.mfaChallenges.consumedAt), gt(s.mfaChallenges.expiresAt, new Date())))
      .for('update');
    if (!challenge || challenge.attempts >= CHALLENGE_ATTEMPTS) throw new AppError(401, 'CHALLENGE_EXPIRED', 'Sign in again');
    await tx.update(s.mfaChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(s.mfaChallenges.id, challenge.id));
    const method = await checkSecondFactor(tx, secrets, challenge.userId, input.code);
    if (!method) {
      await audit(tx, { userId: null, ip }, { action: 'identity.mfa.failed', entityType: 'user', entityId: challenge.userId, metadata: { attempt: challenge.attempts + 1 } });
      return { ok: false as const };
    }
    await tx.update(s.mfaChallenges).set({ consumedAt: new Date() }).where(eq(s.mfaChallenges.id, challenge.id));
    return { ok: true as const, userId: challenge.userId, method };
  });
}

/** ARUMA (security) removes a person's two-step verification after checking who they are (lost phone). */
export async function resetMfa(db: Database, actor: Actor, userId: string, reason: string) {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(s.userMfa).where(eq(s.userMfa.userId, userId)).returning({ userId: s.userMfa.userId });
    if (!deleted.length) throw notFound('Two-step verification');
    await tx.delete(s.mfaRecoveryCodes).where(eq(s.mfaRecoveryCodes.userId, userId));
    const ended = await tx.update(s.sessions).set({ revokedAt: new Date() }).where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt))).returning({ id: s.sessions.id });
    await audit(tx, actor, { action: 'identity.mfa.reset', entityType: 'user', entityId: userId, metadata: { reason, sessionsEnded: ended.length } });
  });
}
