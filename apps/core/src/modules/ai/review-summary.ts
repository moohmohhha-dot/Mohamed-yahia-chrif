/**
 * Review summary of a product: the numbers always (average, count, stars distribution — published
 * reviews only); with AI switched on and at least 3 written reviews, a short summary with pros and cons,
 * labelled as written by AI. It is reused until a new review is published (or for 7 days).
 * Reviews are given to the model as data: an instruction written in a review is ignored.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type Database } from '@aruma/db';
import type { StoreContext } from '../stores/index.js';
import { answerIn, data, type AiLayer } from './gateway.js';
import { productDoc } from './recommend.js';

const MIN_REVIEWS = 3;
const summarySchema = z.object({
  summary: z.string().min(1).max(600),
  pros: z.array(z.string().min(1).max(120)).max(5),
  cons: z.array(z.string().min(1).max(120)).max(5),
});

export async function reviewSummary(db: Database, ai: AiLayer, store: StoreContext, slug: string, locale: string, userId?: string, options: { generate?: boolean } = {}) {
  const doc = await productDoc(db, store, slug);
  const published = and(eq(s.reviews.productId, doc.productId), eq(s.reviews.type, 'product'), eq(s.reviews.status, 'published'));
  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<string | null>`round(avg(${s.reviews.rating}), 2)::text`,
      last: sql<string | null>`max(${s.reviews.publishedAt})::text`,
      written: sql<number>`count(*) filter (where length(coalesce(${s.reviews.body}, '')) >= 10)::int`,
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`s${n}`, sql<number>`count(*) filter (where ${s.reviews.rating} = ${n})::int`])),
    })
    .from(s.reviews)
    .where(published);
  const st = stats as unknown as Record<string, number | string | null>;
  const result = {
    product: { id: doc.productId, slug: doc.slug },
    count: Number(st.count),
    average: st.average === null ? null : Number(st.average),
    distribution: Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, Number(st[`s${n}`])])),
    summary: null as (z.infer<typeof summarySchema> & { basedOn: number; generatedByAi: true }) | null,
  };
  if (Number(st.written) < MIN_REVIEWS || !(await ai.enabled('review_summaries', store.id))) return result;

  const key = ai.cache.key('reviews', doc.productId, locale, st.count, st.last);
  const cached = await ai.cache.get<NonNullable<typeof result.summary>>(key);
  if (cached || options.generate === false) return { ...result, summary: cached };
  const reviews = await db
    .select({ rating: s.reviews.rating, title: s.reviews.title, body: s.reviews.body })
    .from(s.reviews)
    .where(and(published, isNotNull(s.reviews.body)))
    .orderBy(desc(s.reviews.helpfulCount), desc(s.reviews.publishedAt))
    .limit(60);
  const out = await ai.json({
    feature: 'review_summaries',
    scope: { storeId: store.id, userId },
    system: `You summarise customer reviews of one product, fairly: what most buyers say, good and bad. Do not quote names or personal details. Return {"summary": 2-3 sentences, "pros": [short phrases], "cons": [short phrases]}. ${answerIn(locale)}`,
    prompt: data('reviews', reviews.map((r) => ({ rating: r.rating, title: r.title, text: (r.body ?? '').slice(0, 600) }))),
    schema: summarySchema,
    skipEnabledCheck: true,
  });
  if (!out) return result;
  const summary = { ...out, basedOn: reviews.length, generatedByAi: true as const };
  await ai.cache.set(key, 'review_summaries', summary, 24 * 7);
  return { ...result, summary };
}
