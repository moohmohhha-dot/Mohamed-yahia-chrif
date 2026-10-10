/** Reason codes used by COD calls, failed deliveries and refusals (translated in the interfaces). */
export const CALL_OUTCOMES = ['confirmed', 'no_answer', 'call_back_later', 'wrong_number', 'declined'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const FAILURE_REASONS = ['customer_absent', 'customer_unreachable', 'wrong_address', 'customer_postponed', 'no_cash', 'other'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const REFUSAL_REASONS = ['changed_mind', 'price', 'did_not_order', 'not_as_expected', 'too_late', 'other'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
