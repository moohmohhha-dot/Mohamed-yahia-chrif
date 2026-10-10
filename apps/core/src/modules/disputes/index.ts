/**
 * Dispute Center: customer ↔ merchant, merchant ↔ customer and merchant ↔ ARUMA disputes, with messages,
 * evidence and documents, ARUMA's decision, one appeal, and the executed resolution (refund, store
 * credit, compensation). Everything is recorded in an append-only audit trail.
 */
export { disputeRoutes } from './routes.js';
export { escalateUnanswered, finalizeDueDisputes } from './service.js';
