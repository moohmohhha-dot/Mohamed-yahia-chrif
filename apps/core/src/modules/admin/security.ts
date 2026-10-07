/**
 * Security monitoring: signals computed from the audit log (which nobody can edit). Shown in the Admin
 * Panel (Security) and written to the server log every 15 minutes, where an alerting service can watch
 * for them (docs/SECURITY.md).
 */
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';

export type Alert = { severity: 'high' | 'medium' | 'info'; code: string; count: number; subject: string | null; lastAt: string };

const HOUR = 3600_000;

export async function securityAlerts(db: Database, now = new Date()): Promise<Alert[]> {
  const lastHour = new Date(now.getTime() - HOUR);
  const lastDay = new Date(now.getTime() - 24 * HOUR);
  const alerts: Alert[] = [];
  const grouped = async (action: string, since: Date, by: 'ip' | 'actor' | 'entity', min: number) => {
    const key = by === 'ip' ? sql<string>`host(${s.auditLogs.ip})` : by === 'actor' ? sql<string>`${s.auditLogs.actorUserId}::text` : sql<string>`${s.auditLogs.entityId}`;
    return db
      .select({ subject: key, count: sql<number>`count(*)::int`, lastAt: sql<string>`max(${s.auditLogs.createdAt})::text` })
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.action, action), gt(s.auditLogs.createdAt, since)))
      .groupBy(key)
      .having(sql`count(*) >= ${min}`)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
  };
  const push = (severity: Alert['severity'], code: string, rows: { subject: string | null; count: number; lastAt: string }[]) =>
    rows.forEach((r) => alerts.push({ severity, code, count: r.count, subject: r.subject, lastAt: r.lastAt }));

  // Password guessing: many failures from one address, or against one account (then locked).
  push('high', 'brute_force_ip', await grouped('identity.login.failed', lastHour, 'ip', 20));
  push('high', 'account_locked', await grouped('identity.login.locked', lastHour, 'entity', 1));
  push('high', 'mfa_code_guessing', await grouped('identity.mfa.failed', lastHour, 'entity', 5));
  // Someone signed in probing admin routes they may not use.
  push('medium', 'access_denied', await grouped('security.access_denied', lastHour, 'actor', 10));
  // Many identity documents opened by one person: possible data collection.
  push('medium', 'document_mass_viewing', await grouped('merchants.document.viewed', lastHour, 'actor', 30));
  // Sensitive changes (expected, but always reviewed).
  for (const [code, action] of [
    ['staff_role_change', 'staff.role.granted'],
    ['staff_role_change', 'staff.role.revoked'],
    ['mfa_reset', 'identity.mfa.reset'],
    ['mfa_disabled', 'identity.mfa.disabled'],
    ['feature_flag_change', 'platform.feature_flag.changed'],
    ['feature_flag_change', 'platform.feature_flag.store_changed'],
    ['commission_change', 'finance.commission_rule.added'],
  ] as const) {
    push(code === 'mfa_reset' || code === 'staff_role_change' ? 'medium' : 'info', code, await grouped(action, lastDay, 'entity', 1));
  }
  // Money: the last reconciliation with the Payment Service found differences.
  const [run] = await db.select().from(s.reconciliationRuns).orderBy(desc(s.reconciliationRuns.createdAt)).limit(1);
  if (run && !run.balanced) alerts.push({ severity: 'high', code: 'reconciliation_mismatch', count: run.discrepancies.length, subject: run.id, lastAt: run.createdAt.toISOString() });
  return alerts.sort((a, b) => ['high', 'medium', 'info'].indexOf(a.severity) - ['high', 'medium', 'info'].indexOf(b.severity));
}

/** Names for the subjects of alerts (users), for the panel. */
export async function alertSubjects(db: Database, alerts: Alert[]) {
  const ids = [...new Set(alerts.map((a) => a.subject).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/.test(x)))];
  if (!ids.length) return {};
  const rows = await db.select({ id: s.users.id, name: s.users.displayName, email: s.users.email }).from(s.users).where(inArray(s.users.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, `${r.name} <${r.email ?? ''}>`]));
}
