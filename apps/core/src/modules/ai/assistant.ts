/**
 * Chat assistants. They exist only with AI switched on; switched off (or failing), the app shows its
 * normal screens: search and filters for customers, the insights page for merchants.
 *
 * - Shopping assistant (customers): finds, explains and compares products of ONE store, through
 *   read-only tools over what any visitor can see. It cannot see accounts, orders or addresses, and
 *   cannot add to a cart, order, pay or give a discount.
 * - Merchant assistant (owners and managers): answers questions about the merchant's OWN sales, stock
 *   and prices through read-only tools bound to that merchant by the server (the model cannot choose
 *   another merchant). It cannot change a price, a stock level or an order.
 * Conversations are not stored by ARUMA: the app sends the recent messages with each question.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type Database } from '@aruma/db';
import { AppError } from '../../shared/errors.js';
import { requireMembership } from '../merchants/index.js';
import { search, type ProductCard } from '../search/index.js';
import type { StoreContext } from '../stores/index.js';
import { compareProducts, productFacts } from './compare.js';
import { answerIn, type AiLayer, type AiTool } from './gateway.js';
import { giftIdeas } from './gifts.js';
import { demandForecast, pricePositions, promotionIdeas, salesAnalysis } from './insights.js';
import { productDoc, similarProducts } from './recommend.js';
import { reviewSummary } from './review-summary.js';

export const chatMessages = z
  .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
  .min(1)
  .max(20)
  .refine((m) => m[m.length - 1]!.role === 'user', { message: 'The last message must be the question' });
export type ChatMessages = z.infer<typeof chatMessages>;

export const unavailable = () => new AppError(503, 'AI_UNAVAILABLE', 'The assistant is not available right now', { fallback: 'search' });

type View = { locale: string; currency: { code: string; minorUnits: number } };
const compact = (p: ProductCard) => ({ slug: p.slug, name: p.name, brand: p.brand, price: p.priceFrom.amount, currency: p.priceFrom.currency, rating: p.rating, inStock: p.inStock, gender: p.attributes.gender ?? null, concentration: p.attributes.concentration ?? null });

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const gender = (v: unknown) => (v === 'men' || v === 'women' || v === 'unisex' ? v : undefined);

export async function shoppingAssistant(db: Database, ai: AiLayer, store: StoreContext, view: View, messages: ChatMessages, userId?: string) {
  if (!(await ai.enabled('shopping_assistant', store.id))) throw unavailable();
  const shown = new Map<string, ProductCard>();
  const show = (cards: ProductCard[]) => cards.forEach((c) => shown.size < 8 && shown.set(c.slug, c));
  const tools: AiTool[] = [
    {
      name: 'search_products',
      description: 'Search the store catalog. Use words in any language (Arabic, French, English) and optional filters. Returns up to 6 products for sale.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, priceMin: { type: 'number' }, priceMax: { type: 'number' }, gender: { type: 'string', enum: ['men', 'women', 'unisex'] }, sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'rating', 'popular', 'newest'] } } },
      effect: 'read',
      run: async (i) => {
        const sort = ['relevance', 'price_asc', 'price_desc', 'rating', 'popular', 'newest'].find((x) => x === i.sort) as 'relevance' | undefined;
        const r = await search(db, store, { q: str(i.query), priceMin: num(i.priceMin), priceMax: num(i.priceMax), gender: gender(i.gender), sort, page: 1, pageSize: 6, log: false, ...view });
        show(r.results);
        return { total: r.meta.total, products: r.results.map(compact) };
      },
    },
    {
      name: 'product_details',
      description: 'Details of one product by its slug: description, notes, sizes with prices, stock.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      effect: 'read',
      run: async (i) => {
        const doc = await productDoc(db, store, str(i.slug, 128) ?? '');
        const [facts] = await productFacts(db, store, [doc.productId], view);
        if (!facts) throw new Error('This product is not for sale');
        const [t] = await db.select().from(s.productTranslations).where(and(eq(s.productTranslations.productId, doc.productId), eq(s.productTranslations.locale, view.locale)));
        show([facts.product]);
        return { ...compact(facts.product), description: t?.description?.slice(0, 1000) ?? null, notes: facts.notes, sizes: facts.sizes.map((x) => ({ ml: x.sizeMl, price: x.price.amount, per100ml: x.per100ml?.amount ?? null, inStock: x.inStock })) };
      },
    },
    {
      name: 'compare_products',
      description: 'Compare 2 to 4 products by slug: sizes, price per 100 ml, notes, rating, and which is cheapest / best value / best rated.',
      inputSchema: { type: 'object', properties: { slugs: { type: 'array', items: { type: 'string' } } }, required: ['slugs'] },
      effect: 'read',
      run: async (i) => {
        const slugs = Array.isArray(i.slugs) ? i.slugs.map((x) => str(x, 128)).filter((x): x is string => Boolean(x)).slice(0, 4) : [];
        const r = await compareProducts(db, ai, store, slugs, view, userId, { summary: false });
        show(r.products.map((p) => p.product));
        return { highlights: r.highlights, products: r.products.map((p) => ({ ...compact(p.product), notes: p.notes, sizes: p.sizes.map((x) => ({ ml: x.sizeMl, price: x.price.amount, per100ml: x.per100ml?.amount ?? null })) })) };
      },
    },
    {
      name: 'similar_products',
      description: 'Products similar to one product (by slug).',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      effect: 'read',
      run: async (i) => {
        const cards = await similarProducts(db, store, await productDoc(db, store, str(i.slug, 128) ?? ''), view, 5);
        show(cards);
        return cards.map(compact);
      },
    },
    {
      name: 'review_summary',
      description: 'What buyers say about a product (by slug): average rating, number of reviews, stars, and the summary when there is one.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      effect: 'read',
      run: async (i) => {
        const r = await reviewSummary(db, ai, store, str(i.slug, 128) ?? '', view.locale, userId, { generate: false });
        return { count: r.count, average: r.average, distribution: r.distribution, summary: r.summary ? { text: r.summary.summary, pros: r.summary.pros, cons: r.summary.cons } : null };
      },
    },
    {
      name: 'gift_ideas',
      description: 'Gift ideas: who it is for (free text), budget and gender. Returns products in stock.',
      inputSchema: { type: 'object', properties: { forWhom: { type: 'string' }, budgetMax: { type: 'number' }, budgetMin: { type: 'number' }, gender: { type: 'string', enum: ['men', 'women', 'unisex'] } } },
      effect: 'read',
      run: async (i) => {
        const r = await giftIdeas(db, ai, store, { forWhom: str(i.forWhom, 300), budgetMax: num(i.budgetMax), budgetMin: num(i.budgetMin), gender: gender(i.gender), ...view }, userId, { useAi: false });
        show(r.products);
        return { understood: r.understood, products: r.products.map(compact) };
      },
    },
  ];
  const out = await ai.converse({
    feature: 'shopping_assistant',
    scope: { storeId: store.id, userId },
    system: [
      `You are the shopping assistant of the ${store.name} store. Help the customer choose products of this store only, using the tools; mention products by name.`,
      `Prices are in ${view.currency.code}. Be short and friendly. ${answerIn(view.locale)}`,
      'You cannot see the customer\'s account, orders or addresses. For an order, a delivery, a return or a refund, tell the customer to use "My orders" or contact support.',
    ].join('\n'),
    messages,
    tools,
  });
  if (!out || !out.text) throw unavailable();
  return { reply: out.text, products: [...shown.values()], tools: out.used.map((u) => u.name), generatedByAi: true };
}

export async function merchantAssistant(db: Database, ai: AiLayer, userId: string, merchantId: string, view: { locale: string; currency: string }, messages: ChatMessages) {
  await requireMembership(db, merchantId, userId, ['owner', 'manager']);
  if (!(await ai.enabled('merchant_assistant'))) throw unavailable();
  const days = (v: unknown) => Math.min(90, Math.max(7, Math.round(num(v) ?? 30)));
  // Every tool reads this merchant's data only: the merchant id comes from the server, not from the model.
  const tools: AiTool[] = [
    {
      name: 'sales_summary',
      description: `Sales of the merchant over the last N days (7-90) compared with the N days before: orders, revenue (minor units of ${view.currency}), units, average order, cancellations, returns, best sellers.`,
      inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
      effect: 'read',
      run: async (i) => {
        const r = await salesAnalysis(db, merchantId, { days: days(i.days), currency: view.currency, locale: view.locale });
        return { current: r.current, previous: r.previous, change: r.change, cancellationRatePct: r.cancellationRatePct, topProducts: r.topProducts };
      },
    },
    {
      name: 'stock_forecast',
      description: 'For each active offer: available stock, units sold in the last 28 days, days of stock left, quantity to reorder for 30 days, status (out, low, overstock, no_sales, ok).',
      inputSchema: { type: 'object', properties: {} },
      effect: 'read',
      run: async () => (await demandForecast(db, merchantId, view.locale)).slice(0, 50),
    },
    {
      name: 'price_positions',
      description: `For each active offer: the merchant's price and other sellers' prices for the same item in the store (minor units of ${view.currency}), and sales in the last 30 days.`,
      inputSchema: { type: 'object', properties: {} },
      effect: 'read',
      run: async () => (await pricePositions(db, merchantId, view.currency, view.locale)).slice(0, 50),
    },
    {
      name: 'slow_movers',
      description: 'Products in stock that do not sell (or have far too much stock), with promotion ideas.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'read',
      run: async () => {
        const demand = await demandForecast(db, merchantId, view.locale);
        return promotionIdeas(demand, new Map(demand.map((d) => [d.offerId, 30])), null).slice(0, 30);
      },
    },
  ];
  const out = await ai.converse({
    feature: 'merchant_assistant',
    scope: { merchantId, userId },
    system: [
      'You are the business assistant of a merchant selling perfumes on ARUMA. Answer about their own sales, stock and prices using the tools, with numbers.',
      'Amounts from the tools are in minor units (divide by 100). Give practical advice; the merchant makes every change themselves in the Merchant Center.',
      answerIn(view.locale),
    ].join('\n'),
    messages,
    tools,
  });
  if (!out || !out.text) throw unavailable();
  return { reply: out.text, tools: out.used.map((u) => u.name), generatedByAi: true };
}
