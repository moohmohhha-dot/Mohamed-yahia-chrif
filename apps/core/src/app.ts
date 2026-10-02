import Fastify, { type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Database } from '@aruma/db';
import { AppError, isUniqueViolation } from './shared/errors.js';
import { authPlugin } from './modules/identity/index.js';
import { registerModules } from './modules/index.js';
import type { PaymentsClient } from './modules/payments/index.js';
import type { FileStorage, MessageSender, SecretBox } from './modules/platform/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    /** Encrypts sensitive values and files at rest. */
    secrets: SecretBox;
    /** Stores uploaded files (merchant documents…). */
    storage: FileStorage;
    /** Sends SMS and emails. */
    messages: MessageSender;
    /** The independent Payment Service. */
    payments: PaymentsClient;
    /** Verifies events sent by the Payment Service. */
    paymentEventsSecret: string;
    /** Where customers return after paying online. */
    storefrontUrl: string;
  }
}

/** External services ARUMA CORE depends on, injected so tests and deployments can swap them. */
export type CoreServices = {
  secrets: SecretBox;
  storage: FileStorage;
  messages: MessageSender;
  payments: PaymentsClient;
  paymentEventsSecret: string;
  storefrontUrl: string;
};

export type AppOptions = FastifyServerOptions & {
  /** Max login/register attempts per IP per minute. */
  authRateLimitMax?: number;
};

/**
 * Set `trustProxy` only when running behind a known reverse proxy / load balancer; otherwise clients
 * could spoof X-Forwarded-For to change their IP (and bypass rate limits).
 */
export function buildApp(
  db: Database,
  services: CoreServices,
  { authRateLimitMax = 10, ...options }: AppOptions = {},
) {
  const app = Fastify(options);
  // Amounts are stored as bigint (minor units); JSON has no bigint, and every amount fits in a safe integer.
  app.setReplySerializer((payload) => JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)));
  app.decorate('db', db);
  app.decorate('secrets', services.secrets);
  app.decorate('storage', services.storage);
  app.decorate('messages', services.messages);
  app.decorate('payments', services.payments);
  app.decorate('paymentEventsSecret', services.paymentEventsSecret);
  app.decorate('storefrontUrl', services.storefrontUrl);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      const body = { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
      return reply.status(error.statusCode).send({ error: body });
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
    if (status === 413 || (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'The file is too large' } });
    }
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
  app.register(multipart);
  app.register(authPlugin);
  app.register(async (scope) => registerModules(scope, { authRateLimitMax }));

  return app;
}
