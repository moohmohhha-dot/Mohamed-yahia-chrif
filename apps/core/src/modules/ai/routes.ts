import type { FastifyInstance } from 'fastify';
import { count, gt, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@aruma/db';
import { authOf, can, requireAuth } from '../identity/index.js';
import { requireMembership } from '../merchants/index.js';
import { getActiveStore, resolveCurrency, resolveLocale, type StoreContext } from '../stores/index.js';
import { chatMessages, merchantAssistant, shoppingAssistant } from './assistant.js';
import { classifyProduct } from './classify.js';
import { compareProducts } from './compare.js';
import { AI_FEATURES, AI_MASTER_FLAG, flagOf, type AiCallingFeature } from './features.js';
import { fraudAdvice } from './fraud.js';
import { giftIdeas } from './gifts.js';
import { merchantInsights } from './insights.js';
import { recommendations } from './recommend.js';
import { reviewSummary } from './review-summary.js';

const storeParams = z.object({ storeSlug: z.string().min(1).max(64) });
const productParams = storeParams.extend({ productSlug: z.string().min(1).max(128) });
const viewQuery = z.object({ locale: z.string().max(16).optional(), currency: z.string().length(3).optional() });
const merchantParams = z.object({ merchantId: z.uuid() });
const amount = z.number().min(0).max(1e9).optional();

function viewOf(store: StoreContext, q: { locale?: string; currency?: string }) {
  const currency = resolveCurrency(store, q.currency);
  return { locale: resolveLocale(store, q.locale), currency: { code: currency.code, minorUnits: currency.minorUnits } };
}

/**
 * AI layer routes. Every feature answers without AI; AI adds to it when switched on (docs/AI.md).
 * Chat assistants are limited per minute and per person, on top of the daily budget.
 */
export async function aiRoutes(app: FastifyInstance) {
  const { db, ai } = app;

  // --- Customers ---------------------------------------------------------------------------------------

  /** Which AI extras are on in this store, so the storefront shows or hides them. */
  app.get('/v1/stores/:storeSlug/ai', async (req) => {
    const store = await getActiveStore(db, storeParams.parse(req.params).storeSlug);
    const on = async (f: AiCallingFeature) => ai.enabled(f, store.id);
    return {
      data: {
        assistant: await on('shopping_assistant'),
        comparisonSummary: await on('product_comparison'),
        reviewSummaries: await on('review_summaries'),
        giftUnderstanding: await on('gift_recommendations'),
        naturalLanguageSearch: await on('natural_language_search'),
      },
    };
  });

  app.get('/v1/stores/:storeSlug/products/:productSlug/recommendations', async (req) => {
    const p = productParams.parse(req.params);
    const store = await getActiveStore(db, p.storeSlug);
    return { data: await recommendations(db, store, p.productSlug, viewOf(store, viewQuery.parse(req.query))) };
  });

  app.get('/v1/stores/:storeSlug/compare', async (req) => {
    const q = viewQuery.extend({ products: z.string().max(600).transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)) }).parse(req.query);
    const store = await getActiveStore(db, storeParams.parse(req.params).storeSlug);
    return { data: await compareProducts(db, ai, store, q.products, viewOf(store, q), req.auth?.userId) };
  });

  app.get('/v1/stores/:storeSlug/products/:productSlug/review-summary', async (req) => {
    const p = productParams.parse(req.params);
    const store = await getActiveStore(db, p.storeSlug);
    return { data: await reviewSummary(db, ai, store, p.productSlug, resolveLocale(store, viewQuery.parse(req.query).locale), req.auth?.userId) };
  });

  app.post('/v1/stores/:storeSlug/gift-ideas', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = viewQuery
      .extend({ forWhom: z.string().max(300).optional(), gender: z.enum(['men', 'women', 'unisex']).optional(), budgetMin: amount, budgetMax: amount, likes: z.array(z.string().max(32)).max(5).optional() })
      .parse(req.body ?? {});
    const store = await getActiveStore(db, storeParams.parse(req.params).storeSlug);
    return { data: await giftIdeas(db, ai, store, { ...body, ...viewOf(store, body) }, req.auth?.userId) };
  });

  app.post('/v1/stores/:storeSlug/assistant', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = viewQuery.extend({ messages: chatMessages }).parse(req.body);
    const store = await getActiveStore(db, storeParams.parse(req.params).storeSlug);
    return { data: await shoppingAssistant(db, ai, store, viewOf(store, body), body.messages, req.auth?.userId) };
  });

  // --- Merchants ---------------------------------------------------------------------------------------

  const merchantView = z.object({ locale: z.enum(['ar', 'fr', 'en']).default('fr'), currency: z.string().length(3).default('DZD').transform((c) => c.toUpperCase()) });

  app.get('/v1/merchants/:merchantId/ai', { preHandler: requireAuth }, async (req) => {
    await requireMembership(db, merchantParams.parse(req.params).merchantId, authOf(req).userId);
    return { data: { assistant: await ai.enabled('merchant_assistant'), salesAnalysis: await ai.enabled('sales_analysis'), classification: await ai.enabled('product_classification') } };
  });

  app.get('/v1/merchants/:merchantId/insights', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const q = merchantView.extend({ days: z.coerce.number().int().min(7).max(90).default(30) }).parse(req.query);
    return { data: await merchantInsights(db, ai, authOf(req).userId, merchantId, q) };
  });

  app.post('/v1/merchants/:merchantId/assistant', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = merchantView.extend({ messages: chatMessages }).parse(req.body);
    return { data: await merchantAssistant(db, ai, authOf(req).userId, merchantId, body, body.messages) };
  });

  app.post('/v1/merchants/:merchantId/ai/classify', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = z.object({ storeSlug: z.string().min(1).max(64), name: z.string().trim().min(2).max(200), description: z.string().max(3000).optional(), locale: z.enum(['ar', 'fr', 'en']).default('fr') }).parse(req.body);
    return { data: await classifyProduct(db, ai, authOf(req).userId, merchantId, body) };
  });

  // --- ARUMA ------------------------------------------------------------------------------------------

  /** The AI layer at a glance: provider, switches, budget, usage per feature. Switches change through feature flags. */
  app.get('/v1/admin/ai', can('ai.manage'), async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
    const flags = await db.select().from(s.featureFlags).where(like(s.featureFlags.key, 'ai.%'));
    const overrides = await db
      .select({ key: s.featureFlagOverrides.flagKey, on: sql<number>`count(*) filter (where ${s.featureFlagOverrides.enabled})::int`, off: sql<number>`count(*) filter (where not ${s.featureFlagOverrides.enabled})::int` })
      .from(s.featureFlagOverrides)
      .where(like(s.featureFlagOverrides.flagKey, 'ai.%'))
      .groupBy(s.featureFlagOverrides.flagKey);
    const usage = await db
      .select({
        feature: s.aiRequests.feature,
        requests: count(),
        ok: sql<number>`count(*) filter (where ${s.aiRequests.status} = 'ok')::int`,
        failed: sql<number>`count(*) filter (where ${s.aiRequests.status} in ('error', 'timeout', 'invalid'))::int`,
        limited: sql<number>`count(*) filter (where ${s.aiRequests.status} in ('budget', 'limit'))::int`,
        tokens: sql<number>`coalesce(sum(${s.aiRequests.inputTokens} + ${s.aiRequests.outputTokens}), 0)::int`,
        avgLatencyMs: sql<number>`coalesce(avg(${s.aiRequests.latencyMs}) filter (where ${s.aiRequests.status} = 'ok'), 0)::int`,
      })
      .from(s.aiRequests)
      .where(gt(s.aiRequests.createdAt, sql`now() - make_interval(days => ${days})`))
      .groupBy(s.aiRequests.feature);
    const [today] = await db
      .select({ tokens: sql<number>`coalesce(sum(${s.aiRequests.inputTokens} + ${s.aiRequests.outputTokens}), 0)::int` })
      .from(s.aiRequests)
      .where(gt(s.aiRequests.createdAt, sql`date_trunc('day', now())`));
    const flag = (key: string) => {
      const f = flags.find((x) => x.key === key);
      const o = overrides.find((x) => x.key === key);
      return f ? { key, enabledByDefault: f.enabledByDefault, storesOn: o?.on ?? 0, storesOff: o?.off ?? 0 } : null;
    };
    return {
      data: {
        provider: ai.status(),
        master: flag(AI_MASTER_FLAG),
        tokensToday: today?.tokens ?? 0,
        features: AI_FEATURES.map((f) => ({
          ...f,
          flag: f.engine === 'ai' || f.engine === 'rules+ai' ? flag(flagOf(f.key as AiCallingFeature)) : null,
          usage: usage.find((u) => u.feature === f.key) ?? { requests: 0, ok: 0, failed: 0, limited: 0, tokens: 0, avgLatencyMs: 0 },
        })),
        days,
      },
    };
  });

  /** Fraud team: risk of a cash-on-delivery order explained (advice only; decisions stay with people). */
  app.get('/v1/admin/ai/fraud/orders/:orderId', can('fraud.manage'), async (req) => {
    const { orderId } = z.object({ orderId: z.uuid() }).parse(req.params);
    const { locale } = z.object({ locale: z.enum(['ar', 'fr', 'en']).default('fr') }).parse(req.query);
    return { data: await fraudAdvice(db, ai, authOf(req).userId, orderId, locale) };
  });
}
