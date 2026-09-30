import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActiveStore } from './service.js';

const params = z.object({ storeSlug: z.string().min(1).max(64) });

export async function storeRoutes(app: FastifyInstance) {
  app.get('/v1/stores/:storeSlug', async (req) => {
    const { storeSlug } = params.parse(req.params);
    const store = await getActiveStore(app.db, storeSlug);
    return { data: store };
  });
}
