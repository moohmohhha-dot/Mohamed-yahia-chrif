import type { FastifyInstance } from 'fastify';

/**
 * Security headers on every API response. The API only returns JSON and files, never HTML, so the
 * strictest browser policy applies: nothing may run, be framed or be loaded from a response.
 * HSTS is sent only when the API is served over HTTPS (production).
 */
export function securityHeaders(app: FastifyInstance, options: { hsts: boolean }) {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox");
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-site');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (options.hsts) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // Signed-in answers carry personal data: never stored by browsers or shared caches.
    if (req.headers.authorization && !reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
