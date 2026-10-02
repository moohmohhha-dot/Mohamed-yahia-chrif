import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { requireRole } from '../identity/index.js';
import { audit } from '../platform/index.js';
import { getActiveStore } from '../stores/index.js';
import { readDocument } from './documents.js';
import { getMerchantFile } from './profile.js';
import { sendFile } from './routes.js';
import { attachMerchantToStore, listMerchants } from './service.js';
import { decideCheck, setActivityRule, suspendMerchant, unsuspendMerchant } from './verification.js';
import { schemas } from './validation.js';

const merchantParams = z.object({ merchantId: z.uuid() });

/** Platform administration of merchants. Reviewing (reading files) is open to support staff; decisions need admin. */
export async function merchantAdminRoutes(app: FastifyInstance) {
  const reviewer = { preHandler: requireRole('admin', 'support') };
  const admin = { preHandler: requireRole('admin') };

  app.get('/v1/admin/merchants', reviewer, async (req) => ({
    data: await listMerchants(app.db, schemas.adminList.parse(req.query)),
  }));

  app.get('/v1/admin/merchants/:merchantId', reviewer, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const file = await getMerchantFile(app.db, app.secrets, merchantId, true);
    await audit(app.db, actorFrom(req), { action: 'merchants.file.viewed', entityType: 'merchant', entityId: merchantId });
    return { data: file };
  });

  app.get('/v1/admin/merchants/:merchantId/documents/:documentId/file', reviewer, async (req, reply) => {
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

  app.post('/v1/admin/merchants/:merchantId/verifications/:kind', admin, async (req) => {
    const { merchantId, kind } = merchantParams
      .extend({ kind: z.enum(['phone', 'email', 'identity', 'business', 'payout']) })
      .parse(req.params);
    return { data: await decideCheck(app.db, actorFrom(req), merchantId, kind, schemas.decision.parse(req.body)) };
  });

  app.post('/v1/admin/merchants/:merchantId/suspend', admin, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    return { data: await suspendMerchant(app.db, actorFrom(req), merchantId, reason) };
  });

  app.post('/v1/admin/merchants/:merchantId/unsuspend', admin, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await unsuspendMerchant(app.db, actorFrom(req), merchantId) };
  });

  app.put('/v1/admin/merchant-activity-rules/:country/:activityCode', admin, async (req) => {
    const params = z
      .object({ country: z.string().length(2).toUpperCase(), activityCode: schemas.activityCode })
      .parse(req.params);
    const body = z
      .object({ individualRequiresRegistration: z.boolean(), note: z.string().max(1000).optional() })
      .parse(req.body);
    return { data: await setActivityRule(app.db, actorFrom(req), { ...params, ...body }) };
  });

  app.put('/v1/admin/stores/:storeSlug/merchants/:merchantId', admin, async (req) => {
    const { storeSlug, merchantId } = merchantParams.extend({ storeSlug: z.string().max(64) }).parse(req.params);
    // null = follow the store / platform commission rules (8 % by default); a number overrides them for this merchant.
    const { commissionBps } = z.object({ commissionBps: z.number().int().min(0).max(10000).nullable() }).parse(req.body);
    const store = await getActiveStore(app.db, storeSlug);
    return { data: await attachMerchantToStore(app.db, actorFrom(req), { storeId: store.id, merchantId, commissionBps }) };
  });
}
