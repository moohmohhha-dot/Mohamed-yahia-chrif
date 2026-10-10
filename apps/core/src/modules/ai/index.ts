/**
 * AI layer: optional and switchable. Every feature works without AI (rules and statistics); with a
 * provider configured and the switches on, AI adds summaries, understanding of free text and assistants.
 * The AI only reads, through read-only tools, and every call is limited, checked and recorded (docs/AI.md).
 */
export { aiRoutes } from './routes.js';
export { createAiLayer, type AiLayer, type AiSettings } from './gateway.js';
export { createAnthropicProvider, createScriptedProvider, type AiProvider, type AiRequest, type AiResponse } from './provider.js';
export { interpreterFor } from './interpreter.js';
export { AI_FEATURES, type AiFeatureKey } from './features.js';
