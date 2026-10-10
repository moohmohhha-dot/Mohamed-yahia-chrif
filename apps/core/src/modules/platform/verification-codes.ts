import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';

const TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

type CodeRef = { purpose: string; subjectId: string; target: string };

const hashCode = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex');

/** Creates a 6-digit code for `target` and returns it so the caller can send it. At most one per minute. */
export async function issueVerificationCode(db: Executor, ref: CodeRef): Promise<string> {
  const [last] = await db
    .select({ createdAt: s.verificationCodes.createdAt })
    .from(s.verificationCodes)
    .where(and(eq(s.verificationCodes.purpose, ref.purpose), eq(s.verificationCodes.subjectId, ref.subjectId)))
    .orderBy(desc(s.verificationCodes.createdAt))
    .limit(1);
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError(429, 'CODE_RECENTLY_SENT', 'Please wait a minute before requesting a new code');
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const id = randomUUID();
  await db
    .insert(s.verificationCodes)
    .values({ ...ref, id, codeHash: hashCode(id, code), expiresAt: new Date(Date.now() + TTL_MS) });
  return code;
}

/**
 * Checks the latest unused code for this subject and target. Throws on a wrong, expired or exhausted code.
 * Must NOT run inside a transaction that rolls back on failure, or failed attempts would not be counted.
 */
export async function consumeVerificationCode(db: Executor, ref: CodeRef, code: string): Promise<void> {
  const [row] = await db
    .select()
    .from(s.verificationCodes)
    .where(
      and(
        eq(s.verificationCodes.purpose, ref.purpose),
        eq(s.verificationCodes.subjectId, ref.subjectId),
        eq(s.verificationCodes.target, ref.target),
        isNull(s.verificationCodes.consumedAt),
      ),
    )
    .orderBy(desc(s.verificationCodes.createdAt))
    .limit(1);
  const invalid = badRequest('INVALID_CODE', 'The code is invalid or has expired');
  if (!row || row.expiresAt < new Date() || row.attempts >= MAX_ATTEMPTS) throw invalid;

  await db
    .update(s.verificationCodes)
    .set({ attempts: row.attempts + 1 })
    .where(eq(s.verificationCodes.id, row.id));
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashCode(row.id, code), 'hex');
  if (!timingSafeEqual(expected, actual)) throw invalid;

  await db.update(s.verificationCodes).set({ consumedAt: new Date() }).where(eq(s.verificationCodes.id, row.id));
}
