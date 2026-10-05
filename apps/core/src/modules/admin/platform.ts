/** Audit log, feature flags, stores and settlements for the Admin Panel. */
import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit } from '../platform/index.js';

export async function listAuditLog(db: Database, q: { action?: string; entityType?: string; entityId?: string; actorUserId?: string; from?: Date; to?: Date; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.action) where.push(sql`${s.auditLogs.action} like ${`${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}`);
  if (q.entityType) where.push(eq(s.auditLogs.entityType, q.entityType));
  if (q.entityId) where.push(eq(s.auditLogs.entityId, q.entityId));
  if (q.actorUserId) where.push(eq(s.auditLogs.actorUserId, q.actorUserId));
  if (q.from) where.push(gte(s.auditLogs.createdAt, q.from));
  if (q.to) where.push(lt(s.auditLogs.createdAt, q.to));
  const rows = await db
    .select({
      id: s.auditLogs.id,
      action: s.auditLogs.action,
      actorType: s.auditLogs.actorType,
      actorUserId: s.auditLogs.actorUserId,
      actorName: s.users.displayName,
      actorEmail: s.users.email,
      entityType: s.auditLogs.entityType,
      entityId: s.auditLogs.entityId,
      ip: s.auditLogs.ip,
      metadata: s.auditLogs.metadata,
      createdAt: s.auditLogs.createdAt,
    })
    .from(s.auditLogs)
    .leftJoin(s.users, eq(s.users.id, s.auditLogs.actorUserId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.auditLogs.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return rows;
}

export async function listStores(db: Database) {
  return db.select({ id: s.stores.id, slug: s.stores.slug, name: s.stores.name, vertical: s.stores.vertical, status: s.stores.status, defaultCurrency: s.stores.defaultCurrency, defaultLocale: s.stores.defaultLocale }).from(s.stores).orderBy(asc(s.stores.slug));
}

export async function listFlags(db: Database) {
  const [flags, overrides] = [
    await db.select().from(s.featureFlags).orderBy(asc(s.featureFlags.key)),
    await db
      .select({ flagKey: s.featureFlagOverrides.flagKey, storeId: s.featureFlagOverrides.storeId, storeSlug: s.stores.slug, enabled: s.featureFlagOverrides.enabled })
      .from(s.featureFlagOverrides)
      .innerJoin(s.stores, eq(s.stores.id, s.featureFlagOverrides.storeId)),
  ];
  return flags.map((f) => ({
    key: f.key,
    description: f.description,
    enabledByDefault: f.enabledByDefault,
    updatedAt: f.updatedAt,
    overrides: overrides.filter((o) => o.flagKey === f.key).map(({ storeId, storeSlug, enabled }) => ({ storeId, storeSlug, enabled })),
  }));
}

/** Switches a feature on or off for every store (unless a store has its own setting). Always with a reason. */
export async function setFlagDefault(db: Database, actor: Actor, key: string, enabled: boolean, reason: string) {
  return db.transaction(async (tx) => {
    const [flag] = await tx.select().from(s.featureFlags).where(eq(s.featureFlags.key, key)).for('update');
    if (!flag) throw notFound('Feature flag');
    await tx.update(s.featureFlags).set({ enabledByDefault: enabled }).where(eq(s.featureFlags.key, key));
    await audit(tx, actor, { action: 'platform.feature_flag.changed', entityType: 'feature_flag', entityId: key, metadata: { from: flag.enabledByDefault, to: enabled, reason } });
  });
}

/** A store's own setting (true / false), or null to follow the default again. */
export async function setFlagForStore(db: Database, actor: Actor, key: string, storeId: string, enabled: boolean | null, reason: string) {
  return db.transaction(async (tx) => {
    const [flag] = await tx.select().from(s.featureFlags).where(eq(s.featureFlags.key, key));
    if (!flag) throw notFound('Feature flag');
    const [store] = await tx.select({ id: s.stores.id, slug: s.stores.slug }).from(s.stores).where(eq(s.stores.id, storeId));
    if (!store) throw notFound('Store');
    const where = and(eq(s.featureFlagOverrides.flagKey, key), eq(s.featureFlagOverrides.storeId, storeId));
    const [before] = await tx.select().from(s.featureFlagOverrides).where(where);
    if (enabled === null) await tx.delete(s.featureFlagOverrides).where(where);
    else await tx.insert(s.featureFlagOverrides).values({ flagKey: key, storeId, enabled }).onConflictDoUpdate({ target: [s.featureFlagOverrides.flagKey, s.featureFlagOverrides.storeId], set: { enabled } });
    await audit(tx, actor, { action: 'platform.feature_flag.store_changed', entityType: 'feature_flag', entityId: key, metadata: { store: store.slug, from: before?.enabled ?? null, to: enabled, reason } });
  });
}

export async function listSettlements(db: Database, q: { merchantId?: string; page: number; pageSize: number }) {
  const rows = await db
    .select({
      id: s.settlements.id,
      number: s.settlements.number,
      merchantId: s.settlements.merchantId,
      merchantName: s.merchants.name,
      currency: s.settlements.currency,
      amountMinor: s.settlements.amountMinor,
      periodEnd: s.settlements.periodEnd,
      breakdown: s.settlements.breakdown,
      payoutStatus: s.payouts.status,
      createdAt: s.settlements.createdAt,
    })
    .from(s.settlements)
    .innerJoin(s.merchants, eq(s.merchants.id, s.settlements.merchantId))
    .leftJoin(s.payouts, eq(s.payouts.settlementId, s.settlements.id))
    .where(q.merchantId ? eq(s.settlements.merchantId, q.merchantId) : undefined)
    .orderBy(desc(s.settlements.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) }));
}
