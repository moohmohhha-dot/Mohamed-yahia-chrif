/** Return rules: a platform default, overridable per store. */
import { eq, isNull } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';

export type ReturnPolicy = {
  windowDays: number;
  merchantResponseHours: number;
  escalationDays: number;
  allowChangeOfMind: boolean;
  changeOfMindFeeMinor: bigint;
  source: 'store' | 'platform' | 'default';
};

const DEFAULTS: ReturnPolicy = { windowDays: 7, merchantResponseHours: 48, escalationDays: 7, allowChangeOfMind: true, changeOfMindFeeMinor: 0n, source: 'default' };

const fromRow = (r: typeof s.returnPolicies.$inferSelect, source: ReturnPolicy['source']): ReturnPolicy => ({
  windowDays: r.windowDays,
  merchantResponseHours: r.merchantResponseHours,
  escalationDays: r.escalationDays,
  allowChangeOfMind: r.allowChangeOfMind,
  changeOfMindFeeMinor: r.changeOfMindFeeMinor,
  source,
});

export async function returnPolicy(db: Executor, storeId: string | null): Promise<ReturnPolicy> {
  if (storeId) {
    const [store] = await db.select().from(s.returnPolicies).where(eq(s.returnPolicies.storeId, storeId));
    if (store) return fromRow(store, 'store');
  }
  const [platform] = await db.select().from(s.returnPolicies).where(isNull(s.returnPolicies.storeId));
  return platform ? fromRow(platform, 'platform') : DEFAULTS;
}

export type ReturnPolicyInput = Omit<ReturnPolicy, 'source' | 'changeOfMindFeeMinor'> & { changeOfMindFeeMinor: number };

export async function setReturnPolicy(db: Database, actor: Actor, storeId: string | null, input: ReturnPolicyInput) {
  const values = { ...input, changeOfMindFeeMinor: BigInt(input.changeOfMindFeeMinor), updatedBy: actor.userId, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(s.returnPolicies).values({ storeId, ...values }).onConflictDoUpdate({ target: s.returnPolicies.storeId, set: values });
    await audit(tx, actor, { action: 'returns.policy.updated', entityType: 'return_policy', entityId: storeId ?? 'platform', metadata: { ...input } });
  });
  return returnPolicy(db, storeId);
}

export async function clearReturnPolicy(db: Database, actor: Actor, storeId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(s.returnPolicies).where(eq(s.returnPolicies.storeId, storeId));
    await audit(tx, actor, { action: 'returns.policy.cleared', entityType: 'return_policy', entityId: storeId });
  });
}
