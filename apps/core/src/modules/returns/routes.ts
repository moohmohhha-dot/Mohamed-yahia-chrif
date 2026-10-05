import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can, requireAuth } from '../identity/index.js';
import { schema as s } from '@aruma/db';
import { eq } from 'drizzle-orm';
import { assertNoConflictOfInterest } from '../merchants/index.js';
import { clearReturnPolicy, returnPolicy, setReturnPolicy } from './policy.js';
import {
  addEvidence,
  arrangePickup,
  assertReturnAccess,
  cancelReturn,
  createReturn,
  decideReturn,
  escalateReturn,
  getReturn,
  inspectReturn,
  listReturns,
  markReceived,
  MAX_EVIDENCE_BYTES,
  readEvidence,
  respondToReturn,
  sendRefund,
  submitReturn,
  updatePickup,
  type ReturnActor,
} from './service.js';

const statuses = ['draft', 'requested', 'under_review', 'approved', 'rejected', 'cancelled', 'in_transit', 'received', 'inspection_failed', 'refund_pending', 'completed'] as const;
const reasons = ['damaged', 'defective', 'wrong_item', 'not_as_described', 'missing_parts', 'counterfeit_suspected', 'changed_mind', 'other'] as const;
const resolutions = ['refund', 'replacement', 'store_credit'] as const;
const methods = ['pickup', 'drop_off', 'keep_item'] as const;
const listQuery = z.object({ status: z.enum(statuses).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });
const returnParams = z.object({ returnId: z.uuid() });
const merchantReturn = z.object({ merchantId: z.uuid(), returnId: z.uuid() });
const note = z.string().trim().max(1000).optional();
const amount = z.number().int().min(0).max(100_000_000_00);

/** Customers ask; merchants answer, collect and inspect; ARUMA arbitrates and sends refunds that need a transfer. */
export async function returnRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const deps = () => ({ payments: app.payments, couriers: app.couriers, secrets: app.secrets });
  const files = () => ({ storage: app.storage, secrets: app.secrets });
  const as = (req: FastifyRequest, type: ReturnActor['type'], merchantId?: string): ReturnActor => ({ ...actorFrom(req), userId: authOf(req).userId, type, merchantId });
  const readFile = async (req: FastifyRequest, actor: ReturnActor, returnId: string) => {
    // Who may add files is checked before reading the upload.
    await assertReturnAccess(app.db, actor, returnId);
    const file = await req.file({ limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the file as multipart/form-data');
    return { body: await file.toBuffer(), fileName: file.filename || null };
  };
  const sendEvidence = (reply: FastifyReply, row: { contentType: string; fileName: string | null }, body: Buffer) =>
    reply
      .header('content-type', row.contentType)
      .header('content-disposition', `inline; filename="${(row.fileName ?? 'evidence').replace(/[^\w.-]/g, '_')}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);

  // --- Customer -----------------------------------------------------------------------------------------

  app.post('/v1/me/orders/:orderId/returns', auth, async (req, reply) => {
    const { orderId } = z.object({ orderId: z.uuid() }).parse(req.params);
    const body = z
      .object({
        lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1).max(100) })).min(1).max(50),
        reason: z.enum(reasons),
        description: z.string().trim().min(10).max(2000),
        resolution: z.enum(resolutions),
      })
      .parse(req.body);
    const ret = await createReturn(app.db, as(req, 'customer'), orderId, body);
    return reply.status(201).send({ data: await getReturn(app.db, as(req, 'customer'), ret.id) });
  });

  app.get('/v1/me/returns', auth, async (req) => ({ data: await listReturns(app.db, as(req, 'customer'), listQuery.parse(req.query)) }));

  app.get('/v1/me/returns/:returnId', auth, async (req) => ({ data: await getReturn(app.db, as(req, 'customer'), returnParams.parse(req.params).returnId) }));

  app.post('/v1/me/returns/:returnId/evidence', auth, async (req, reply) => {
    const { returnId } = returnParams.parse(req.params);
    return reply.status(201).send({ data: await addEvidence(app.db, files(), as(req, 'customer'), returnId, await readFile(req, as(req, 'customer'), returnId)) });
  });

  app.get('/v1/me/returns/:returnId/evidence/:evidenceId', auth, async (req, reply) => {
    const { returnId, evidenceId } = returnParams.extend({ evidenceId: z.uuid() }).parse(req.params);
    const { row, body } = await readEvidence(app.db, files(), as(req, 'customer'), returnId, evidenceId);
    return sendEvidence(reply, row, body);
  });

  app.post('/v1/me/returns/:returnId/submit', auth, async (req) => {
    const { returnId } = returnParams.parse(req.params);
    await submitReturn(app.db, as(req, 'customer'), returnId);
    return { data: await getReturn(app.db, as(req, 'customer'), returnId) };
  });

  app.post('/v1/me/returns/:returnId/cancel', auth, async (req) => {
    const { returnId } = returnParams.parse(req.params);
    await cancelReturn(app.db, as(req, 'customer'), returnId, z.object({ note }).parse(req.body ?? {}).note);
    return { data: await getReturn(app.db, as(req, 'customer'), returnId) };
  });

  /** Ask ARUMA to review a rejection or a failed inspection. */
  app.post('/v1/me/returns/:returnId/escalate', auth, async (req) => {
    const { returnId } = returnParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(10).max(1000) }).parse(req.body);
    await escalateReturn(app.db, as(req, 'customer'), returnId, reason);
    return { data: await getReturn(app.db, as(req, 'customer'), returnId) };
  });

  // --- Merchant -----------------------------------------------------------------------------------------

  const merchantActor = (req: FastifyRequest) => {
    const { merchantId, returnId } = merchantReturn.parse(req.params);
    return { actor: as(req, 'merchant', merchantId), returnId };
  };

  app.get('/v1/merchants/:merchantId/returns', auth, async (req) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(req.params);
    return { data: await listReturns(app.db, as(req, 'merchant', merchantId), listQuery.parse(req.query)) };
  });

  app.get('/v1/merchants/:merchantId/returns/:returnId', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  app.get('/v1/merchants/:merchantId/returns/:returnId/evidence/:evidenceId', auth, async (req, reply) => {
    const { actor, returnId } = merchantActor(req);
    const { evidenceId } = z.object({ evidenceId: z.uuid() }).parse(req.params);
    const { row, body } = await readEvidence(app.db, files(), actor, returnId, evidenceId);
    return sendEvidence(reply, row, body);
  });

  app.post('/v1/merchants/:merchantId/returns/:returnId/evidence', auth, async (req, reply) => {
    const { actor, returnId } = merchantActor(req);
    return reply.status(201).send({ data: await addEvidence(app.db, files(), actor, returnId, await readFile(req, actor, returnId)) });
  });

  /** Accept (with how the item comes back) or refuse with a reason. Owners and managers. */
  app.post('/v1/merchants/:merchantId/returns/:returnId/respond', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    const body = z.object({ decision: z.enum(['approve', 'reject']), resolution: z.enum(resolutions).optional(), returnMethod: z.enum(methods).optional(), note }).parse(req.body);
    await respondToReturn(app.db, deps(), actor, returnId, body);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  app.post('/v1/merchants/:merchantId/returns/:returnId/pickup', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    const body = z.object({ courierCode: z.string().max(32).optional(), trackingNumber: z.string().trim().min(3).max(64).optional() }).parse(req.body ?? {});
    await arrangePickup(app.db, actor, returnId, body);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  app.post('/v1/merchants/:merchantId/returns/:returnId/pickup/status', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    const body = z
      .object({
        status: z.enum(['in_transit', 'out_for_delivery', 'delivery_failed', 'delivered', 'cancelled']),
        trackingNumber: z.string().trim().min(3).max(64).optional(),
        note,
        location: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    await updatePickup(app.db, actor, returnId, body);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  app.post('/v1/merchants/:merchantId/returns/:returnId/receive', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    await markReceived(app.db, actor, returnId, z.object({ note }).parse(req.body ?? {}).note);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  /** Inspection: passed resolves the return (a lower amount = partial refund, with a reason); failed needs a reason. */
  app.post('/v1/merchants/:merchantId/returns/:returnId/inspection', auth, async (req) => {
    const { actor, returnId } = merchantActor(req);
    const body = z
      .object({
        result: z.enum(['passed', 'failed']),
        lines: z.array(z.object({ returnLineId: z.uuid(), restock: z.boolean() })).min(1),
        amountMinor: amount.optional(),
        partialReason: z.string().trim().min(5).max(500).optional(),
        note,
      })
      .parse(req.body);
    await inspectReturn(app.db, deps(), actor, returnId, body);
    return { data: await getReturn(app.db, actor, returnId) };
  });

  // --- ARUMA ----------------------------------------------------------------------------------------------

  app.get('/v1/admin/returns', can('returns.read'), async (req) => ({ data: await listReturns(app.db, as(req, 'platform'), listQuery.parse(req.query)) }));

  app.get('/v1/admin/returns/:returnId', can('returns.read'), async (req) => ({ data: await getReturn(app.db, as(req, 'platform'), returnParams.parse(req.params).returnId) }));

  app.get('/v1/admin/returns/:returnId/evidence/:evidenceId', can('returns.read'), async (req, reply) => {
    const { returnId, evidenceId } = returnParams.extend({ evidenceId: z.uuid() }).parse(req.params);
    const { row, body } = await readEvidence(app.db, files(), as(req, 'platform'), returnId, evidenceId);
    return sendEvidence(reply, row, body);
  });

  /** ARUMA's final decision on a disputed return (support staff review; the decision is the administrators'). */
  app.post('/v1/admin/returns/:returnId/decision', can('returns.decide'), async (req) => {
    const { returnId } = returnParams.parse(req.params);
    const [ret] = await app.db.select({ merchantId: s.returnRequests.merchantId }).from(s.returnRequests).where(eq(s.returnRequests.id, returnId));
    if (ret) await assertNoConflictOfInterest(app.db, authOf(req).userId, ret.merchantId);
    const body = z
      .object({
        decision: z.enum(['approve', 'reject']),
        resolution: z.enum(resolutions).optional(),
        returnMethod: z.enum(methods).optional(),
        amountMinor: amount.optional(),
        partialReason: z.string().trim().min(5).max(500).optional(),
        note: z.string().trim().min(5).max(1000),
      })
      .parse(req.body);
    await decideReturn(app.db, deps(), as(req, 'platform'), returnId, body);
    return { data: await getReturn(app.db, as(req, 'platform'), returnId) };
  });

  /** Sends (online) or records (cash on delivery: transfer reference) the refund of a resolved return. */
  app.post('/v1/admin/returns/:returnId/refund', can('refunds.execute'), async (req) => {
    const { returnId } = returnParams.parse(req.params);
    const body = z.object({ externalReference: z.string().trim().min(3).max(128).optional() }).parse(req.body ?? {});
    await sendRefund(app.db, deps(), as(req, 'platform'), returnId, body);
    return { data: await getReturn(app.db, as(req, 'platform'), returnId) };
  });

  const policyBody = z.object({
    windowDays: z.number().int().min(1).max(90),
    merchantResponseHours: z.number().int().min(1).max(720),
    escalationDays: z.number().int().min(1).max(60),
    allowChangeOfMind: z.boolean(),
    changeOfMindFeeMinor: amount,
  });
  const show = (p: Awaited<ReturnType<typeof returnPolicy>>) => ({ ...p, changeOfMindFeeMinor: Number(p.changeOfMindFeeMinor) });

  app.get('/v1/admin/returns-policy', can('returns.read'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid().optional() }).parse(req.query);
    return { data: show(await returnPolicy(app.db, storeId ?? null)) };
  });
  app.put('/v1/admin/returns-policy', can('returns.policy'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid().optional() }).parse(req.query);
    return { data: show(await setReturnPolicy(app.db, { ...actorFrom(req), userId: authOf(req).userId }, storeId ?? null, policyBody.parse(req.body))) };
  });
  app.delete('/v1/admin/returns-policy', can('returns.policy'), async (req) => {
    const { storeId } = z.object({ storeId: z.uuid() }).parse(req.query);
    await clearReturnPolicy(app.db, { ...actorFrom(req), userId: authOf(req).userId }, storeId);
    return { data: { cleared: true } };
  });
}
