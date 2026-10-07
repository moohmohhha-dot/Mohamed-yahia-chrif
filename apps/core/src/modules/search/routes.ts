import type { FastifyInstance } from 'fastify';
import { desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can } from '../identity/index.js';
import { audit } from '../platform/index.js';
import { getActiveStore, resolveCurrency, resolveLocale } from '../stores/index.js';
import { queueAllProducts, searchStatus } from './indexer.js';
import { normalizeText } from './normalize.js';
import { clearSynonymCache, search, searchAnalytics, suggest } from './service.js';

const storeParams = z.object({ storeSlug: z.string().min(1).max(64) });
const list = z
  .string()
  .max(500)
  .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20))
  .optional();
const amount = z.coerce.number().min(0).max(1e9).optional();
const searchQuery = z.object({
  q: z.string().max(200).optional(),
  locale: z.string().max(16).optional(),
  currency: z.string().length(3).optional(),
  brand: list,
  category: list,
  merchant: list,
  priceMin: amount,
  priceMax: amount,
  ratingMin: z.coerce.number().min(1).max(5).optional(),
  inStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  gender: z.enum(['men', 'women', 'unisex']).optional(),
  concentration: z.string().max(32).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'popular']).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
  source: z.enum(['typed', 'voice']).optional(),
  understand: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** Public search for the storefronts, and ARUMA's tools (synonyms, statistics, re-indexing). */
export async function searchRoutes(app: FastifyInstance) {
  app.get('/v1/stores/:storeSlug/search', async (req) => {
    const { storeSlug } = storeParams.parse(req.params);
    const q = searchQuery.parse(req.query);
    const store = await getActiveStore(app.db, storeSlug);
    const currency = resolveCurrency(store, q.currency);
    return {
      data: await search(app.db, store, {
        ...q,
        brands: q.brand,
        categories: q.category,
        merchants: q.merchant,
        locale: resolveLocale(store, q.locale),
        currency: { code: currency.code, minorUnits: currency.minorUnits },
      }, await app.queryInterpreter(store.id)),
    };
  });

  /** Autocomplete, while typing: completions, products, brands, categories, popular searches. */
  app.get('/v1/stores/:storeSlug/search/suggest', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const { storeSlug } = storeParams.parse(req.params);
    const q = z.object({ q: z.string().max(100).default(''), locale: z.string().max(16).optional() }).parse(req.query);
    const store = await getActiveStore(app.db, storeSlug);
    return { data: await suggest(app.db, store, q.q, resolveLocale(store, q.locale)) };
  });

  // --- ARUMA ------------------------------------------------------------------------------------------

  const storeFilter = z.object({ storeId: z.uuid().optional() });
  app.get('/v1/admin/search/status', can('search.manage', 'analytics.read'), async () => ({ data: await searchStatus(app.db) }));
  app.get('/v1/admin/search/analytics', can('search.manage', 'analytics.read'), async (req) => {
    const q = storeFilter.extend({ days: z.coerce.number().int().min(1).max(180).default(30) }).parse(req.query);
    return { data: await searchAnalytics(app.db, q.storeId, q.days) };
  });
  /** Re-index every product (or one store's): needed only after a change of the search rules. */
  app.post('/v1/admin/search/reindex', can('search.manage'), async (req) => {
    const { storeId } = storeFilter.parse(req.body ?? {});
    const queued = await queueAllProducts(app.db, storeId);
    await audit(app.db, actorFrom(req), { action: 'search.reindex.requested', entityType: 'store', entityId: storeId ?? 'all', metadata: { queued } });
    return { data: { queued } };
  });

  app.get('/v1/admin/search/synonyms', can('search.manage'), async (req) => {
    const { storeId } = storeFilter.parse(req.query);
    return {
      data: await app.db
        .select()
        .from(s.searchSynonyms)
        .where(storeId ? or(isNull(s.searchSynonyms.storeId), eq(s.searchSynonyms.storeId, storeId)) : undefined)
        .orderBy(desc(s.searchSynonyms.createdAt)),
    };
  });
  /** A group of words that mean the same thing (any language): عطر, parfum, perfume. */
  app.post('/v1/admin/search/synonyms', can('search.manage'), async (req, reply) => {
    const body = storeFilter
      .extend({ terms: z.array(z.string().trim().min(1).max(48)).min(2).max(20) })
      .refine((b) => b.terms.every((t) => normalizeText(t) && !normalizeText(t).includes(' ')), { message: 'One word per synonym' })
      .parse(req.body);
    const [row] = await app.db.insert(s.searchSynonyms).values({ storeId: body.storeId ?? null, terms: body.terms, createdBy: authOf(req).userId }).returning();
    await audit(app.db, actorFrom(req), { action: 'search.synonyms.added', entityType: 'search_synonyms', entityId: row!.id, metadata: { terms: body.terms, storeId: body.storeId ?? null } });
    clearSynonymCache();
    return reply.status(201).send({ data: row });
  });
  app.delete('/v1/admin/search/synonyms/:id', can('search.manage'), async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [row] = await app.db.delete(s.searchSynonyms).where(eq(s.searchSynonyms.id, id)).returning();
    if (!row) throw notFound('Synonyms');
    await audit(app.db, actorFrom(req), { action: 'search.synonyms.removed', entityType: 'search_synonyms', entityId: id, metadata: { terms: row.terms } });
    clearSynonymCache();
    return reply.status(204).send();
  });
}
