import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can } from '../identity/index.js';
import { audit } from '../platform/index.js';
import { getActiveStore } from '../stores/index.js';
import { readDocument } from './documents.js';
import { getMerchantFile } from './profile.js';
import { sendFile } from './routes.js';
import { assertNoConflictOfInterest, attachMerchantToStore, listMerchants } from './service.js';
import { decideCheck, setActivityRule, suspendMerchant, unsuspendMerchant } from './verification.js';
import { schemas } from './validation.js';

const merchantParams = z.object({ merchantId: z.uuid() });

/** Platform administration of merchants. Staff never decide about a merchant they belong to. */
export async function merchantAdminRoutes(app: FastifyInstance) {

  app.get('/v1/admin/merchants', can('merchants.read'), async (req) => ({
    data: await listMerchants(app.db, schemas.adminList.parse(req.query)),
  }));

  app.get('/v1/admin/merchants/:merchantId', can('merchants.read'), async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    // Full ID and account numbers only for verification reviewers; other staff see the last 4 digits.
    const file = await getMerchantFile(app.db, app.secrets, merchantId, authOf(req).permissions.has('verification.review'));
    await audit(app.db, actorFrom(req), { action: 'merchants.file.viewed', entityType: 'merchant', entityId: merchantId });
    return { data: file };
  });

  app.get('/v1/admin/merchants/:merchantId/documents/:documentId/file', can('verification.review'), async (req, reply) => {
    const { merchantId, documentId } = merchantParams.extend({ documentId: z.uuid() }).parse(req.params);
    const { doc, body } = await readDocument(app.db, app.storage, app.secrets, merchantId, documentId);
    await audit(app.db, actorFrom(req), {
      action: 'merchants.document.viewed',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { documentId, kind: doc.kind },
    });
    return sendFile(reply, doc, body);
  });

  app.post('/v1/admin/merchants/:merchantId/verifications/:kind', can('verification.review'), async (req) => {
    const { merchantId, kind } = merchantParams
      .extend({ kind: z.enum(['phone', 'email', 'identity', 'business', 'payout']) })
      .parse(req.params);
    await assertNoConflictOfInterest(app.db, authOf(req).userId, merchantId);
    return { data: await decideCheck(app.db, actorFrom(req), merchantId, kind, schemas.decision.parse(req.body)) };
  });

  app.post('/v1/admin/merchants/:merchantId/suspend', can('merchants.manage'), async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    await assertNoConflictOfInterest(app.db, authOf(req).userId, merchantId);
    return { data: await suspendMerchant(app.db, actorFrom(req), merchantId, reason) };
  });

  app.post('/v1/admin/merchants/:merchantId/unsuspend', can('merchants.manage'), async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    await assertNoConflictOfInterest(app.db, authOf(req).userId, merchantId);
    return { data: await unsuspendMerchant(app.db, actorFrom(req), merchantId) };
  });

  app.put('/v1/admin/merchant-activity-rules/:country/:activityCode', can('merchants.manage'), async (req) => {
    const params = z
      .object({ country: z.string().length(2).toUpperCase(), activityCode: schemas.activityCode })
      .parse(req.params);
    const body = z
      .object({ individualRequiresRegistration: z.boolean(), note: z.string().max(1000).optional() })
      .parse(req.body);
    return { data: await setActivityRule(app.db, actorFrom(req), { ...params, ...body }) };
  });

  app.put('/v1/admin/stores/:storeSlug/merchants/:merchantId', can('commission.manage'), async (req) => {
    const { storeSlug, merchantId } = merchantParams.extend({ storeSlug: z.string().max(64) }).parse(req.params);
    // null = follow the store / platform commission rules (8 % by default); a number overrides them for this merchant.
    const { commissionBps } = z.object({ commissionBps: z.number().int().min(0).max(10000).nullable() }).parse(req.body);
    await assertNoConflictOfInterest(app.db, authOf(req).userId, merchantId);
    const store = await getActiveStore(app.db, storeSlug);
    return { data: await attachMerchantToStore(app.db, actorFrom(req), { storeId: store.id, merchantId, commissionBps }) };
  });
}
