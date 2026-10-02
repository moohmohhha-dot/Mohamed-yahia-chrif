/**
 * Configurable finance parameters, never hardcoded: commission rates and settings are rows with an
 * effective date. Changing them creates a new row (the history stays) and affects new orders only,
 * because each order stores the commission and fee in force when it was placed.
 */
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';

export type SettingKey = 'hold_days' | 'order_fee_minor';

/** Merchant override in the store › store rule › platform rule, as of `at`. */
export async function resolveCommissionBps(db: Executor, storeId: string, merchantId: string, at = new Date()): Promise<number> {
  const [override] = await db
    .select({ bps: s.storeMerchants.commissionBps })
    .from(s.storeMerchants)
    .where(and(eq(s.storeMerchants.storeId, storeId), eq(s.storeMerchants.merchantId, merchantId)));
  if (override?.bps !== null && override?.bps !== undefined) return override.bps;
  for (const scope of [eq(s.commissionRules.storeId, storeId), isNull(s.commissionRules.storeId)]) {
    const [rule] = await db
      .select({ bps: s.commissionRules.bps })
      .from(s.commissionRules)
      .where(and(scope, lte(s.commissionRules.effectiveFrom, at)))
      .orderBy(desc(s.commissionRules.effectiveFrom), desc(s.commissionRules.createdAt))
      .limit(1);
    if (rule) return rule.bps;
  }
  throw new AppError(500, 'COMMISSION_NOT_CONFIGURED', 'No commission rule is configured');
}

export async function getSetting(db: Executor, key: SettingKey, at = new Date()): Promise<number> {
  const [row] = await db
    .select({ value: s.financeSettings.value })
    .from(s.financeSettings)
    .where(and(eq(s.financeSettings.key, key), lte(s.financeSettings.effectiveFrom, at)))
    .orderBy(desc(s.financeSettings.effectiveFrom), desc(s.financeSettings.createdAt))
    .limit(1);
  if (!row) throw new AppError(500, 'SETTING_NOT_CONFIGURED', `Finance setting ${key} is not configured`);
  return row.value;
}

export async function addCommissionRule(
  db: Database,
  actor: Actor,
  input: { storeId?: string; bps: number; effectiveFrom: Date; reason: string },
) {
  return db.transaction(async (tx) => {
    const [rule] = await tx
      .insert(s.commissionRules)
      .values({
        scope: input.storeId ? 'store' : 'platform',
        storeId: input.storeId ?? null,
        bps: input.bps,
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
        createdBy: actor.userId,
      })
      .returning();
    await audit(tx, actor, { action: 'finance.commission_rule.added', entityType: 'commission_rule', entityId: rule!.id, metadata: { ...input } });
    return rule!;
  });
}

export async function addSetting(db: Database, actor: Actor, input: { key: SettingKey; value: number; effectiveFrom: Date; reason: string }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(s.financeSettings).values({ ...input, createdBy: actor.userId }).returning();
    await audit(tx, actor, { action: 'finance.setting.added', entityType: 'finance_setting', entityId: row!.id, metadata: { ...input } });
    return row!;
  });
}

export async function listRules(db: Database) {
  const [rules, settings] = await Promise.all([
    db.select().from(s.commissionRules).orderBy(desc(s.commissionRules.effectiveFrom)),
    db.select().from(s.financeSettings).orderBy(desc(s.financeSettings.effectiveFrom)),
  ]);
  const now = new Date();
  return {
    current: {
      platformCommissionBps: rules.find((r) => r.scope === 'platform' && r.effectiveFrom <= now)?.bps ?? null,
      holdDays: settings.find((x) => x.key === 'hold_days' && x.effectiveFrom <= now)?.value ?? null,
      orderFeeMinor: settings.find((x) => x.key === 'order_fee_minor' && x.effectiveFrom <= now)?.value ?? null,
    },
    commissionRules: rules,
    settings,
  };
}

/** Rounds `amount × bps / 10000` to the nearest minor unit (half up). 10 000 DZD × 8 % = 800 DZD. */
export const percentOf = (amount: bigint, bps: number) => (amount * BigInt(bps) + 5000n) / 10000n;
