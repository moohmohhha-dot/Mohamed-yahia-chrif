import Fastify, { type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Database } from '@aruma/db';
import { AppError } from './shared/errors.js';
import { storeRoutes } from './modules/stores/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export function buildApp(db: Database, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.decorate('db', db);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues } });
    }
    req.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  app.get('/health', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ok' };
  });

  app.register(storeRoutes);
  app.register(catalogRoutes);

  return app;
}
