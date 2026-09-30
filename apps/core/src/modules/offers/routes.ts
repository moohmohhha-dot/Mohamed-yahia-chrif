import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth } from '../identity/index.js';
import { listMerchantOffers, upsertOffer } from './service.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const offerBody = z.object({
  variantId: z.uuid(),
  stockQuantity: z.number().int().min(0).max(1_000_000),
  status: z.enum(['active', 'archived']).default('active'),
  prices: z
    .array(z.object({ currency: z.string().length(3).toUpperCase(), amountMinor: money, compareAtMinor: money.optional() }))
    .min(1)
    .max(20),
});

export async function offerRoutes(app: FastifyInstance) {
  app.get('/v1/merchants/:merchantId/offers', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await listMerchantOffers(app.db, authOf(req).userId, merchantId) };
  });

  app.put('/v1/merchants/:merchantId/offers', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = offerBody.parse(req.body);
    return { data: await upsertOffer(app.db, { ...actorFrom(req), userId: authOf(req).userId }, merchantId, body) };
  });
}
