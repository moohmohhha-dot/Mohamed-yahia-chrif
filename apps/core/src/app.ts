import Fastify, { type FastifyServerOptions } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Database } from '@aruma/db';
import { AppError, isUniqueViolation } from './shared/errors.js';
import { authPlugin } from './modules/identity/index.js';
import { registerModules } from './modules/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export type AppOptions = FastifyServerOptions & {
  /** Max login/register attempts per IP per minute. */
  authRateLimitMax?: number;
};

/**
 * Set `trustProxy` only when running behind a known reverse proxy / load balancer; otherwise clients
 * could spoof X-Forwarded-For to change their IP (and bypass rate limits).
 */
export function buildApp(db: Database, { authRateLimitMax = 10, ...options }: AppOptions = {}) {
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
    if (isUniqueViolation(error)) {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (error as Error).message } });
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

  app.register(rateLimit, { global: false });
  app.register(authPlugin);
  app.register(async (scope) => registerModules(scope, { authRateLimitMax }));

  return app;
}
