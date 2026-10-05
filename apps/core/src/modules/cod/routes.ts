import type { FastifyInstance, FastifyRequest } from 'fastify';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@aruma/db';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can, requireAuth } from '../identity/index.js';
import { requireMembership } from '../merchants/index.js';
import { normalizePhone } from '../shipping/index.js';
import { clearStorePolicy, codPolicy, setCodPolicy } from './policy.js';
import { blockPhone, codSummary, liftBlock, listRemittances, recordRemittance } from './records.js';
import { assessCustomer } from './risk.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const policyBody = z.object({
  requireConfirmation: z.boolean(),
  maxCallAttempts: z.number().int().min(1).max(10),
  maxDeliveryAttempts: z.number().int().min(1).max(10),
  blockAfterRefusals: z.number().int().min(0).max(50),
  maxAmountMinor: z.number().int().positive().max(100_000_000_00).nullable(),
});
const phoneQuery = z.object({ phone: z.string().min(6).max(24), country: z.string().length(2).toUpperCase().default('DZ') });

/** Merchants: where their cash is and what couriers paid. ARUMA: COD rules, customer risk, blocks. */
export async function codRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });
  /** Money matters (cash held by couriers, remittances): owners and managers. */
  const asManager = async (req: FastifyRequest) => {
    const { merchantId } = merchantParams.parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    return merchantId;
  };

  app.get('/v1/merchants/:merchantId/cod/summary', auth, async (req) => ({ data: await codSummary(app.db, await asManager(req)) }));
  app.get('/v1/merchants/:merchantId/cod/remittances', auth, async (req) => ({ data: await listRemittances(app.db, await asManager(req)) }));
  app.post('/v1/merchants/:merchantId/cod/remittances', auth, async (req, reply) => {
    const merchantId = await asManager(req);
    const body = z
      .object({
        courierCode: z.string().max(32),
        reference: z.string().trim().min(2).max(100),
        orderIds: z.array(z.uuid()).min(1).max(500),
        courierFeesMinor: z.number().int().min(0),
        receivedMinor: z.number().int().min(0),
      })
      .parse(req.body);
    return reply.status(201).send({ data: await recordRemittance(app.db, actor(req), merchantId, body) });
  });

  // --- ARUMA -------------------------------------------------------------------------------------------

  app.get('/v1/admin/cod/policy', can('cod.policy', 'fraud.manage', 'orders.manage'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid().optional() }).parse(req.query);
    const policy = await codPolicy(app.db, storeId ?? null);
    return { data: { ...policy, maxAmountMinor: policy.maxAmountMinor === null ? null : Number(policy.maxAmountMinor) } };
  });

  app.put('/v1/admin/cod/policy', can('cod.policy'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid().optional() }).parse(req.query);
    const policy = await setCodPolicy(app.db, actor(req), storeId ?? null, policyBody.parse(req.body));
    return { data: { ...policy, maxAmountMinor: policy.maxAmountMinor === null ? null : Number(policy.maxAmountMinor) } };
  });

  app.delete('/v1/admin/cod/policy', can('cod.policy'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid() }).parse(req.query);
    await clearStorePolicy(app.db, actor(req), storeId);
    return { data: { cleared: true } };
  });

  /** A customer's COD record and risk, by phone (and optionally account). */
  app.get('/v1/admin/cod/risk', can('fraud.manage', 'orders.manage'), async (req) => {
    const q = phoneQuery.extend({ userId: z.uuid().optional() }).parse(req.query);
    const phone = normalizePhone(q.country, q.phone);
    return { data: { phone, ...(await assessCustomer(app.db, { phone, customerUserId: q.userId }, await codPolicy(app.db, null))) } };
  });

  app.get('/v1/admin/cod/blocks', can('fraud.manage'), async () => ({ data: await app.db.select().from(s.codBlocks).orderBy(desc(s.codBlocks.createdAt)).limit(200) }));

  app.post('/v1/admin/cod/blocks', can('fraud.manage'), async (req, reply) => {
    const body = phoneQuery.extend({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    return reply.status(201).send({ data: await blockPhone(app.db, actor(req), normalizePhone(body.country, body.phone), body.reason) });
  });

  app.post('/v1/admin/cod/blocks/:blockId/lift', can('fraud.manage'), async (req) => {
    const { blockId } = z.object({ blockId: z.uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    return { data: await liftBlock(app.db, actor(req), blockId, reason) };
  });
}
