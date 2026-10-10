/** COD rules: a platform default, overridable per store (e.g. a stricter policy for an expensive vertical). */
import { eq, isNull } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';

export type CodPolicy = {
  requireConfirmation: boolean;
  maxCallAttempts: number;
  maxDeliveryAttempts: number;
  blockAfterRefusals: number;
  maxAmountMinor: bigint | null;
  source: 'store' | 'platform' | 'default';
};

const DEFAULTS: CodPolicy = { requireConfirmation: true, maxCallAttempts: 3, maxDeliveryAttempts: 3, blockAfterRefusals: 3, maxAmountMinor: null, source: 'default' };

const fromRow = (row: typeof s.codPolicies.$inferSelect, source: CodPolicy['source']): CodPolicy => ({
  requireConfirmation: row.requireConfirmation,
  maxCallAttempts: row.maxCallAttempts,
  maxDeliveryAttempts: row.maxDeliveryAttempts,
  blockAfterRefusals: row.blockAfterRefusals,
  maxAmountMinor: row.maxAmountMinor,
  source,
});

export async function codPolicy(db: Executor, storeId: string | null): Promise<CodPolicy> {
  if (storeId) {
    const [store] = await db.select().from(s.codPolicies).where(eq(s.codPolicies.storeId, storeId));
    if (store) return fromRow(store, 'store');
  }
  const [platform] = await db.select().from(s.codPolicies).where(isNull(s.codPolicies.storeId));
  return platform ? fromRow(platform, 'platform') : DEFAULTS;
}

export type PolicyInput = Omit<CodPolicy, 'source' | 'maxAmountMinor'> & { maxAmountMinor: number | null };

/** Sets the platform policy (storeId null) or a store's own policy. */
export async function setCodPolicy(db: Database, actor: Actor, storeId: string | null, input: PolicyInput) {
  const values = { ...input, maxAmountMinor: input.maxAmountMinor === null ? null : BigInt(input.maxAmountMinor), updatedBy: actor.userId, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx
      .insert(s.codPolicies)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: s.codPolicies.storeId, set: values });
    await audit(tx, actor, { action: 'cod.policy.updated', entityType: 'cod_policy', entityId: storeId ?? 'platform', metadata: { ...input } });
  });
  return codPolicy(db, storeId);
}

/** Back to the platform policy for this store. */
export async function clearStorePolicy(db: Database, actor: Actor, storeId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(s.codPolicies).where(eq(s.codPolicies.storeId, storeId));
    await audit(tx, actor, { action: 'cod.policy.cleared', entityType: 'cod_policy', entityId: storeId });
  });
}
