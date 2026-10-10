import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';

export type DomainEvent = {
  /** `<module>.<entity>.<past-tense verb>`, e.g. `identity.user.registered` */
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
};

/**
 * Records a domain event in the outbox. Call inside the same transaction as the change,
 * so an event exists if and only if the change was committed.
 */
export async function recordEvent(db: Executor, event: DomainEvent): Promise<void> {
  await db.insert(s.domainEvents).values({ ...event, payload: event.payload ?? {} });
}
