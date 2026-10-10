import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can, requireAuth } from '../identity/index.js';
import { schema as s } from '@aruma/db';
import { eq } from 'drizzle-orm';
import { assertNoConflictOfInterest, requireMembership } from '../merchants/index.js';
import {
  addReviewMedia,
  adminReview,
  adminReviews,
  createReview,
  editReview,
  MAX_MEDIA_BYTES,
  merchantReviews,
  moderateReview,
  myReviews,
  publicReviews,
  replyToReview,
  reportReview,
  voteHelpful,
  withdrawReview,
  type ReviewActor,
} from './service.js';

const rating = z.number().int().min(1).max(5);
const content = {
  rating,
  title: z.string().trim().max(120).nullish(),
  body: z.string().trim().min(10).max(3000).nullish(),
  locale: z.enum(['ar', 'fr', 'en']).optional(),
};
const listQuery = z.object({
  sort: z.enum(['recent', 'helpful', 'rating_high', 'rating_low']).default('recent'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const reviewParams = z.object({ reviewId: z.uuid() });
const reportBody = z.object({ reason: z.enum(['fake', 'spam', 'offensive', 'personal_info', 'off_topic', 'conflict_of_interest', 'other']), note: z.string().trim().max(500).optional() });

/** Public ratings; customers write, vote and report; merchants read, reply and report; ARUMA moderates. */
export async function reviewRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const staff = can('reviews.moderate');
  const actor = (req: FastifyRequest, type: ReviewActor['type']) => ({ ...actorFrom(req), userId: authOf(req).userId, type });

  // --- Public -------------------------------------------------------------------------------------------

  app.get('/v1/products/:productId/reviews', async (req) => {
    const { productId } = z.object({ productId: z.uuid() }).parse(req.params);
    return { data: await publicReviews(app.db, { productId }, listQuery.parse(req.query), req.auth?.userId) };
  });

  /** Public: what buyers say about a seller (named sellerId so it is not mistaken for a merchant's private route). */
  app.get('/v1/sellers/:sellerId/reviews', async (req) => {
    const { sellerId } = z.object({ sellerId: z.uuid() }).parse(req.params);
    return { data: await publicReviews(app.db, { merchantId: sellerId }, listQuery.parse(req.query), req.auth?.userId) };
  });

  // --- Customer -----------------------------------------------------------------------------------------

  /** Reviews written, and the products and sellers that can still be reviewed. */
  app.get('/v1/me/reviews', auth, async (req) => ({ data: await myReviews(app.db, authOf(req).userId) }));

  app.post('/v1/me/reviews', auth, async (req, reply) => {
    const body = z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('product'), orderLineId: z.uuid(), ...content }),
        z.object({ type: z.literal('merchant'), orderId: z.uuid(), ...content }),
      ])
      .parse(req.body);
    return reply.status(201).send({ data: await createReview(app.db, actor(req, 'customer'), body) });
  });

  app.patch('/v1/me/reviews/:reviewId', auth, async (req) => {
    const { reviewId } = reviewParams.parse(req.params);
    return { data: await editReview(app.db, actor(req, 'customer'), reviewId, z.object(content).parse(req.body)) };
  });

  app.delete('/v1/me/reviews/:reviewId', auth, async (req) => {
    const { reviewId } = reviewParams.parse(req.params);
    return { data: await withdrawReview(app.db, actor(req, 'customer'), reviewId) };
  });

  /** Photos (only when the store has switched them on; always moderated). */
  app.post('/v1/me/reviews/:reviewId/media', auth, async (req, reply) => {
    const { reviewId } = reviewParams.parse(req.params);
    const file = await req.file({ limits: { fileSize: MAX_MEDIA_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the photo as multipart/form-data');
    return reply.status(201).send({ data: await addReviewMedia(app.db, { storage: app.storage, secrets: app.secrets }, actor(req, 'customer'), reviewId, await file.toBuffer()) });
  });

  app.post('/v1/reviews/:reviewId/helpful', auth, async (req) => ({ data: await voteHelpful(app.db, authOf(req).userId, reviewParams.parse(req.params).reviewId, true) }));
  app.delete('/v1/reviews/:reviewId/helpful', auth, async (req) => ({ data: await voteHelpful(app.db, authOf(req).userId, reviewParams.parse(req.params).reviewId, false) }));

  app.post('/v1/reviews/:reviewId/report', auth, async (req) => {
    const { reviewId } = reviewParams.parse(req.params);
    return { data: await reportReview(app.db, actor(req, 'customer'), reviewId, reportBody.parse(req.body)) };
  });

  // --- Merchant -----------------------------------------------------------------------------------------

  const merchantReview = z.object({ merchantId: z.uuid(), reviewId: z.uuid() });

  app.get('/v1/merchants/:merchantId/reviews', auth, async (req) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(req.params);
    const q = listQuery.extend({ type: z.enum(['product', 'merchant']).optional() }).parse(req.query);
    return { data: await merchantReviews(app.db, authOf(req).userId, merchantId, q) };
  });

  /** A public answer under the review (owners and managers). */
  app.post('/v1/merchants/:merchantId/reviews/:reviewId/reply', auth, async (req) => {
    const { merchantId, reviewId } = merchantReview.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(2).max(1000) }).parse(req.body);
    return { data: await replyToReview(app.db, { ...actor(req, 'merchant'), merchantId }, reviewId, text) };
  });

  /** Merchants report reviews they think are fake or abusive; only ARUMA decides. */
  app.post('/v1/merchants/:merchantId/reviews/:reviewId/report', auth, async (req) => {
    const { merchantId, reviewId } = merchantReview.parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    return { data: await reportReview(app.db, actor(req, 'merchant'), reviewId, { ...reportBody.parse(req.body), merchantId }) };
  });

  // --- ARUMA (moderation) ----------------------------------------------------------------------------------

  app.get('/v1/admin/reviews', staff, async (req) => {
    const q = z
      .object({
        status: z.enum(['pending', 'published', 'rejected', 'hidden', 'withdrawn']).optional(),
        reported: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return { data: await adminReviews(app.db, q) };
  });

  app.get('/v1/admin/reviews/:reviewId', staff, async (req) => ({ data: await adminReview(app.db, reviewParams.parse(req.params).reviewId) }));

  app.post('/v1/admin/reviews/:reviewId/moderate', staff, async (req) => {
    const { reviewId } = reviewParams.parse(req.params);
    const body = z.object({ action: z.enum(['publish', 'reject', 'hide', 'restore']), note: z.string().trim().min(3).max(1000) }).parse(req.body);
    const [review] = await app.db.select({ merchantId: s.reviews.merchantId }).from(s.reviews).where(eq(s.reviews.id, reviewId));
    if (review) await assertNoConflictOfInterest(app.db, authOf(req).userId, review.merchantId);
    return { data: await moderateReview(app.db, actor(req, 'platform'), reviewId, body) };
  });
}
