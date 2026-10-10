import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, clientInfo, requireAuth } from './plugin.js';
import { disableMfa, enableMfa, mfaStatus, regenerateRecoveryCodes, startMfaSetup } from './mfa.js';
import { changePassword, completeMfaLogin, getUser, listSessions, login, register, revokeSession } from './service.js';

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(10).max(128);
const code = z.string().trim().min(6).max(16);

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

  /** Second step when two-step verification is on: the challenge from /v1/auth/login and a code. */
  app.post('/v1/auth/mfa', { config: rateLimit }, async (req) => {
    const body = z.object({ challengeToken: z.string().min(10).max(200), code }).parse(req.body);
    return { data: await completeMfaLogin(app.db, app.secrets, body, clientInfo(req)) };
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

  // --- Password and two-step verification -------------------------------------------------------------

  const self = { preHandler: requireAuth, config: rateLimit };
  const who = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });

  app.post('/v1/me/password', self, async (req) => {
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).parse(req.body);
    return { data: await changePassword(app.db, authOf(req), body, actorFrom(req)) };
  });

  app.get('/v1/me/mfa', { preHandler: requireAuth }, async (req) => ({ data: { ...(await mfaStatus(app.db, authOf(req).userId)), sessionVerified: authOf(req).mfa } }));
  /** A new secret to add to the authenticator app (shown once, as a key and an otpauth:// link). */
  app.post('/v1/me/mfa/setup', self, async (req) => ({ data: await startMfaSetup(app.db, app.secrets, authOf(req).userId) }));
  /** Confirms the first code; returns 10 single-use recovery codes, shown only now. */
  app.post('/v1/me/mfa/enable', self, async (req) => {
    const body = z.object({ code }).parse(req.body);
    return { data: await enableMfa(app.db, app.secrets, who(req), authOf(req).sessionId, body.code) };
  });
  app.post('/v1/me/mfa/recovery-codes', self, async (req) => ({ data: await regenerateRecoveryCodes(app.db, app.secrets, who(req), z.object({ code }).parse(req.body).code) }));
  app.post('/v1/me/mfa/disable', self, async (req, reply) => {
    const body = z.object({ password: z.string().min(1).max(128), code }).parse(req.body);
    await disableMfa(app.db, app.secrets, who(req), body, { isStaff: authOf(req).staffRoles.length > 0, staffMfaRequired: app.staffMfaRequired });
    return reply.status(204).send();
  });
}
