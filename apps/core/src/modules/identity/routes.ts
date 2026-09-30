import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, clientInfo, requireAuth } from './plugin.js';
import { getUser, listSessions, login, register, revokeSession } from './service.js';

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(8).max(128);

const registerBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100),
  locale: z.string().max(16).optional(),
  country: z.string().length(2).toUpperCase().optional(),
});
const loginBody = z.object({ email, password: z.string().min(1).max(128) });

export async function identityRoutes(app: FastifyInstance, opts: { authRateLimitMax: number }) {
  const rateLimit = { rateLimit: { max: opts.authRateLimitMax, timeWindow: '1 minute' } };

  app.post('/v1/auth/register', { config: rateLimit }, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const result = await register(app.db, body, clientInfo(req));
    return reply.status(201).send({ data: result });
  });

  app.post('/v1/auth/login', { config: rateLimit }, async (req) => {
    const body = loginBody.parse(req.body);
    return { data: await login(app.db, body, clientInfo(req)) };
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const auth = authOf(req);
    await revokeSession(app.db, auth, auth.sessionId, actorFrom(req));
    return reply.status(204).send();
  });

  app.get('/v1/me', { preHandler: requireAuth }, async (req) => ({ data: await getUser(app.db, authOf(req).userId) }));

  app.get('/v1/me/sessions', { preHandler: requireAuth }, async (req) => ({
    data: await listSessions(app.db, authOf(req)),
  }));

  app.delete('/v1/me/sessions/:sessionId', { preHandler: requireAuth }, async (req, reply) => {
    const { sessionId } = z.object({ sessionId: z.uuid() }).parse(req.params);
    if (!(await revokeSession(app.db, authOf(req), sessionId, actorFrom(req)))) throw notFound('Session');
    return reply.status(204).send();
  });
}
