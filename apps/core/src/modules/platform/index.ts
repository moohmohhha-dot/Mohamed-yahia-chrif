/** Platform: cross-cutting services every module may use. */
export { audit, type AuditEntry } from './audit.js';
export { recordEvent, type DomainEvent } from './events.js';
export { evaluateFlags } from './feature-flags.js';
export { createSecretBox, type SecretBox } from './secret-box.js';
export { createLocalStorage, type FileStorage } from './storage.js';
export { createLogMessageSender, type MessageSender, type OutboundMessage } from './messages.js';
export { consumeVerificationCode, issueVerificationCode } from './verification-codes.js';
