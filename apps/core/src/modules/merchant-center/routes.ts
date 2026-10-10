import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requireAuth } from '../identity/index.js';
import { getDashboard, listMerchantStores } from './service.js';

export async function merchantCenterRoutes(app: FastifyInstance) {
  app.get('/v1/merchants/:merchantId/dashboard', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(req.params);
    return { data: await getDashboard(app.db, authOf(req).userId, merchantId) };
  });

  app.get('/v1/merchants/:merchantId/stores', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(req.params);
    return { data: await listMerchantStores(app.db, authOf(req).userId, merchantId) };
  });
}
