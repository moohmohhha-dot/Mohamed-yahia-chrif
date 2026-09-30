import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActiveStore, resolveCurrency, resolveLocale } from '../stores/service.js';
import { getProduct, listCategories, listProducts } from './service.js';

const storeParams = z.object({ storeSlug: z.string().min(1).max(64) });
const productParams = storeParams.extend({ productSlug: z.string().min(1).max(128) });
const contextQuery = z.object({
  locale: z.string().max(16).optional(),
  currency: z.string().length(3).optional(),
});
const listQuery = contextQuery.extend({
  category: z.string().max(96).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/v1/stores/:storeSlug/categories', async (req) => {
    const { storeSlug } = storeParams.parse(req.params);
    const query = contextQuery.parse(req.query);
    const store = await getActiveStore(app.db, storeSlug);
    return listCategories(app.db, store, resolveLocale(store, query.locale));
  });

  app.get('/v1/stores/:storeSlug/products', async (req) => {
    const { storeSlug } = storeParams.parse(req.params);
    const query = listQuery.parse(req.query);
    const store = await getActiveStore(app.db, storeSlug);
    return listProducts(app.db, store, {
      locale: resolveLocale(store, query.locale),
      currency: resolveCurrency(store, query.currency),
      categorySlug: query.category,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get('/v1/stores/:storeSlug/products/:productSlug', async (req) => {
    const { storeSlug, productSlug } = productParams.parse(req.params);
    const query = contextQuery.parse(req.query);
    const store = await getActiveStore(app.db, storeSlug);
    return getProduct(
      app.db,
      store,
      productSlug,
      resolveLocale(store, query.locale),
      resolveCurrency(store, query.currency),
    );
  });
}
