/**
 * Reviews of products and of merchants. Only customers with a delivered order can review (verified
 * purchase); one review per customer per product and per merchant (edited, never repeated). Automatic
 * checks hold suspicious reviews for moderation; every moderation step is recorded.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar, char } from 'drizzle-orm/pg-core';
import { id, orderActorType } from './common.js';
import { products } from './catalog.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { orderLines, orders } from './orders.js';
import { stores } from './tenancy.js';

export const reviewType = pgEnum('review_type', ['product', 'merchant']);
export const reviewStatus = pgEnum('review_status', [
  'pending', // held for moderation (automatic checks, reports, edits with flags)
  'published',
  'rejected', // refused by moderation (the author sees why and may edit)
  'hidden', // removed from public view after publication (e.g. reports upheld)
  'withdrawn', // removed by its author
]);

export type ReviewFlag = { code: string; detail?: string };

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    type: reviewType('type').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** Product reviews: the product. Merchant reviews: null. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    /** The seller: for product reviews, the merchant who sold this item. */
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The purchase behind the review (latest one when the customer bought again). */
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderLineId: uuid('order_line_id').references(() => orderLines.id, { onDelete: 'restrict' }),
    /** Every review written in ARUMA comes from a delivered order; false is kept for imported reviews later. */
    verifiedPurchase: boolean('verified_purchase').notNull().default(true),
    rating: smallint('rating').notNull(),
    title: varchar('title', { length: 120 }),
    body: text('body'),
    locale: varchar('locale', { length: 16 }),
    status: reviewStatus('status').notNull(),
    /** Why automatic checks held the review (empty when published directly). */
    flags: jsonb('flags').$type<ReviewFlag[]>().notNull().default([]),
    moderationNote: text('moderation_note'),
    moderatedBy: uuid('moderated_by').references(() => users.id, { onDelete: 'set null' }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    helpfulCount: integer('helpful_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    merchantReply: text('merchant_reply'),
    merchantReplyBy: uuid('merchant_reply_by').references(() => users.id, { onDelete: 'set null' }),
    merchantRepliedAt: timestamp('merchant_replied_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One review per customer per product, and per merchant.
    uniqueIndex('reviews_product_author_uq').on(t.customerUserId, t.productId).where(sql`${t.type} = 'product'`),
    uniqueIndex('reviews_merchant_author_uq').on(t.customerUserId, t.merchantId).where(sql`${t.type} = 'merchant'`),
    index('reviews_product_idx').on(t.productId, t.status, t.publishedAt),
    index('reviews_merchant_idx').on(t.merchantId, t.type, t.status, t.publishedAt),
    index('reviews_moderation_idx').on(t.status, t.createdAt),
    check('reviews_rating', sql`${t.rating} between 1 and 5`),
    check('reviews_target', sql`(${t.type} = 'product') = (${t.productId} is not null and ${t.orderLineId} is not null)`),
    check('reviews_counters', sql`${t.helpfulCount} >= 0 and ${t.reportCount} >= 0`),
  ],
);

/** "Helpful" votes: one per user per review. */
export const reviewVotes = pgTable(
  'review_votes',
  {
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.userId] }), index('review_votes_user_idx').on(t.userId, t.createdAt)],
);

export const reviewReportReason = pgEnum('review_report_reason', ['fake', 'spam', 'offensive', 'personal_info', 'off_topic', 'conflict_of_interest', 'other']);
export const reviewReportStatus = pgEnum('review_report_status', ['open', 'upheld', 'dismissed']);

/** Reports by customers or merchants: one per user per review. */
export const reviewReports = pgTable(
  'review_reports',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Set when the report comes from the reviewed merchant. */
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'restrict' }),
    reason: reviewReportReason('reason').notNull(),
    note: text('note'),
    status: reviewReportStatus('status').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('review_reports_once_uq').on(t.reviewId, t.reporterUserId), index('review_reports_status_idx').on(t.status, t.createdAt)],
);

export const reviewEventType = pgEnum('review_event_type', ['created', 'edited', 'held', 'published', 'rejected', 'hidden', 'restored', 'withdrawn', 'reported', 'replied', 'media_added']);

/** Everything that happened to a review (creation, edits, moderation). Append-only. */
export const reviewEvents = pgTable(
  'review_events',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    type: reviewEventType('type').notNull(),
    actorType: orderActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    note: text('note'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('review_events_review_idx').on(t.reviewId, t.createdAt)],
);

export const reviewMediaKind = pgEnum('review_media_kind', ['image', 'video']);

/**
 * Photos (and later videos) attached to a review. Prepared for later: uploads are accepted only when
 * the store's `reviews.media` feature is on, and a review with media is always moderated first.
 */
export const reviewMedia = pgTable(
  'review_media',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    kind: reviewMediaKind('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    approved: boolean('approved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('review_media_review_idx').on(t.reviewId)],
);
