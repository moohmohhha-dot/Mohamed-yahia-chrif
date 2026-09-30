import { and, asc, eq, exists, sql } from 'drizzle-orm';
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
    type: 'individual' | 'business';
    slug: string;
    name: string;
    country: string;
    activityCode: string;
    activityDescription?: string;
    contactEmail?: string;
    contactPhone?: string;
  },
): Promise<Merchant> {
  try {
    return await db.transaction(async (tx) => {
      const [merchant] = await tx.insert(s.merchants).values(input).returning();
      await tx.insert(s.merchantMembers).values({ merchantId: merchant!.id, userId: actor.userId, role: 'owner' });
      await tx
        .insert(s.merchantVerifications)
        .values(
          (['phone', 'email', 'identity', 'business', 'payout'] as const).map((kind) => ({ merchantId: merchant!.id, kind })),
        );
      await audit(tx, actor, { action: 'merchants.merchant.created', entityType: 'merchant', entityId: merchant!.id });
      await recordEvent(tx, {
        type: 'merchants.merchant.created',
        aggregateType: 'merchant',
        aggregateId: merchant!.id,
        payload: { type: input.type, country: input.country, activityCode: input.activityCode },
      });
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

/** Platform staff: merchants filtered by overall status, type, or a check awaiting review (the review queue). */
export async function listMerchants(
  db: Database,
  filter: {
    verificationStatus?: Merchant['verificationStatus'];
    type?: Merchant['type'];
    checkUnderReview?: (typeof s.verificationKind.enumValues)[number];
    page: number;
    pageSize: number;
  },
) {
  const conditions = [];
  if (filter.verificationStatus) conditions.push(eq(s.merchants.verificationStatus, filter.verificationStatus));
  if (filter.type) conditions.push(eq(s.merchants.type, filter.type));
  if (filter.checkUnderReview) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(s.merchantVerifications)
          .where(
            and(
              eq(s.merchantVerifications.merchantId, s.merchants.id),
              eq(s.merchantVerifications.kind, filter.checkUnderReview),
              eq(s.merchantVerifications.status, 'under_review'),
            ),
          ),
      ),
    );
  }
  return db
    .select()
    .from(s.merchants)
    .where(and(...conditions))
    .orderBy(asc(s.merchants.createdAt))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
}

/** Stores the merchant may sell in, with the platform commission. Read-only for merchants. */
export async function listMerchantStores(db: Database, merchantId: string) {
  return db
    .select({
      storeSlug: s.stores.slug,
      storeName: s.stores.name,
      commissionBps: s.storeMerchants.commissionBps,
      status: s.storeMerchants.status,
    })
    .from(s.storeMerchants)
    .innerJoin(s.stores, eq(s.stores.id, s.storeMerchants.storeId))
    .where(eq(s.storeMerchants.merchantId, merchantId));
}
