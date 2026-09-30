import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { conflict, forbidden, isUniqueViolation, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { findUserIdByEmail } from '../identity/index.js';
import { audit, recordEvent } from '../platform/index.js';

export type MerchantRole = 'owner' | 'manager' | 'staff';
type Merchant = typeof s.merchants.$inferSelect;

export async function createMerchant(
  db: Database,
  actor: Actor & { userId: string },
  input: {
    slug: string;
    name: string;
    legalName?: string;
    country?: string;
    contactEmail?: string;
    contactPhone?: string;
  },
): Promise<Merchant> {
  try {
    return await db.transaction(async (tx) => {
      const [merchant] = await tx.insert(s.merchants).values(input).returning();
      await tx.insert(s.merchantMembers).values({ merchantId: merchant!.id, userId: actor.userId, role: 'owner' });
      await audit(tx, actor, { action: 'merchants.merchant.created', entityType: 'merchant', entityId: merchant!.id });
      await recordEvent(tx, { type: 'merchants.merchant.created', aggregateType: 'merchant', aggregateId: merchant!.id });
      return merchant!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SLUG_TAKEN', 'This merchant slug is already used');
    throw error;
  }
}

/** Returns the caller's role in the merchant, throwing 404 if they are not a member (so non-members learn nothing). */
export async function requireMembership(
  db: Executor,
  merchantId: string,
  userId: string,
  allowed: MerchantRole[] = ['owner', 'manager', 'staff'],
): Promise<MerchantRole> {
  const [m] = await db
    .select({ role: s.merchantMembers.role })
    .from(s.merchantMembers)
    .where(and(eq(s.merchantMembers.merchantId, merchantId), eq(s.merchantMembers.userId, userId)));
  if (!m) throw notFound('Merchant');
  if (!allowed.includes(m.role)) throw forbidden(`Requires role: ${allowed.join(' or ')}`);
  return m.role;
}

export async function getMerchant(db: Executor, merchantId: string): Promise<Merchant> {
  const [m] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
  if (!m) throw notFound('Merchant');
  return m;
}

export async function listMyMerchants(db: Database, userId: string) {
  return db
    .select({ merchant: s.merchants, role: s.merchantMembers.role })
    .from(s.merchantMembers)
    .innerJoin(s.merchants, eq(s.merchants.id, s.merchantMembers.merchantId))
    .where(eq(s.merchantMembers.userId, userId));
}

export async function listStaff(db: Database, merchantId: string) {
  return db
    .select({
      userId: s.users.id,
      displayName: s.users.displayName,
      email: s.users.email,
      role: s.merchantMembers.role,
      since: s.merchantMembers.createdAt,
    })
    .from(s.merchantMembers)
    .innerJoin(s.users, eq(s.users.id, s.merchantMembers.userId))
    .where(eq(s.merchantMembers.merchantId, merchantId));
}

/** Adds a user to the merchant or changes their role. Only owners may grant `manager`. Owners cannot be changed. */
export async function setStaffMember(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  input: { email: string; role: 'manager' | 'staff' },
) {
  return db.transaction(async (tx) => {
    const callerRole = await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    if (input.role === 'manager' && callerRole !== 'owner') throw forbidden('Only the owner can add managers');

    const userId = await findUserIdByEmail(tx, input.email);
    if (!userId) throw notFound('User');

    const [existing] = await tx
      .select({ role: s.merchantMembers.role })
      .from(s.merchantMembers)
      .where(and(eq(s.merchantMembers.merchantId, merchantId), eq(s.merchantMembers.userId, userId)));
    if (existing?.role === 'owner') throw conflict('OWNER_IMMUTABLE', "The owner's role cannot be changed");
    if (existing?.role === 'manager' && callerRole !== 'owner') throw forbidden('Only the owner can change managers');

    await tx
      .insert(s.merchantMembers)
      .values({ merchantId, userId, role: input.role })
      .onConflictDoUpdate({ target: [s.merchantMembers.merchantId, s.merchantMembers.userId], set: { role: input.role } });
    await audit(tx, actor, {
      action: 'merchants.staff.set',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { userId, role: input.role, previousRole: existing?.role ?? null },
    });
    return { userId, role: input.role };
  });
}

export async function removeStaffMember(db: Database, actor: Actor & { userId: string }, merchantId: string, userId: string) {
  await db.transaction(async (tx) => {
    const callerRole = await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    const [target] = await tx
      .select({ role: s.merchantMembers.role })
      .from(s.merchantMembers)
      .where(and(eq(s.merchantMembers.merchantId, merchantId), eq(s.merchantMembers.userId, userId)));
    if (!target) throw notFound('Staff member');
    if (target.role === 'owner') throw conflict('OWNER_IMMUTABLE', 'The owner cannot be removed');
    if (target.role === 'manager' && callerRole !== 'owner') throw forbidden('Only the owner can remove managers');

    await tx
      .delete(s.merchantMembers)
      .where(and(eq(s.merchantMembers.merchantId, merchantId), eq(s.merchantMembers.userId, userId)));
    await audit(tx, actor, {
      action: 'merchants.staff.removed',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { userId, role: target.role },
    });
  });
}

/** The owner asks the platform to verify the merchant (from unverified or after a rejection). */
export async function submitVerification(db: Database, actor: Actor & { userId: string }, merchantId: string) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner']);
    const [updated] = await tx
      .update(s.merchants)
      .set({ verificationStatus: 'pending', verificationSubmittedAt: new Date(), verificationNote: null })
      .where(and(eq(s.merchants.id, merchantId), inArray(s.merchants.verificationStatus, ['unverified', 'rejected'])))
      .returning();
    if (!updated) throw conflict('INVALID_VERIFICATION_STATE', 'Verification is already pending or approved');
    await audit(tx, actor, { action: 'merchants.verification.submitted', entityType: 'merchant', entityId: merchantId });
    await recordEvent(tx, { type: 'merchants.verification.submitted', aggregateType: 'merchant', aggregateId: merchantId });
    return updated;
  });
}

/** Platform staff approve or reject a pending verification. Approval also activates the merchant. */
export async function decideVerification(
  db: Database,
  actor: Actor,
  merchantId: string,
  input: { decision: 'approve' | 'reject'; note?: string },
) {
  return db.transaction(async (tx) => {
    const approved = input.decision === 'approve';
    const [updated] = await tx
      .update(s.merchants)
      .set({
        verificationStatus: approved ? 'verified' : 'rejected',
        verificationDecidedAt: new Date(),
        verificationNote: input.note ?? null,
        ...(approved ? { status: 'active' as const } : {}),
      })
      .where(and(eq(s.merchants.id, merchantId), eq(s.merchants.verificationStatus, 'pending')))
      .returning();
    if (!updated) {
      await getMerchant(tx, merchantId); // 404 if missing
      throw conflict('INVALID_VERIFICATION_STATE', 'Verification is not pending');
    }
    const action = approved ? 'merchants.verification.approved' : 'merchants.verification.rejected';
    await audit(tx, actor, { action, entityType: 'merchant', entityId: merchantId, metadata: { note: input.note ?? null } });
    await recordEvent(tx, { type: action, aggregateType: 'merchant', aggregateId: merchantId });
    return updated;
  });
}

/** Platform staff allow a merchant to sell in a store (an ARUMA app), with its commission. */
export async function attachMerchantToStore(
  db: Database,
  actor: Actor,
  input: { storeId: string; merchantId: string; commissionBps: number },
) {
  return db.transaction(async (tx) => {
    await getMerchant(tx, input.merchantId);
    const [row] = await tx
      .insert(s.storeMerchants)
      .values({ ...input, status: 'active' })
      .onConflictDoUpdate({
        target: [s.storeMerchants.storeId, s.storeMerchants.merchantId],
        set: { commissionBps: input.commissionBps, status: 'active' },
      })
      .returning();
    await audit(tx, actor, {
      action: 'merchants.store.attached',
      entityType: 'merchant',
      entityId: input.merchantId,
      metadata: { storeId: input.storeId, commissionBps: input.commissionBps },
    });
    return row!;
  });
}
