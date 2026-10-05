/**
 * Reviews: writing (verified purchases only), editing, withdrawing, helpful votes, reports, merchant
 * replies, moderation, and the public ratings.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database, type ReviewFlag } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest, forbidden, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, detectContentType, evaluateFlags, recordEvent, type FileStorage, type SecretBox } from '../platform/index.js';
import { reviewFlags, textFlags } from './checks.js';

type Review = typeof s.reviews.$inferSelect;
type Status = Review['status'];
type EventType = (typeof s.reviewEventType.enumValues)[number];
export type ReviewActor = Actor & { type: 'customer' | 'merchant' | 'platform' | 'system' };

/** Reviews are written within this many days of delivery. */
export const REVIEW_WINDOW_DAYS = 90;
/** At most this many reviews per customer per day. */
const DAILY_REVIEWS = 10;
/** At most this many helpful votes per user per hour. */
const HOURLY_VOTES = 60;
/** Reports from this many different buyers hold a published review for moderation. */
export const REPORTS_TO_HOLD = 3;

async function event(db: Executor, reviewId: string, actor: ReviewActor, type: EventType, note?: string | null, data: Record<string, unknown> = {}) {
  await db.insert(s.reviewEvents).values({ reviewId, type, actorType: actor.type, actorUserId: actor.userId, note: note?.trim() || null, data });
}

const isMember = async (db: Executor, merchantId: string, userId: string) =>
  Boolean((await db.select().from(s.merchantMembers).where(and(eq(s.merchantMembers.merchantId, merchantId), eq(s.merchantMembers.userId, userId))))[0]);

/** The delivered order a review is based on: the customer's own, delivered, not a free replacement, recent enough. */
async function purchase(db: Executor, customerUserId: string, orderId: string) {
  const [order] = await db.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.customerUserId, customerUserId)));
  if (!order) throw notFound('Order');
  const [delivered] = await db
    .select({ at: s.orderStatusHistory.createdAt })
    .from(s.orderStatusHistory)
    .where(and(eq(s.orderStatusHistory.orderId, order.id), eq(s.orderStatusHistory.toStatus, 'delivered')))
    .orderBy(desc(s.orderStatusHistory.createdAt))
    .limit(1);
  if (!delivered) throw new AppError(409, 'NOT_DELIVERED', 'Reviews are written after delivery');
  if (order.totalMinor === 0n) throw new AppError(409, 'NOT_ELIGIBLE', 'Review the original purchase, not its free replacement');
  if (Date.now() > delivered.at.getTime() + REVIEW_WINDOW_DAYS * 24 * 3600_000) {
    throw new AppError(409, 'REVIEW_WINDOW_CLOSED', `Reviews are written within ${REVIEW_WINDOW_DAYS} days of delivery`);
  }
  return order;
}

export type ReviewInput = { rating: number; title?: string | null; body?: string | null; locale?: string };

export async function createReview(
  db: Database,
  actor: ReviewActor & { userId: string },
  input: ReviewInput & ({ type: 'product'; orderLineId: string } | { type: 'merchant'; orderId: string }),
) {
  // Anti-spam: a daily limit per customer.
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.reviews)
    .where(and(eq(s.reviews.customerUserId, actor.userId), gte(s.reviews.createdAt, new Date(Date.now() - 24 * 3600_000))));
  if (today!.n >= DAILY_REVIEWS) throw new AppError(429, 'REVIEW_RATE_LIMIT', `At most ${DAILY_REVIEWS} reviews a day`);

  let order: typeof s.orders.$inferSelect;
  let productId: string | null = null;
  let orderLineId: string | null = null;
  if (input.type === 'product') {
    const [line] = await db
      .select({ line: s.orderLines, productId: s.productVariants.productId })
      .from(s.orderLines)
      .innerJoin(s.productVariants, eq(s.productVariants.id, s.orderLines.variantId))
      .where(eq(s.orderLines.id, input.orderLineId));
    if (!line) throw notFound('Order line');
    order = await purchase(db, actor.userId, line.line.orderId);
    productId = line.productId;
    orderLineId = line.line.id;
  } else {
    order = await purchase(db, actor.userId, input.orderId);
  }
  // Conflict of interest: the merchant's own team cannot review it or its products.
  if (await isMember(db, order.merchantId, actor.userId)) throw forbidden('You cannot review your own shop or products');

  const existing = (
    await db
      .select({ id: s.reviews.id })
      .from(s.reviews)
      .where(
        and(
          eq(s.reviews.customerUserId, actor.userId),
          eq(s.reviews.type, input.type),
          input.type === 'product' ? eq(s.reviews.productId, productId!) : eq(s.reviews.merchantId, order.merchantId),
        ),
      )
  )[0];
  if (existing) throw new AppError(409, 'ALREADY_REVIEWED', 'You already reviewed it: edit your review instead', { reviewId: existing.id });

  const text = [input.title, input.body].filter(Boolean).join('\n');
  const flags = await reviewFlags(db, { type: input.type, productId, merchantId: order.merchantId, text, buyerPhone: order.shippingAddress.phone });
  const status: Status = flags.length ? 'pending' : 'published';
  return db.transaction(async (tx) => {
    const [review] = await tx
      .insert(s.reviews)
      .values({
        type: input.type,
        storeId: order.storeId,
        productId,
        merchantId: order.merchantId,
        customerUserId: actor.userId,
        orderId: order.id,
        orderLineId,
        rating: input.rating,
        title: input.title?.trim() || null,
        body: input.body?.trim() || null,
        locale: input.locale ?? null,
        status,
        flags,
        publishedAt: status === 'published' ? new Date() : null,
      })
      .returning();
    await event(tx, review!.id, actor, 'created', null, { rating: input.rating });
    if (flags.length) await event(tx, review!.id, { ...actor, type: 'system', userId: null }, 'held', null, { flags });
    await recordEvent(tx, { type: 'reviews.review.created', aggregateType: 'review', aggregateId: review!.id, payload: { type: input.type, status, merchantId: order.merchantId } });
    return review!;
  });
}

async function own(db: Executor, userId: string, reviewId: string, lock = false) {
  const query = db.select().from(s.reviews).where(and(eq(s.reviews.id, reviewId), eq(s.reviews.customerUserId, userId)));
  const [review] = lock ? await query.for('update') : await query;
  if (!review) throw notFound('Review');
  return review;
}

/** The author edits: checks run again; the previous version is kept in the history. */
export async function editReview(db: Database, actor: ReviewActor & { userId: string }, reviewId: string, input: ReviewInput) {
  return db.transaction(async (tx) => {
    const review = await own(tx, actor.userId, reviewId, true);
    if (review.status === 'hidden' || review.status === 'withdrawn') throw new AppError(409, 'NOT_EDITABLE', `This review is ${review.status}`);
    const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, review.orderId));
    const text = [input.title, input.body].filter(Boolean).join('\n');
    const flags = await reviewFlags(tx, { reviewId: review.id, type: review.type, productId: review.productId, merchantId: review.merchantId, text, buyerPhone: order!.shippingAddress.phone });
    // A rejected review goes back to a moderator; otherwise flags hold it, a clean edit stays published.
    const status: Status = review.status === 'rejected' || flags.length ? 'pending' : review.status;
    const [updated] = await tx
      .update(s.reviews)
      .set({
        rating: input.rating,
        title: input.title?.trim() || null,
        body: input.body?.trim() || null,
        status,
        flags,
        editedAt: new Date(),
        ...(status === 'published' && !review.publishedAt ? { publishedAt: new Date() } : {}),
      })
      .where(eq(s.reviews.id, review.id))
      .returning();
    await event(tx, review.id, actor, 'edited', null, { before: { rating: review.rating, title: review.title, body: review.body } });
    if (status === 'pending') await event(tx, review.id, { ...actor, type: 'system', userId: null }, 'held', null, { flags });
    return updated!;
  });
}

export async function withdrawReview(db: Database, actor: ReviewActor & { userId: string }, reviewId: string) {
  return db.transaction(async (tx) => {
    const review = await own(tx, actor.userId, reviewId, true);
    if (review.status === 'withdrawn') return review;
    const [updated] = await tx.update(s.reviews).set({ status: 'withdrawn' }).where(eq(s.reviews.id, review.id)).returning();
    await event(tx, review.id, actor, 'withdrawn');
    return updated!;
  });
}

async function published(db: Executor, reviewId: string) {
  const [review] = await db.select().from(s.reviews).where(eq(s.reviews.id, reviewId));
  if (!review || review.status !== 'published') throw notFound('Review');
  return review;
}

/** "Helpful": one vote per user, not on one's own review, not by the reviewed merchant's team. */
export async function voteHelpful(db: Database, userId: string, reviewId: string, helpful: boolean) {
  const review = await published(db, reviewId);
  if (review.customerUserId === userId) throw forbidden('You cannot vote on your own review');
  if (await isMember(db, review.merchantId, userId)) throw forbidden('The reviewed merchant cannot vote');
  if (helpful) {
    const [hour] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.reviewVotes)
      .where(and(eq(s.reviewVotes.userId, userId), gte(s.reviewVotes.createdAt, new Date(Date.now() - 3600_000))));
    if (hour!.n >= HOURLY_VOTES) throw new AppError(429, 'VOTE_RATE_LIMIT', 'Too many votes, try again later');
  }
  return db.transaction(async (tx) => {
    if (helpful) await tx.insert(s.reviewVotes).values({ reviewId, userId }).onConflictDoNothing();
    else await tx.delete(s.reviewVotes).where(and(eq(s.reviewVotes.reviewId, reviewId), eq(s.reviewVotes.userId, userId)));
    const [updated] = await tx
      .update(s.reviews)
      .set({ helpfulCount: sql`(select count(*) from ${s.reviewVotes} where ${s.reviewVotes.reviewId} = ${reviewId})` })
      .where(eq(s.reviews.id, reviewId))
      .returning({ helpfulCount: s.reviews.helpfulCount });
    return { helpfulCount: updated!.helpfulCount, voted: helpful };
  });
}

export type ReportReason = (typeof s.reviewReportReason.enumValues)[number];

/**
 * A report (one per user per review). Reports from different buyers (customers with a delivered order)
 * hold the review for moderation once there are enough; other reports wait for a moderator.
 */
export async function reportReview(db: Database, actor: ReviewActor & { userId: string }, reviewId: string, input: { reason: ReportReason; note?: string; merchantId?: string }) {
  return db.transaction(async (tx) => {
    const [review] = await tx.select().from(s.reviews).where(eq(s.reviews.id, reviewId)).for('update');
    if (!review || !['published', 'pending'].includes(review.status)) throw notFound('Review');
    if (review.customerUserId === actor.userId) throw forbidden('You cannot report your own review');
    if (input.merchantId && input.merchantId !== review.merchantId) throw notFound('Review');
    const [report] = await tx
      .insert(s.reviewReports)
      .values({ reviewId, reporterUserId: actor.userId, merchantId: input.merchantId ?? null, reason: input.reason, note: input.note?.trim() || null })
      .onConflictDoNothing()
      .returning();
    if (!report) throw new AppError(409, 'ALREADY_REPORTED', 'You already reported this review');
    const [buyers] = await tx
      .select({ n: sql<number>`count(distinct ${s.reviewReports.reporterUserId})::int` })
      .from(s.reviewReports)
      .where(
        and(
          eq(s.reviewReports.reviewId, reviewId),
          eq(s.reviewReports.status, 'open'),
          sql`${s.reviewReports.merchantId} is null`,
          sql`exists (select 1 from ${s.orders} o join ${s.orderStatusHistory} h on h.order_id = o.id where o.customer_user_id = ${s.reviewReports.reporterUserId} and h.to_status = 'delivered')`,
        ),
      );
    const hold = review.status === 'published' && buyers!.n >= REPORTS_TO_HOLD;
    await tx
      .update(s.reviews)
      .set({
        reportCount: sql`${s.reviews.reportCount} + 1`,
        ...(hold ? { status: 'pending' as const, flags: [...review.flags, { code: 'reported', detail: String(buyers!.n) }] } : {}),
      })
      .where(eq(s.reviews.id, reviewId));
    await event(tx, reviewId, actor, 'reported', input.note, { reason: input.reason, byMerchant: Boolean(input.merchantId) });
    if (hold) await event(tx, reviewId, { ...actor, type: 'system', userId: null }, 'held', null, { reports: buyers!.n });
    return { reported: true, held: hold };
  });
}

/** The merchant answers publicly (owners and managers); links and contact details are not allowed. */
export async function replyToReview(db: Database, actor: ReviewActor & { userId: string; merchantId: string }, reviewId: string, text: string) {
  await requireMembership(db, actor.merchantId, actor.userId, ['owner', 'manager']);
  const review = await published(db, reviewId);
  if (review.merchantId !== actor.merchantId) throw notFound('Review');
  const flags = textFlags(text);
  if (flags.length) throw new AppError(400, 'REPLY_NOT_ALLOWED', 'Replies cannot contain links, contact details or blocked words', { flags });
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(s.reviews)
      .set({ merchantReply: text.trim(), merchantReplyBy: actor.userId, merchantRepliedAt: new Date() })
      .where(eq(s.reviews.id, reviewId))
      .returning();
    await event(tx, reviewId, actor, 'replied', null, { previous: review.merchantReply });
    return updated!;
  });
}

// --- Moderation (ARUMA) -------------------------------------------------------------------------------

export type ModerationAction = 'publish' | 'reject' | 'hide' | 'restore';
const MODERATION: Record<ModerationAction, { from: Status[]; to: Status; event: EventType; reports?: 'upheld' | 'dismissed' }> = {
  publish: { from: ['pending', 'rejected'], to: 'published', event: 'published', reports: 'dismissed' },
  reject: { from: ['pending'], to: 'rejected', event: 'rejected', reports: 'upheld' },
  hide: { from: ['published', 'pending'], to: 'hidden', event: 'hidden', reports: 'upheld' },
  restore: { from: ['hidden'], to: 'published', event: 'restored', reports: 'dismissed' },
};

export async function moderateReview(db: Database, actor: ReviewActor & { userId: string }, reviewId: string, input: { action: ModerationAction; note: string }) {
  const rule = MODERATION[input.action];
  return db.transaction(async (tx) => {
    const [review] = await tx.select().from(s.reviews).where(eq(s.reviews.id, reviewId)).for('update');
    if (!review) throw notFound('Review');
    if (!rule.from.includes(review.status)) throw new AppError(409, 'INVALID_REVIEW_STATUS', `A ${review.status} review cannot be ${input.action}ed`, { status: review.status });
    const [updated] = await tx
      .update(s.reviews)
      .set({
        status: rule.to,
        moderationNote: input.note,
        moderatedBy: actor.userId,
        moderatedAt: new Date(),
        ...(rule.to === 'published' ? { publishedAt: review.publishedAt ?? new Date() } : {}),
      })
      .where(eq(s.reviews.id, reviewId))
      .returning();
    if (rule.reports) {
      await tx
        .update(s.reviewReports)
        .set({ status: rule.reports, resolvedBy: actor.userId, resolvedAt: new Date() })
        .where(and(eq(s.reviewReports.reviewId, reviewId), eq(s.reviewReports.status, 'open')));
    }
    // Approved photos are published with the review.
    if (rule.to === 'published') await tx.update(s.reviewMedia).set({ approved: true }).where(eq(s.reviewMedia.reviewId, reviewId));
    await event(tx, reviewId, actor, rule.event, input.note, { from: review.status });
    await audit(tx, actor, { action: `reviews.review.${input.action}`, entityType: 'review', entityId: reviewId, metadata: { note: input.note } });
    return updated!;
  });
}

// --- Media (prepared; behind the store's `reviews.media` feature) ---------------------------------------

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA = 5;

export async function addReviewMedia(db: Database, deps: { storage: FileStorage; secrets: SecretBox }, actor: ReviewActor & { userId: string }, reviewId: string, body: Buffer) {
  const review = await own(db, actor.userId, reviewId);
  const flags = await evaluateFlags(db, review.storeId);
  if (!flags['reviews.media']) throw new AppError(409, 'MEDIA_NOT_AVAILABLE', 'Photos in reviews are not available yet');
  const contentType = detectContentType(body);
  if (!contentType?.startsWith('image/')) throw badRequest('UNSUPPORTED_FILE_TYPE', 'Upload a JPEG, PNG or WebP photo');
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(s.reviewMedia).where(eq(s.reviewMedia.reviewId, reviewId));
  if (count!.n >= MAX_MEDIA) throw new AppError(409, 'TOO_MANY_FILES', `At most ${MAX_MEDIA} photos per review`);
  const id = randomUUID();
  const storageKey = `reviews/${reviewId}/${id}`;
  await deps.storage.put(storageKey, deps.secrets.sealBytes(body));
  return db.transaction(async (tx) => {
    await tx.insert(s.reviewMedia).values({ id, reviewId, kind: 'image', storageKey, contentType, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    // Photos are always looked at by a moderator before they are shown.
    if (review.status === 'published' || review.status === 'rejected') {
      await tx.update(s.reviews).set({ status: 'pending', flags: [...review.flags, { code: 'media' }] }).where(eq(s.reviews.id, reviewId));
      await event(tx, reviewId, { ...actor, type: 'system', userId: null }, 'held', null, { flags: [{ code: 'media' }] });
    }
    await event(tx, reviewId, actor, 'media_added', null, { mediaId: id });
    return { id, contentType, approved: false };
  });
}

// --- Reading ----------------------------------------------------------------------------------------------

/** "Yacine Meziane" → "Yacine M." (customers are never fully named publicly). */
const shortName = (name: string | null) => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.`;
};

export async function ratingSummaries(db: Executor, target: { productIds?: string[]; merchantId?: string }) {
  const where = target.productIds
    ? and(inArray(s.reviews.productId, target.productIds.length ? target.productIds : ['00000000-0000-0000-0000-000000000000']), eq(s.reviews.status, 'published'))
    : and(eq(s.reviews.merchantId, target.merchantId!), eq(s.reviews.type, 'merchant'), eq(s.reviews.status, 'published'));
  const rows = await db
    .select({ key: target.productIds ? s.reviews.productId : s.reviews.merchantId, rating: s.reviews.rating, n: sql<number>`count(*)::int` })
    .from(s.reviews)
    .where(where)
    .groupBy(target.productIds ? s.reviews.productId : s.reviews.merchantId, s.reviews.rating);
  const out = new Map<string, { count: number; average: number | null; distribution: Record<1 | 2 | 3 | 4 | 5, number> }>();
  for (const r of rows) {
    const cur = out.get(r.key!) ?? { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    cur.distribution[r.rating as 1] += r.n;
    cur.count += r.n;
    out.set(r.key!, cur);
  }
  for (const v of out.values()) {
    const total = Object.entries(v.distribution).reduce((sum, [k, n]) => sum + Number(k) * n, 0);
    v.average = v.count ? Math.round((total / v.count) * 10) / 10 : null;
  }
  return out;
}

export const emptySummary = () => ({ count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });

export type ListQuery = { sort: 'recent' | 'helpful' | 'rating_high' | 'rating_low'; rating?: number; page: number; pageSize: number };

/** Published reviews of a product, or of a merchant (as a seller). */
export async function publicReviews(db: Database, target: { productId: string } | { merchantId: string }, q: ListQuery, viewerUserId?: string | null) {
  const where: SQL[] = [eq(s.reviews.status, 'published')];
  if ('productId' in target) where.push(eq(s.reviews.productId, target.productId));
  else where.push(eq(s.reviews.merchantId, target.merchantId), eq(s.reviews.type, 'merchant'));
  if (q.rating) where.push(eq(s.reviews.rating, q.rating));
  const order =
    q.sort === 'helpful' ? [desc(s.reviews.helpfulCount), desc(s.reviews.publishedAt)]
    : q.sort === 'rating_high' ? [desc(s.reviews.rating), desc(s.reviews.publishedAt)]
    : q.sort === 'rating_low' ? [asc(s.reviews.rating), desc(s.reviews.publishedAt)]
    : [desc(s.reviews.publishedAt)];
  const rows = await db
    .select({ review: s.reviews, author: s.users.displayName, merchantName: s.merchants.name })
    .from(s.reviews)
    .innerJoin(s.users, eq(s.users.id, s.reviews.customerUserId))
    .innerJoin(s.merchants, eq(s.merchants.id, s.reviews.merchantId))
    .where(and(...where))
    .orderBy(...order)
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const ids = rows.map((r) => r.review.id);
  const voted = viewerUserId && ids.length ? await db.select({ id: s.reviewVotes.reviewId }).from(s.reviewVotes).where(and(eq(s.reviewVotes.userId, viewerUserId), inArray(s.reviewVotes.reviewId, ids))) : [];
  const media = ids.length ? await db.select({ id: s.reviewMedia.id, reviewId: s.reviewMedia.reviewId, kind: s.reviewMedia.kind }).from(s.reviewMedia).where(and(inArray(s.reviewMedia.reviewId, ids), eq(s.reviewMedia.approved, true))) : [];
  const summary = 'productId' in target ? (await ratingSummaries(db, { productIds: [target.productId] })).get(target.productId) : (await ratingSummaries(db, { merchantId: target.merchantId })).get(target.merchantId);
  return {
    summary: summary ?? emptySummary(),
    reviews: rows.map(({ review: r, author, merchantName }) => ({
      id: r.id,
      type: r.type,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: shortName(author),
      verifiedPurchase: r.verifiedPurchase,
      seller: merchantName,
      helpfulCount: r.helpfulCount,
      votedHelpful: voted.some((v) => v.id === r.id),
      media: media.filter((m) => m.reviewId === r.id).map(({ id, kind }) => ({ id, kind })),
      merchantReply: r.merchantReply ? { text: r.merchantReply, at: r.merchantRepliedAt } : null,
      publishedAt: r.publishedAt,
      edited: Boolean(r.editedAt),
    })),
  };
}

/** The customer's reviews (all statuses, with the moderator's reason) and what they can still review. */
export async function myReviews(db: Database, userId: string) {
  const rows = await db.select().from(s.reviews).where(eq(s.reviews.customerUserId, userId)).orderBy(desc(s.reviews.createdAt));
  const reviewable = await db.execute<{ order_id: string; order_line_id: string; product_id: string; merchant_id: string; number: string }>(sql`
    select o.id as order_id, l.id as order_line_id, v.product_id, o.merchant_id, o.number
    from ${s.orders} o
    join ${s.orderLines} l on l.order_id = o.id
    join ${s.productVariants} v on v.id = l.variant_id
    where o.customer_user_id = ${userId} and o.total_minor > 0
      and exists (select 1 from ${s.orderStatusHistory} h where h.order_id = o.id and h.to_status = 'delivered' and h.created_at > now() - make_interval(days => ${REVIEW_WINDOW_DAYS}))
    order by o.placed_at desc`);
  const reviewedProducts = new Set(rows.filter((r) => r.type === 'product').map((r) => r.productId));
  const reviewedMerchants = new Set(rows.filter((r) => r.type === 'merchant').map((r) => r.merchantId));
  const products = new Map<string, { orderLineId: string; productId: string; orderNumber: string }>();
  const merchants = new Map<string, { orderId: string; merchantId: string; orderNumber: string }>();
  for (const r of reviewable.rows) {
    if (!reviewedProducts.has(r.product_id) && !products.has(r.product_id)) products.set(r.product_id, { orderLineId: r.order_line_id, productId: r.product_id, orderNumber: r.number });
    if (!reviewedMerchants.has(r.merchant_id) && !merchants.has(r.merchant_id)) merchants.set(r.merchant_id, { orderId: r.order_id, merchantId: r.merchant_id, orderNumber: r.number });
  }
  return {
    reviews: rows.map((r) => ({ id: r.id, type: r.type, productId: r.productId, merchantId: r.merchantId, rating: r.rating, title: r.title, body: r.body, status: r.status, moderationNote: r.status === 'rejected' ? r.moderationNote : null, helpfulCount: r.helpfulCount, createdAt: r.createdAt })),
    toReview: { products: [...products.values()], merchants: [...merchants.values()] },
  };
}

/** The merchant's published reviews (its products and itself) with its ratings. */
export async function merchantReviews(db: Database, userId: string, merchantId: string, q: ListQuery & { type?: 'product' | 'merchant' }) {
  await requireMembership(db, merchantId, userId);
  const where: SQL[] = [eq(s.reviews.merchantId, merchantId), eq(s.reviews.status, 'published')];
  if (q.type) where.push(eq(s.reviews.type, q.type));
  if (q.rating) where.push(eq(s.reviews.rating, q.rating));
  const rows = await db
    .select({ review: s.reviews, author: s.users.displayName, productName: sql<string | null>`(select t.name from ${s.productTranslations} t where t.product_id = ${s.reviews.productId} order by t.locale limit 1)` })
    .from(s.reviews)
    .innerJoin(s.users, eq(s.users.id, s.reviews.customerUserId))
    .where(and(...where))
    .orderBy(desc(s.reviews.publishedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const myReports = rows.length
    ? await db.select({ reviewId: s.reviewReports.reviewId, status: s.reviewReports.status }).from(s.reviewReports).where(and(eq(s.reviewReports.merchantId, merchantId), inArray(s.reviewReports.reviewId, rows.map((r) => r.review.id))))
    : [];
  const [merchantSummary, productAgg] = [
    (await ratingSummaries(db, { merchantId })).get(merchantId) ?? emptySummary(),
    await db
      .select({ n: sql<number>`count(*)::int`, avg: sql<string | null>`round(avg(${s.reviews.rating})::numeric, 1)::text` })
      .from(s.reviews)
      .where(and(eq(s.reviews.merchantId, merchantId), eq(s.reviews.type, 'product'), eq(s.reviews.status, 'published'))),
  ];
  return {
    merchantRating: merchantSummary,
    productRating: { count: productAgg[0]!.n, average: productAgg[0]!.avg === null ? null : Number(productAgg[0]!.avg) },
    reviews: rows.map(({ review: r, author, productName }) => ({
      id: r.id,
      type: r.type,
      productId: r.productId,
      productName,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: shortName(author),
      verifiedPurchase: r.verifiedPurchase,
      helpfulCount: r.helpfulCount,
      merchantReply: r.merchantReply,
      merchantRepliedAt: r.merchantRepliedAt,
      reported: myReports.find((m) => m.reviewId === r.id)?.status ?? null,
      publishedAt: r.publishedAt,
    })),
  };
}

/** Moderation queue and full detail for ARUMA staff. */
export async function adminReviews(db: Database, q: { status?: Status; reported?: boolean; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.status) where.push(eq(s.reviews.status, q.status));
  if (q.reported) where.push(sql`${s.reviews.reportCount} > 0`);
  return db
    .select()
    .from(s.reviews)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(s.reviews.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
}

export async function adminReview(db: Database, reviewId: string) {
  const [review] = await db.select().from(s.reviews).where(eq(s.reviews.id, reviewId));
  if (!review) throw notFound('Review');
  const [reports, events, media, [author]] = [
    await db.select().from(s.reviewReports).where(eq(s.reviewReports.reviewId, reviewId)).orderBy(asc(s.reviewReports.createdAt)),
    await db.select().from(s.reviewEvents).where(eq(s.reviewEvents.reviewId, reviewId)).orderBy(asc(s.reviewEvents.createdAt)),
    await db.select({ id: s.reviewMedia.id, kind: s.reviewMedia.kind, approved: s.reviewMedia.approved }).from(s.reviewMedia).where(eq(s.reviewMedia.reviewId, reviewId)),
    await db.select({ id: s.users.id, displayName: s.users.displayName, createdAt: s.users.createdAt }).from(s.users).where(eq(s.users.id, review.customerUserId)),
  ];
  return { ...review, author, reports, events, media };
}
