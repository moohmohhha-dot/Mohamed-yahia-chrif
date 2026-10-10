import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, forbidden, unauthorized } from '../../shared/errors.js';
import { audit } from '../platform/index.js';
import type { Permission } from './permissions.js';
import { authenticate, type AuthContext, type ClientInfo } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request carries a valid session token, otherwise null. */
    auth: AuthContext | null;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Resolves the session on every request that sends a token; routes decide whether it is required.
 * An invalid or expired token is treated as anonymous, so public pages keep working for stale clients.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const token = bearerToken(req);
    if (token) req.auth = await authenticate(app.db, token);
  });
});

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth) throw unauthorized();
}

/**
 * ARUMA staff only: the user's roles must give at least one of these permissions, and the session must
 * have been opened with two-step verification. Refusals of signed-in people are recorded (monitoring).
 */
export function requirePermission(...permissions: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    const auth = req.auth!;
    if (!permissions.some((p) => auth.permissions.has(p))) {
      await audit(req.server.db, { userId: auth.userId, ip: req.ip ?? null }, {
        action: 'security.access_denied',
        entityType: 'route',
        entityId: `${req.method} ${req.routeOptions.url ?? req.url}`,
        metadata: { needs: permissions, staff: auth.staffRoles.length > 0 },
      });
      throw forbidden();
    }
    if (req.server.staffMfaRequired && !auth.mfa) {
      throw new AppError(403, 'MFA_REQUIRED', 'Turn on two-step verification and sign in with it to use the Admin Panel');
    }
  };
}

/** Route option shorthand: `app.get(path, can('orders.read'), handler)`. */
export const can = (...permissions: Permission[]) => ({ preHandler: requirePermission(...permissions) });

/** Returns the authenticated context; only call after `requireAuth` ran. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function clientInfo(req: FastifyRequest): ClientInfo {
  const platform = req.headers['x-client-platform'];
  const deviceId = req.headers['x-device-id'];
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    clientDeviceId: typeof deviceId === 'string' && deviceId.length <= 128 ? deviceId : null,
    platform: platform === 'ios' || platform === 'android' ? platform : 'web',
  };
}
