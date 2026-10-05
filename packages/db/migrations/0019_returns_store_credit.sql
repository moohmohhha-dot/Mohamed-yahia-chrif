CREATE TYPE "public"."store_credit_kind" AS ENUM('issued', 'used', 'restored', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."shipment_direction" AS ENUM('outbound', 'return');--> statement-breakpoint
CREATE TYPE "public"."return_evidence_role" AS ENUM('customer', 'merchant', 'platform');--> statement-breakpoint
CREATE TYPE "public"."return_event_type" AS ENUM('created', 'submitted', 'evidence_added', 'merchant_approved', 'merchant_rejected', 'escalated', 'admin_approved', 'admin_rejected', 'cancelled', 'pickup_created', 'shipped_back', 'received', 'inspected', 'refunded', 'refund_recorded', 'credited', 'replacement_created', 'note');--> statement-breakpoint
CREATE TYPE "public"."return_method" AS ENUM('pickup', 'drop_off', 'keep_item');--> statement-breakpoint
CREATE TYPE "public"."return_reason" AS ENUM('damaged', 'defective', 'wrong_item', 'not_as_described', 'missing_parts', 'counterfeit_suspected', 'changed_mind', 'other');--> statement-breakpoint
CREATE TYPE "public"."return_resolution" AS ENUM('refund', 'replacement', 'store_credit');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('draft', 'requested', 'under_review', 'approved', 'rejected', 'cancelled', 'in_transit', 'received', 'inspection_failed', 'refund_pending', 'completed');--> statement-breakpoint
ALTER TYPE "public"."ledger_account_purpose" ADD VALUE 'store_credit' BEFORE 'merchant_pending';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'store_credit_issued';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'store_credit_used';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'store_credit_restored';--> statement-breakpoint
CREATE TABLE "store_credit_accounts" (
	"customer_user_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_credit_balance_positive" CHECK ("store_credit_accounts"."balance_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"kind" "store_credit_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"order_id" uuid,
	"source_type" varchar(32),
	"source_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "store_credit_transactions_nonzero" CHECK ("store_credit_transactions"."amount_minor" <> 0 and "store_credit_transactions"."balance_after_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"type" "return_event_type" NOT NULL,
	"from_status" "return_status",
	"to_status" "return_status",
	"actor_type" "order_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"role" "return_evidence_role" NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"content_type" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"restock" boolean,
	CONSTRAINT "return_lines_line_uq" UNIQUE("return_id","order_line_id"),
	CONSTRAINT "return_lines_quantity" CHECK ("return_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "return_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"window_days" smallint DEFAULT 7 NOT NULL,
	"merchant_response_hours" smallint DEFAULT 48 NOT NULL,
	"escalation_days" smallint DEFAULT 7 NOT NULL,
	"allow_change_of_mind" boolean DEFAULT true NOT NULL,
	"change_of_mind_fee_minor" bigint DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_policies_store_uq" UNIQUE NULLS NOT DISTINCT("store_id"),
	CONSTRAINT "return_policies_limits" CHECK ("return_policies"."window_days" between 1 and 90 and "return_policies"."merchant_response_hours" between 1 and 720 and "return_policies"."escalation_days" between 1 and 60 and "return_policies"."change_of_mind_fee_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(32) NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"status" "return_status" DEFAULT 'draft' NOT NULL,
	"reason" "return_reason" NOT NULL,
	"description" text NOT NULL,
	"requested_resolution" "return_resolution" NOT NULL,
	"resolution" "return_resolution",
	"return_method" "return_method",
	"currency" char(3) NOT NULL,
	"items_value_minor" bigint NOT NULL,
	"approved_amount_minor" bigint,
	"final_amount_minor" bigint,
	"partial_reason" text,
	"response_due_at" timestamp with time zone,
	"merchant_note" text,
	"merchant_responded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"admin_note" text,
	"admin_decided_at" timestamp with time zone,
	"final_decision" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"inspection_note" text,
	"replacement_order_id" uuid,
	"payment_refund_id" varchar(64),
	"refund_reference" varchar(128),
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_requests_number_unique" UNIQUE("number"),
	CONSTRAINT "return_requests_amounts" CHECK ("return_requests"."items_value_minor" > 0 and ("return_requests"."final_amount_minor" is null or "return_requests"."final_amount_minor" >= 0))
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_refund_bounds";--> statement-breakpoint
DROP INDEX "shipments_active_order_uq";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "credit_applied_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "credit_returned_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "replacement_for_order_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "direction" "shipment_direction" DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "store_credit_accounts" ADD CONSTRAINT "store_credit_accounts_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_accounts" ADD CONSTRAINT "store_credit_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_evidence" ADD CONSTRAINT "return_evidence_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_evidence" ADD CONSTRAINT "return_evidence_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_replacement_order_id_orders_id_fk" FOREIGN KEY ("replacement_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_credit_accounts_pk" ON "store_credit_accounts" USING btree ("customer_user_id","currency");--> statement-breakpoint
CREATE INDEX "store_credit_transactions_customer_idx" ON "store_credit_transactions" USING btree ("customer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "return_events_return_idx" ON "return_events" USING btree ("return_id","created_at");--> statement-breakpoint
CREATE INDEX "return_evidence_return_idx" ON "return_evidence" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "return_requests_merchant_idx" ON "return_requests" USING btree ("merchant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "return_requests_customer_idx" ON "return_requests" USING btree ("customer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "return_requests_due_idx" ON "return_requests" USING btree ("status","response_due_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_replacement_for_order_id_orders_id_fk" FOREIGN KEY ("replacement_for_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_return_uq" ON "shipments" USING btree ("return_id") WHERE "shipments"."status" <> 'cancelled' and "shipments"."direction" = 'return';--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_order_uq" ON "shipments" USING btree ("order_id") WHERE "shipments"."status" <> 'cancelled' and "shipments"."direction" = 'outbound';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_bounds" CHECK ("orders"."refunded_minor" >= 0 and "orders"."credit_returned_minor" >= 0 and "orders"."credit_applied_minor" >= 0 and "orders"."credit_applied_minor" <= "orders"."total_minor" and "orders"."refunded_minor" <= "orders"."total_minor" - "orders"."credit_applied_minor" and "orders"."refunded_minor" + "orders"."credit_returned_minor" <= "orders"."total_minor");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_return_link" CHECK (("shipments"."direction" = 'return') = ("shipments"."return_id" is not null));