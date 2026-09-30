import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth, requireRole } from '../identity/index.js';
import { getActiveStore } from '../stores/index.js';
import {
  attachMerchantToStore,
  createMerchant,
  decideVerification,
  getMerchant,
  listMyMerchants,
  listStaff,
  removeStaffMember,
  requireMembership,
  setStaffMember,
  submitVerification,
} from './service.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const createBody = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes').max(64),
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(200).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  contactEmail: z.email().max(254).optional(),
  contactPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 format, e.g. +213555000000').optional(),
});

export async function merchantRoutes(app: FastifyInstance) {
  const actor = (req: Parameters<typeof actorFrom>[0]) => ({ ...actorFrom(req), userId: authOf(req).userId });

  app.post('/v1/merchants', { preHandler: requireAuth }, async (req, reply) => {
    const merchant = await createMerchant(app.db, actor(req), createBody.parse(req.body));
    return reply.status(201).send({ data: merchant });
  });

  app.get('/v1/me/merchants', { preHandler: requireAuth }, async (req) => ({
    data: await listMyMerchants(app.db, authOf(req).userId),
  }));

  app.get('/v1/merchants/:merchantId', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId);
    return { data: await getMerchant(app.db, merchantId) };
  });

  app.get('/v1/merchants/:merchantId/staff', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId);
    return { data: await listStaff(app.db, merchantId) };
  });

  app.put('/v1/merchants/:merchantId/staff', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = z.object({ email: z.email(), role: z.enum(['manager', 'staff']) }).parse(req.body);
    return { data: await setStaffMember(app.db, actor(req), merchantId, body) };
  });

  app.delete('/v1/merchants/:merchantId/staff/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const { merchantId, userId } = merchantParams.extend({ userId: z.uuid() }).parse(req.params);
    await removeStaffMember(app.db, actor(req), merchantId, userId);
    return reply.status(204).send();
  });

  app.post('/v1/merchants/:merchantId/verification', { preHandler: requireAuth }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await submitVerification(app.db, actor(req), merchantId) };
  });

  // --- Platform administration -------------------------------------------------

  app.post('/v1/admin/merchants/:merchantId/verification', { preHandler: requireRole('admin') }, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }).parse(req.body);
    return { data: await decideVerification(app.db, actorFrom(req), merchantId, body) };
  });

  app.put('/v1/admin/stores/:storeSlug/merchants/:merchantId', { preHandler: requireRole('admin') }, async (req) => {
    const { storeSlug, merchantId } = merchantParams.extend({ storeSlug: z.string().max(64) }).parse(req.params);
    const { commissionBps } = z.object({ commissionBps: z.number().int().min(0).max(10000) }).parse(req.body);
    const store = await getActiveStore(app.db, storeSlug);
    return { data: await attachMerchantToStore(app.db, actorFrom(req), { storeId: store.id, merchantId, commissionBps }) };
  });
}
