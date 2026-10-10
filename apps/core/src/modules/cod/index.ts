/**
 * Cash on delivery: confirmation, amount due, delivery attempts, refusals, collection and courier
 * remittances, customer risk signals. The orders module drives it from the order and parcel flow.
 */
export { codRoutes } from './routes.js';
export { codPolicy, type CodPolicy } from './policy.js';
export { assessCustomer, type CustomerAssessment } from './risk.js';
export { codEvent, codRecord, describeCod, openCodRecord, updateCodRecord, type CodActor, type CodRecord } from './records.js';
export { CALL_OUTCOMES, FAILURE_REASONS, REFUSAL_REASONS, type CallOutcome, type FailureReason, type RefusalReason } from './reasons.js';
