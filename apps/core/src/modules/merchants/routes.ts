import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth } from '../identity/index.js';
import { MAX_DOCUMENT_BYTES, readDocument, rolesForDocument, uploadDocument } from './documents.js';
import { getMerchantFile, setAddress, setBusinessProfile, setIdentity, setPayoutMethod, updateProfile } from './profile.js';
import {
  createMerchant,
  getMerchant,
  listMyMerchants,
  listStaff,
  removeStaffMember,
  requireMembership,
  setStaffMember,
} from './service.js';
import { confirmContactCode, getVerificationOverview, sendContactCode, submitCheck } from './verification.js';
import { schemas } from './validation.js';

const merchantParams = z.object({ merchantId: z.uuid() });

export async function merchantRoutes(app: FastifyInstance) {
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });
  const auth = { preHandler: requireAuth };
  const merchantIdOf = (req: FastifyRequest) => merchantParams.parse(req.params).merchantId;

  app.post('/v1/merchants', auth, async (req, reply) => {
    const merchant = await createMerchant(app.db, actor(req), schemas.createMerchant.parse(req.body));
    return reply.status(201).send({ data: merchant });
  });

  app.get('/v1/me/merchants', auth, async (req) => ({ data: await listMyMerchants(app.db, authOf(req).userId) }));

  app.get('/v1/merchants/:merchantId', auth, async (req) => {
    const merchantId = merchantIdOf(req);
    await requireMembership(app.db, merchantId, authOf(req).userId);
    return { data: await getMerchant(app.db, merchantId) };
  });

  app.patch('/v1/merchants/:merchantId', auth, async (req) => ({
    data: await updateProfile(app.db, actor(req), merchantIdOf(req), schemas.profile.parse(req.body)),
  }));

  // --- Merchant file: owner and managers see it, with sensitive numbers masked -------------------

  app.get('/v1/merchants/:merchantId/profile', auth, async (req) => {
    const merchantId = merchantIdOf(req);
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    return { data: await getMerchantFile(app.db, app.secrets, merchantId, false) };
  });

  app.put('/v1/merchants/:merchantId/address', auth, async (req) => ({
    data: await setAddress(app.db, actor(req), merchantIdOf(req), schemas.address.parse(req.body)),
  }));

  app.put('/v1/merchants/:merchantId/identity', auth, async (req, reply) => {
    await setIdentity(app.db, app.secrets, actor(req), merchantIdOf(req), schemas.identity.parse(req.body));
    return reply.status(204).send();
  });

  app.put('/v1/merchants/:merchantId/business', auth, async (req) => ({
    data: await setBusinessProfile(app.db, actor(req), merchantIdOf(req), schemas.business.parse(req.body)),
  }));

  app.put('/v1/merchants/:merchantId/payout-method', auth, async (req) => {
    const method = await setPayoutMethod(app.db, app.secrets, actor(req), merchantIdOf(req), schemas.payout.parse(req.body));
    const { accountNumberEncrypted: _hidden, ...visible } = method;
    return { data: visible };
  });

  // --- Documents ---------------------------------------------------------------------------------

  app.post('/v1/merchants/:merchantId/documents', auth, async (req, reply) => {
    const merchantId = merchantIdOf(req);
    const { kind } = schemas.documentQuery.parse(req.query);
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the document as multipart/form-data');
    const body = await file.toBuffer();
    const doc = await uploadDocument(app.db, app.storage, app.secrets, actor(req), merchantId, kind, {
      body,
      fileName: file.filename || null,
    });
    return reply.status(201).send({ data: doc });
  });

  app.get('/v1/merchants/:merchantId/documents/:documentId/file', auth, async (req, reply) => {
    const { merchantId, documentId } = merchantParams.extend({ documentId: z.uuid() }).parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    const { doc, body } = await readDocument(app.db, app.storage, app.secrets, merchantId, documentId);
    await requireMembership(app.db, merchantId, authOf(req).userId, rolesForDocument(doc.kind));
    return sendFile(reply, doc, body);
  });

  // --- Verification ------------------------------------------------------------------------------

  app.get('/v1/merchants/:merchantId/verification', auth, async (req) => {
    const merchantId = merchantIdOf(req);
    await requireMembership(app.db, merchantId, authOf(req).userId);
    return { data: await getVerificationOverview(app.db, merchantId) };
  });

  app.post('/v1/merchants/:merchantId/verifications/:kind/submit', auth, async (req) => {
    const { merchantId, kind } = merchantParams.extend({ kind: z.enum(['identity', 'business', 'payout']) }).parse(req.params);
    return { data: await submitCheck(app.db, actor(req), merchantId, kind) };
  });

  app.post('/v1/merchants/:merchantId/verifications/:kind/send-code', auth, async (req, reply) => {
    const { merchantId, kind } = merchantParams.extend({ kind: z.enum(['phone', 'email']) }).parse(req.params);
    await sendContactCode(app.db, app.messages, actor(req), merchantId, kind);
    return reply.status(202).send({ data: { sent: true } });
  });

  app.post('/v1/merchants/:merchantId/verifications/:kind/confirm', auth, async (req) => {
    const { merchantId, kind } = merchantParams.extend({ kind: z.enum(['phone', 'email']) }).parse(req.params);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    return { data: await confirmContactCode(app.db, actor(req), merchantId, kind, code) };
  });

  // --- Staff -------------------------------------------------------------------------------------

  app.get('/v1/merchants/:merchantId/staff', auth, async (req) => {
    const merchantId = merchantIdOf(req);
    await requireMembership(app.db, merchantId, authOf(req).userId);
    return { data: await listStaff(app.db, merchantId) };
  });

  app.put('/v1/merchants/:merchantId/staff', auth, async (req) => {
    const body = z.object({ email: z.email(), role: z.enum(['manager', 'staff']) }).parse(req.body);
    return { data: await setStaffMember(app.db, actor(req), merchantIdOf(req), body) };
  });

  app.delete('/v1/merchants/:merchantId/staff/:userId', auth, async (req, reply) => {
    const { merchantId, userId } = merchantParams.extend({ userId: z.uuid() }).parse(req.params);
    await removeStaffMember(app.db, actor(req), merchantId, userId);
    return reply.status(204).send();
  });
}

/** Sends a stored document as a download; never rendered inline by the browser. */
export function sendFile(
  reply: import('fastify').FastifyReply,
  doc: { contentType: string; id: string },
  body: Buffer,
) {
  return reply
    .header('content-type', doc.contentType)
    .header('content-disposition', `attachment; filename="${doc.id}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(body);
}
