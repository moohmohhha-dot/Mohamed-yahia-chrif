/** Platform: cross-cutting services every module may use (audit logs, domain events, feature flags). */
export { audit, type AuditEntry } from './audit.js';
export { recordEvent, type DomainEvent } from './events.js';
export { evaluateFlags } from './feature-flags.js';
