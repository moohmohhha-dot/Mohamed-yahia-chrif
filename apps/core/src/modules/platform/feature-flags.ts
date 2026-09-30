import { eq } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';

/** Every flag with its effective value for one store (store override wins over the default). */
export async function evaluateFlags(db: Executor, storeId: string): Promise<Record<string, boolean>> {
  const [flags, overrides] = await Promise.all([
    db.select().from(s.featureFlags),
    db.select().from(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId)),
  ]);
  const byKey = new Map(overrides.map((o) => [o.flagKey, o.enabled]));
  return Object.fromEntries(flags.map((f) => [f.key, byKey.get(f.key) ?? f.enabledByDefault]));
}
