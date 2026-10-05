import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth, requireRole } from '../identity/index.js';
import {
  acceptDecision,
  addFile,
  appealDispute,
  assertDisputeAccess,
  CATEGORIES,
  decideAppeal,
  decideDispute,
  describeDispute,
  escalateDispute,
  listDisputes,
  MAX_FILE_BYTES,
  openDispute,
  postMessage,
  readFile,
  sendDisputeRefund,
  withdrawDispute,
  type DisputeActor,
} from './service.js';

const statuses = ['open', 'under_review', 'decided', 'appealed', 'resolved', 'withdrawn'] as const;
const kinds = ['customer_merchant', 'merchant_customer', 'merchant_aruma'] as const;
const outcomes = ['claimant', 'respondent', 'partial'] as const;
const remedies = ['none', 'refund', 'store_credit', 'merchant_compensation'] as const;
const listQuery = z.object({
  status: z.enum(statuses).optional(),
  kind: z.enum(kinds).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
const amount = z.number().int().min(0).max(100_000_000_00);
const openBody = z.object({
  category: z.string().max(48),
  orderId: z.uuid().optional(),
  returnId: z.uuid().optional(),
  references: z.record(z.string().regex(/^[a-z_]{2,24}$/), z.string().trim().min(1).max(64)).refine((r) => Object.keys(r).length <= 10).optional(),
  subject: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(5000),
  requestedRemedy: z.enum(remedies).default('none'),
  requestedAmountMinor: amount.optional(),
});
const reason = z.object({ reason: z.string().trim().min(10).max(2000) });
const messageBody = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().optional() });
const fileQuery = z.object({ kind: z.enum(['evidence', 'document']).default('evidence'), messageId: z.uuid().optional(), internal: z.enum(['true', 'false']).optional() });

/** Customers and merchants open and argue disputes; ARUMA decides, hears the appeal and executes the resolution. */
export async function disputeRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const staff = { preHandler: requireRole('admin', 'support') };
  const admin = { preHandler: requireRole('admin') };
  const deps = () => ({ payments: app.payments, couriers: app.couriers, secrets: app.secrets });
  const files = () => ({ storage: app.storage, secrets: app.secrets });
  const as = (req: FastifyRequest, type: DisputeActor['type'], merchantId?: string) => ({ ...actorFrom(req), userId: authOf(req).userId, type, merchantId });

  const upload = async (req: FastifyRequest, reply: FastifyReply, actor: DisputeActor, disputeId: string) => {
    const q = fileQuery.parse(req.query);
    // Who may add files is checked before reading the upload.
    await assertDisputeAccess(app.db, actor, disputeId);
    const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the file as multipart/form-data');
    const body = await file.toBuffer();
    const row = await addFile(app.db, files(), actor, disputeId, { kind: q.kind, messageId: q.messageId, internal: q.internal === 'true', body, fileName: file.filename || null });
    return reply.status(201).send({ data: row });
  };
  const download = async (reply: FastifyReply, actor: DisputeActor, disputeId: string, fileId: string) => {
    const { row, body } = await readFile(app.db, files(), actor, disputeId, fileId);
    return reply
      .header('content-type', row.contentType)
      .header('content-disposition', `inline; filename="${(row.fileName ?? 'file').replace(/[^\w.-]/g, '_')}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  };

  /** The steps both parties share, mounted for customers and for merchants. */
  const partyRoutes = (prefix: string, actorOf: (req: FastifyRequest) => DisputeActor) => {
    const one = (req: FastifyRequest) => z.object({ disputeId: z.uuid() }).parse(req.params).disputeId;
    const show = async (req: FastifyRequest) => ({ data: await describeDispute(app.db, actorOf(req), one(req)) });

    app.get(prefix, auth, async (req) => ({ data: await listDisputes(app.db, actorOf(req), listQuery.parse(req.query)) }));
    app.get(`${prefix}/:disputeId`, auth, show);
    app.post(`${prefix}/:disputeId/messages`, auth, async (req, reply) => {
      const { body } = messageBody.parse(req.body);
      await postMessage(app.db, actorOf(req), one(req), { body });
      return reply.status(201).send(await show(req));
    });
    app.post(`${prefix}/:disputeId/files`, auth, (req, reply) => upload(req, reply, actorOf(req), one(req)));
    app.get(`${prefix}/:disputeId/files/:fileId`, auth, async (req, reply) =>
      download(reply, actorOf(req), one(req), z.object({ fileId: z.uuid() }).parse(req.params).fileId),
    );
    /** Ask ARUMA to decide now. */
    app.post(`${prefix}/:disputeId/escalate`, auth, async (req) => {
      await escalateDispute(app.db, actorOf(req), one(req), reason.parse(req.body).reason);
      return show(req);
    });
    app.post(`${prefix}/:disputeId/withdraw`, auth, async (req) => {
      const { note } = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
      await withdrawDispute(app.db, actorOf(req), one(req), note);
      return show(req);
    });
    app.post(`${prefix}/:disputeId/appeal`, auth, async (req) => {
      await appealDispute(app.db, actorOf(req), one(req), reason.parse(req.body).reason);
      return show(req);
    });
    app.post(`${prefix}/:disputeId/accept`, auth, async (req) => {
      await acceptDecision(app.db, deps(), actorOf(req), one(req));
      return show(req);
    });
  };

  app.get('/v1/disputes/categories', async () => ({ data: CATEGORIES }));

  // --- Customer ---------------------------------------------------------------------------------------------

  app.post('/v1/me/disputes', auth, async (req, reply) => {
    const body = openBody.parse(req.body);
    const d = await openDispute(app.db, as(req, 'customer'), { ...body, kind: 'customer_merchant' });
    return reply.status(201).send({ data: await describeDispute(app.db, as(req, 'customer'), d.id) });
  });
  partyRoutes('/v1/me/disputes', (req) => as(req, 'customer'));

  // --- Merchant (owners and managers) -----------------------------------------------------------------------

  const merchantOf = (req: FastifyRequest) => as(req, 'merchant', z.object({ merchantId: z.uuid() }).parse(req.params).merchantId);
  /** Against a customer (about an order) or against ARUMA (commission, fees, payouts…). */
  app.post('/v1/merchants/:merchantId/disputes', auth, async (req, reply) => {
    const body = openBody.extend({ kind: z.enum(['merchant_customer', 'merchant_aruma']) }).parse(req.body);
    const actor = merchantOf(req);
    const d = await openDispute(app.db, actor, body);
    return reply.status(201).send({ data: await describeDispute(app.db, actor, d.id) });
  });
  partyRoutes('/v1/merchants/:merchantId/disputes', merchantOf);

  // --- ARUMA ------------------------------------------------------------------------------------------------

  const adminOne = (req: FastifyRequest) => z.object({ disputeId: z.uuid() }).parse(req.params).disputeId;
  const adminShow = async (req: FastifyRequest) => ({ data: await describeDispute(app.db, as(req, 'platform'), adminOne(req)) });

  app.get('/v1/admin/disputes', staff, async (req) => ({ data: await listDisputes(app.db, as(req, 'platform'), listQuery.parse(req.query)) }));
  app.get('/v1/admin/disputes/:disputeId', staff, adminShow);
  /** A message to the parties, or an internal note (internal: true) that only ARUMA sees. */
  app.post('/v1/admin/disputes/:disputeId/messages', staff, async (req, reply) => {
    await postMessage(app.db, as(req, 'platform'), adminOne(req), messageBody.parse(req.body));
    return reply.status(201).send(await adminShow(req));
  });
  app.post('/v1/admin/disputes/:disputeId/files', staff, (req, reply) => upload(req, reply, as(req, 'platform'), adminOne(req)));
  app.get('/v1/admin/disputes/:disputeId/files/:fileId', staff, async (req, reply) =>
    download(reply, as(req, 'platform'), adminOne(req), z.object({ fileId: z.uuid() }).parse(req.params).fileId),
  );
  app.post('/v1/admin/disputes/:disputeId/review', staff, async (req) => {
    await escalateDispute(app.db, as(req, 'platform'), adminOne(req), reason.parse(req.body).reason);
    return adminShow(req);
  });

  const decision = z.object({ outcome: z.enum(outcomes), remedy: z.enum(remedies), amountMinor: amount.optional(), text: z.string().trim().min(20).max(5000) });
  /** The decision (administrators). Support staff prepare the file with internal notes. */
  app.post('/v1/admin/disputes/:disputeId/decision', admin, async (req) => {
    await decideDispute(app.db, deps(), as(req, 'platform'), adminOne(req), decision.parse(req.body));
    return adminShow(req);
  });
  /** The appeal, decided by another administrator: upheld, overturned or modified. */
  app.post('/v1/admin/disputes/:disputeId/appeal-decision', admin, async (req) => {
    const body = decision.partial({ outcome: true, remedy: true }).extend({ result: z.enum(['upheld', 'overturned', 'modified']) }).parse(req.body);
    await decideAppeal(app.db, deps(), as(req, 'platform'), adminOne(req), body);
    return adminShow(req);
  });
  /** Sends (online) or records (cash on delivery: transfer reference) a refund that is still waiting. */
  app.post('/v1/admin/disputes/:disputeId/refund', admin, async (req) => {
    const body = z.object({ externalReference: z.string().trim().min(3).max(128).optional() }).parse(req.body ?? {});
    await sendDisputeRefund(app.db, deps(), as(req, 'platform'), adminOne(req), body);
    return adminShow(req);
  });
}
