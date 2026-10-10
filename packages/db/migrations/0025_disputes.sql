CREATE TYPE "public"."dispute_event_type" AS ENUM('opened', 'message', 'file_added', 'responded', 'escalated', 'decided', 'accepted', 'appealed', 'appeal_decided', 'executed', 'execution_recorded', 'resolved', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."dispute_execution" AS ENUM('none', 'pending', 'done');--> statement-breakpoint
CREATE TYPE "public"."dispute_file_kind" AS ENUM('evidence', 'document');--> statement-breakpoint
CREATE TYPE "public"."dispute_kind" AS ENUM('customer_merchant', 'merchant_customer', 'merchant_aruma');--> statement-breakpoint
CREATE TYPE "public"."dispute_outcome" AS ENUM('claimant', 'respondent', 'partial');--> statement-breakpoint
CREATE TYPE "public"."dispute_remedy" AS ENUM('none', 'refund', 'store_credit', 'merchant_compensation');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'decided', 'appealed', 'resolved', 'withdrawn');--> statement-breakpoint
CREATE TABLE "dispute_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"type" "dispute_event_type" NOT NULL,
	"from_status" "dispute_status",
	"to_status" "dispute_status",
	"actor_type" "order_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" "dispute_file_kind" NOT NULL,
	"uploader_type" "order_actor_type" NOT NULL,
	"uploaded_by" uuid,
	"internal" boolean DEFAULT false NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"content_type" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"author_type" "order_actor_type" NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(32) NOT NULL,
	"kind" "dispute_kind" NOT NULL,
	"category" varchar(48) NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"opened_by" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_user_id" uuid,
	"order_id" uuid,
	"return_id" uuid,
	"references" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"requested_remedy" "dispute_remedy" DEFAULT 'none' NOT NULL,
	"requested_amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"respond_due_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"outcome" "dispute_outcome",
	"remedy" "dispute_remedy",
	"remedy_amount_minor" bigint,
	"decision_text" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"appeal_due_at" timestamp with time zone,
	"appealed_by" uuid,
	"appealed_at" timestamp with time zone,
	"appeal_reason" text,
	"appeal_outcome" varchar(16),
	"appeal_decision_text" text,
	"appeal_decided_by" uuid,
	"appeal_decided_at" timestamp with time zone,
	"execution_status" "dispute_execution" DEFAULT 'none' NOT NULL,
	"payment_refund_id" varchar(64),
	"execution_reference" varchar(128),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_number_unique" UNIQUE("number"),
	CONSTRAINT "disputes_appeal_other_admin" CHECK ("disputes"."appeal_decided_by" is null or "disputes"."appeal_decided_by" <> "disputes"."decided_by"),
	CONSTRAINT "disputes_parties" CHECK (("disputes"."kind" = 'merchant_aruma') = ("disputes"."customer_user_id" is null)),
	CONSTRAINT "disputes_amounts" CHECK (("disputes"."requested_amount_minor" is null or "disputes"."requested_amount_minor" >= 0) and ("disputes"."remedy_amount_minor" is null or "disputes"."remedy_amount_minor" >= 0))
);
--> statement-breakpoint
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_files" ADD CONSTRAINT "dispute_files_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_files" ADD CONSTRAINT "dispute_files_message_id_dispute_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."dispute_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_files" ADD CONSTRAINT "dispute_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_appealed_by_users_id_fk" FOREIGN KEY ("appealed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_appeal_decided_by_users_id_fk" FOREIGN KEY ("appeal_decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_events_dispute_idx" ON "dispute_events" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "dispute_files_dispute_idx" ON "dispute_files" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "dispute_messages_dispute_idx" ON "dispute_messages" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_merchant_idx" ON "disputes" USING btree ("merchant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "disputes_customer_idx" ON "disputes" USING btree ("customer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "disputes_order_idx" ON "disputes" USING btree ("order_id");