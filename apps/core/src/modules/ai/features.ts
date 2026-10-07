/**
 * Every AI feature ARUMA plans, with what runs today. Rule 1 of the AI layer: no core function needs AI.
 * - `rules`: works today without AI (statistics, rules); AI may improve it later.
 * - `rules+ai`: works without AI; with AI switched on, the AI adds to it (a written summary, a better
 *   understanding of free text). If the AI fails, is slow or is switched off, the rules answer.
 * - `ai`: only exists with AI (a chat); switched off, the app shows the normal screens instead.
 * - `planned`: waits for its module (e.g. Support, phase 2).
 */
export type AiAudience = 'customer' | 'merchant' | 'staff';
export type AiEngine = 'rules' | 'rules+ai' | 'ai' | 'planned';

export const AI_FEATURES = [
  { key: 'shopping_assistant', audience: 'customer', engine: 'ai' },
  { key: 'product_comparison', audience: 'customer', engine: 'rules+ai' },
  { key: 'recommendations', audience: 'customer', engine: 'rules' },
  { key: 'natural_language_search', audience: 'customer', engine: 'rules+ai' },
  { key: 'review_summaries', audience: 'customer', engine: 'rules+ai' },
  { key: 'gift_recommendations', audience: 'customer', engine: 'rules+ai' },
  { key: 'smart_bundles', audience: 'customer', engine: 'rules' },
  { key: 'merchant_assistant', audience: 'merchant', engine: 'ai' },
  { key: 'sales_analysis', audience: 'merchant', engine: 'rules+ai' },
  { key: 'pricing_suggestions', audience: 'merchant', engine: 'rules' },
  { key: 'promotion_suggestions', audience: 'merchant', engine: 'rules' },
  { key: 'customer_support', audience: 'customer', engine: 'planned', phase: 2 },
  { key: 'fraud_intelligence', audience: 'staff', engine: 'rules+ai' },
  { key: 'product_classification', audience: 'merchant', engine: 'rules+ai' },
  { key: 'demand_prediction', audience: 'merchant', engine: 'rules' },
] as const satisfies readonly { key: string; audience: AiAudience; engine: AiEngine; phase?: number }[];

export type AiFeatureKey = (typeof AI_FEATURES)[number]['key'];
/** Features with an AI part: each has a switch `ai.<key>` (feature flags), off by default. */
export type AiCallingFeature = Extract<(typeof AI_FEATURES)[number], { engine: 'ai' | 'rules+ai' }>['key'];

export const AI_MASTER_FLAG = 'ai.enabled';
export const flagOf = (feature: AiCallingFeature) => `ai.${feature}`;
/** Merchant and staff features are switched for everyone; customer features for all stores or per store. */
export const isStoreFeature = (feature: AiFeatureKey) => AI_FEATURES.find((f) => f.key === feature)?.audience === 'customer';
