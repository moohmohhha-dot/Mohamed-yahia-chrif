import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import type { Actor } from '../../shared/request-context.js';

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};

/** Appends to the audit trail. Call inside the same transaction as the change. */
export async function audit(db: Executor, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await db.insert(s.auditLogs).values({
    actorType: actor?.userId ? 'user' : 'system',
    actorUserId: actor?.userId ?? null,
    ip: actor?.ip ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  });
}
