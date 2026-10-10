CREATE TYPE "public"."cod_collection_status" AS ENUM('awaiting', 'with_courier', 'with_merchant', 'not_collected');--> statement-breakpoint
CREATE TYPE "public"."cod_confirmation_channel" AS ENUM('sms_code', 'phone_call', 'platform');--> statement-breakpoint
CREATE TYPE "public"."cod_confirmation_status" AS ENUM('pending', 'confirmed', 'declined', 'unreachable', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."cod_event_type" AS ENUM('created', 'code_sent', 'confirmed', 'call', 'declined', 'unreachable', 'delivery_failed', 'reattempt_scheduled', 'refused', 'collected', 'remitted', 'not_collected');--> statement-breakpoint
CREATE TYPE "public"."cod_outcome" AS ENUM('open', 'delivered', 'refused', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "cod_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason" text
);
--> statement-breakpoint
CREATE TABLE "cod_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "cod_event_type" NOT NULL,
	"reason" varchar(48),
	"note" text,
	"actor_type" "order_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cod_orders" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"phone" varchar(20) NOT NULL,
	"amount_due_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"confirmation_status" "cod_confirmation_status" NOT NULL,
	"confirmed_via" "cod_confirmation_channel",
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"call_attempts" smallint DEFAULT 0 NOT NULL,
	"delivery_attempts" smallint DEFAULT 0 NOT NULL,
	"last_failure_reason" varchar(48),
	"next_attempt_at" timestamp with time zone,
	"refusal_reason" varchar(48),
	"collection_status" "cod_collection_status" DEFAULT 'awaiting' NOT NULL,
	"collected_amount_minor" bigint,
	"collected_at" timestamp with time zone,
	"remittance_id" uuid,
	"outcome" "cod_outcome" DEFAULT 'open' NOT NULL,
	"risk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cod_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"require_confirmation" boolean DEFAULT true NOT NULL,
	"max_call_attempts" smallint DEFAULT 3 NOT NULL,
	"max_delivery_attempts" smallint DEFAULT 3 NOT NULL,
	"block_after_refusals" smallint DEFAULT 3 NOT NULL,
	"max_amount_minor" bigint,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cod_policies_store_uq" UNIQUE NULLS NOT DISTINCT("store_id"),
	CONSTRAINT "cod_policies_limits" CHECK ("cod_policies"."max_call_attempts" between 1 and 10 and "cod_policies"."max_delivery_attempts" between 1 and 10 and "cod_policies"."block_after_refusals" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cod_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"courier_code" varchar(32),
	"reference" varchar(100) NOT NULL,
	"currency" char(3) NOT NULL,
	"collected_minor" bigint NOT NULL,
	"courier_fees_minor" bigint NOT NULL,
	"received_minor" bigint NOT NULL,
	"order_count" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cod_remittances_reference_uq" UNIQUE NULLS NOT DISTINCT("merchant_id","courier_code","reference"),
	CONSTRAINT "cod_remittances_amounts" CHECK ("cod_remittances"."received_minor" = "cod_remittances"."collected_minor" - "cod_remittances"."courier_fees_minor" and "cod_remittances"."courier_fees_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cod_blocks" ADD CONSTRAINT "cod_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_blocks" ADD CONSTRAINT "cod_blocks_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_events" ADD CONSTRAINT "cod_events_order_id_cod_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."cod_orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_events" ADD CONSTRAINT "cod_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_remittance_id_cod_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."cod_remittances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_policies" ADD CONSTRAINT "cod_policies_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_policies" ADD CONSTRAINT "cod_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cod_blocks_active_phone_uq" ON "cod_blocks" USING btree ("phone") WHERE "cod_blocks"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "cod_events_order_idx" ON "cod_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "cod_orders_phone_idx" ON "cod_orders" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "cod_orders_customer_idx" ON "cod_orders" USING btree ("customer_user_id");--> statement-breakpoint
CREATE INDEX "cod_orders_merchant_collection_idx" ON "cod_orders" USING btree ("merchant_id","collection_status");--> statement-breakpoint
CREATE INDEX "cod_orders_checkout_idx" ON "cod_orders" USING btree ("checkout_id");