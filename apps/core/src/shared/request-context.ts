import type { FastifyRequest } from 'fastify';

/** Who is acting, from where. Passed to audit logging. */
export type Actor = { userId: string | null; ip: string | null };

export const actorFrom = (req: FastifyRequest): Actor => ({ userId: req.auth?.userId ?? null, ip: req.ip ?? null });
