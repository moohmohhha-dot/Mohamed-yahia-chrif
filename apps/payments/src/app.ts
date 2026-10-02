import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { PaymentsDb } from './db/client.js';
import type { SandboxProvider } from './providers/sandbox.js';
import type { PaymentProvider } from './providers/types.js';
import {
  cancelIntent,
  collectCash,
  createIntent,
  getIntent,
  handleWebhook,
  PaymentError,
  refundIntent,
  retryIntent,
  verifyIntent,
  type Deps,
} from './service.js';

export type PaymentsAppOptions = FastifyServerOptions & {
  db: PaymentsDb;
  providers: Record<string, PaymentProvider>;
  defaultOnlineProvider: string;
  publicBaseUrl: string;
  /** client name → bearer token allowed to call the internal API */
  clients: Record<string, string>;
  /** Present only outside production: enables the /sandbox pages. */
  sandbox?: SandboxProvider;
};

const idempotencyKey = (req: FastifyRequest) => {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(key)) {
    throw new PaymentError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 characters)');
  }
  return key;
};
const minor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform((v) => BigInt(v));
const params = z.object({ id: z.uuid() });

export function buildPaymentsApp({ db, providers, defaultOnlineProvider, publicBaseUrl, clients, sandbox, ...options }: PaymentsAppOptions) {
  const app = Fastify(options);
  const deps: Deps = { db, providers, defaultOnlineProvider, publicBaseUrl };

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof PaymentError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    if (error instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues } });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (error as Error).message } });
    req.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.get('/health', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ok' };
  });

  // --- Internal API (ARUMA CORE only) ------------------------------------------------------------
  app.register(async (internal) => {
    internal.decorateRequest('client', '');
    internal.addHook('onRequest', async (req) => {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const match = Object.entries(clients).find(([, expected]) => {
        const a = Buffer.from(expected);
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
      });
      if (!match) throw new PaymentError(401, 'UNAUTHORIZED', 'Invalid service token');
      (req as unknown as { client: string }).client = match[0];
    });
    const clientOf = (req: FastifyRequest) => (req as unknown as { client: string }).client;

    internal.post('/v1/payment-intents', async (req, reply) => {
      const body = z
        .object({
          referenceType: z.string().regex(/^[a-z_]{2,32}$/),
          referenceId: z.string().min(1).max(128),
          method: z.enum(['online', 'cash_on_delivery']),
          amountMinor: minor,
          currency: z.string().length(3).toUpperCase(),
          description: z.string().max(255).optional(),
          returnUrl: z.url().optional(),
          failureUrl: z.url().optional(),
          locale: z.enum(['ar', 'fr', 'en']).optional(),
          providerOptions: z.object({ paymentMethod: z.enum(['edahabia', 'cib']).optional() }).optional(),
          metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        })
        .parse(req.body);
      return reply.status(201).send({ data: await createIntent(deps, clientOf(req), idempotencyKey(req), body) });
    });
    internal.get('/v1/payment-intents/:id', async (req) => ({ data: await getIntent(deps, clientOf(req), params.parse(req.params).id) }));
    internal.post('/v1/payment-intents/:id/retry', async (req) => ({ data: await retryIntent(deps, clientOf(req), params.parse(req.params).id) }));
    internal.post('/v1/payment-intents/:id/verify', async (req) => ({ data: await verifyIntent(deps, clientOf(req), params.parse(req.params).id) }));
    internal.post('/v1/payment-intents/:id/cancel', async (req) => {
      const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
      return { data: await cancelIntent(deps, clientOf(req), params.parse(req.params).id, reason) };
    });
    internal.post('/v1/payment-intents/:id/cash-collected', async (req) => {
      const body = z.object({ amountMinor: minor, collectedBy: z.string().min(1).max(128) }).parse(req.body);
      return { data: await collectCash(deps, clientOf(req), params.parse(req.params).id, body) };
    });
    internal.post('/v1/payment-intents/:id/refunds', async (req, reply) => {
      const body = z
        .object({
          amountMinor: minor,
          reason: z.string().min(1).max(500),
          requestedBy: z.string().min(1).max(128),
          externalReference: z.string().min(1).max(128).optional(),
          scope: z.string().max(128).optional(),
        })
        .parse(req.body);
      return reply.status(201).send({ data: await refundIntent(deps, clientOf(req), params.parse(req.params).id, idempotencyKey(req), body) });
    });
  });

  // --- Provider webhooks (public, signed by the provider; raw body needed for the signature) ------
  app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post('/webhooks/:provider', async (req) => {
      const { provider } = z.object({ provider: z.string().max(32) }).parse(req.params);
      return { data: await handleWebhook(deps, provider, (req.body as Buffer) ?? Buffer.alloc(0), req.headers) };
    });
  });

  // --- Sandbox (development only): a fake hosted payment page ---------------------------------------
  if (sandbox) {
    app.get('/sandbox/checkouts/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
      const p = sandbox.get(id);
      if (!p) return reply.status(404).send('Unknown sandbox payment');
      const amount = (Number(p.amountMinor) / 100).toFixed(2);
      return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>ARUMA sandbox payment</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto">
<h1>Sandbox payment</h1><p>Not a real payment. Amount: <b>${amount} ${p.currency}</b> — status: <b>${p.status}</b></p>
${['paid', 'failed', 'cancelled'].map((o) => `<form method="post" action="/sandbox/checkouts/${id}/${o}"><button>${o}</button></form>`).join('')}</body>`);
    });
    app.post('/sandbox/checkouts/:id/:outcome', async (req) => {
      const { id, outcome } = z.object({ id: z.string().max(64), outcome: z.enum(['paid', 'failed', 'cancelled']) }).parse(req.params);
      const amount = (req.query as { amountMinor?: string }).amountMinor;
      const webhook = sandbox.complete(id, outcome, amount ? BigInt(amount) : undefined);
      if (!webhook) throw new PaymentError(409, 'ALREADY_COMPLETED', 'This sandbox payment is already completed');
      return { data: await handleWebhook(deps, 'sandbox', webhook.body, webhook.headers) };
    });
  }

  return app;
}
