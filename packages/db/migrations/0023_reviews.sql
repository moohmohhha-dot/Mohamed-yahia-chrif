CREATE TYPE "public"."review_event_type" AS ENUM('created', 'edited', 'held', 'published', 'rejected', 'hidden', 'restored', 'withdrawn', 'reported', 'replied', 'media_added');--> statement-breakpoint
CREATE TYPE "public"."review_media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."review_report_reason" AS ENUM('fake', 'spam', 'offensive', 'personal_info', 'off_topic', 'conflict_of_interest', 'other');--> statement-breakpoint
CREATE TYPE "public"."review_report_status" AS ENUM('open', 'upheld', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'rejected', 'hidden', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."review_type" AS ENUM('product', 'merchant');--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"type" "review_event_type" NOT NULL,
	"actor_type" "order_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"kind" "review_media_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"merchant_id" uuid,
	"reason" "review_report_reason" NOT NULL,
	"note" text,
	"status" "review_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_votes" (
	"review_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_votes_review_id_user_id_pk" PRIMARY KEY("review_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "review_type" NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid,
	"merchant_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid,
	"verified_purchase" boolean DEFAULT true NOT NULL,
	"rating" smallint NOT NULL,
	"title" varchar(120),
	"body" text,
	"locale" varchar(16),
	"status" "review_status" NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"moderation_note" text,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"merchant_reply" text,
	"merchant_reply_by" uuid,
	"merchant_replied_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_target" CHECK (("reviews"."type" = 'product') = ("reviews"."product_id" is not null and "reviews"."order_line_id" is not null)),
	CONSTRAINT "reviews_counters" CHECK ("reviews"."helpful_count" >= 0 and "reviews"."report_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_merchant_reply_by_users_id_fk" FOREIGN KEY ("merchant_reply_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_events_review_idx" ON "review_events" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE INDEX "review_media_review_idx" ON "review_media" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_reports_once_uq" ON "review_reports" USING btree ("review_id","reporter_user_id");--> statement-breakpoint
CREATE INDEX "review_reports_status_idx" ON "review_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "review_votes_user_idx" ON "review_votes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_product_author_uq" ON "reviews" USING btree ("customer_user_id","product_id") WHERE "reviews"."type" = 'product';--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_merchant_author_uq" ON "reviews" USING btree ("customer_user_id","merchant_id") WHERE "reviews"."type" = 'merchant';--> statement-breakpoint
CREATE INDEX "reviews_product_idx" ON "reviews" USING btree ("product_id","status","published_at");--> statement-breakpoint
CREATE INDEX "reviews_merchant_idx" ON "reviews" USING btree ("merchant_id","type","status","published_at");--> statement-breakpoint
CREATE INDEX "reviews_moderation_idx" ON "reviews" USING btree ("status","created_at");