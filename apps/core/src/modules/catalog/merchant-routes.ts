import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth } from '../identity/index.js';
import {
  addVariant,
  createProduct,
  listMerchantProducts,
  searchSellableCatalog,
  updateProduct,
  updateVariant,
} from './merchant-products.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const productParams = merchantParams.extend({ productId: z.uuid() });
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes').max(128);
const attributes = z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 10_000, 'too large');
const translation = z.object({
  locale: z.string().min(2).max(16),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
});
const variant = z.object({
  sku: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).transform((v) => v.toUpperCase()),
  options: attributes.default({}),
});

const createBody = z.object({
  storeSlug: z.string().max(64),
  slug,
  brandSlug: z.string().max(96).optional(),
  categorySlugs: z.array(z.string().max(96)).max(10).default([]),
  attributes: attributes.default({}),
  translations: z.array(translation).min(1).max(20),
  variants: z.array(variant).min(1).max(50),
});
const updateBody = z
  .object({
    status: z.enum(['draft', 'active', 'archived']),
    attributes,
    categorySlugs: z.array(z.string().max(96)).max(10),
    translations: z.array(translation).min(1).max(20),
  })
  .partial();

export async function merchantCatalogRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });

  app.get('/v1/merchants/:merchantId/products', auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await listMerchantProducts(app.db, authOf(req).userId, merchantId) };
  });

  app.get('/v1/merchants/:merchantId/catalog', auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
    return { data: await searchSellableCatalog(app.db, authOf(req).userId, merchantId, q || undefined) };
  });

  app.post('/v1/merchants/:merchantId/products', auth, async (req, reply) => {
    const { merchantId } = merchantParams.parse(req.params);
    const product = await createProduct(app.db, actor(req), merchantId, createBody.parse(req.body));
    return reply.status(201).send({ data: product });
  });

  app.patch('/v1/merchants/:merchantId/products/:productId', auth, async (req) => {
    const { merchantId, productId } = productParams.parse(req.params);
    return { data: await updateProduct(app.db, actor(req), merchantId, productId, updateBody.parse(req.body)) };
  });

  app.post('/v1/merchants/:merchantId/products/:productId/variants', auth, async (req, reply) => {
    const { merchantId, productId } = productParams.parse(req.params);
    const created = await addVariant(app.db, actor(req), merchantId, productId, variant.parse(req.body));
    return reply.status(201).send({ data: created });
  });

  app.patch('/v1/merchants/:merchantId/products/:productId/variants/:variantId', auth, async (req) => {
    const { merchantId, productId, variantId } = productParams.extend({ variantId: z.uuid() }).parse(req.params);
    const body = z.object({ options: attributes, isActive: z.boolean() }).partial().parse(req.body);
    return { data: await updateVariant(app.db, actor(req), merchantId, productId, variantId, body) };
  });
}
