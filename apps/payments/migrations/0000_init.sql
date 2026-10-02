CREATE SCHEMA IF NOT EXISTS "payments";
--> statement-breakpoint
CREATE TYPE "payments"."payment_method" AS ENUM('online', 'cash_on_delivery');--> statement-breakpoint
CREATE TYPE "payments"."payment_status" AS ENUM('pending', 'successful', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "payments"."refund_method" AS ENUM('provider', 'manual');--> statement-breakpoint
CREATE TYPE "payments"."refund_status" AS ENUM('pending', 'successful', 'failed');--> statement-breakpoint
CREATE TABLE "payments"."outbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" varchar(32) NOT NULL,
	"type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments"."payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_payment_id" varchar(128),
	"redirect_url" text,
	"status" "payments"."payment_status" DEFAULT 'pending' NOT NULL,
	"provider_status" varchar(32),
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments"."payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" varchar(32) NOT NULL,
	"reference_type" varchar(32) NOT NULL,
	"reference_id" varchar(128) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"method" "payments"."payment_method" NOT NULL,
	"provider" varchar(32) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "payments"."payment_status" DEFAULT 'pending' NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"description" text,
	"return_url" text,
	"failure_url" text,
	"locale" varchar(8),
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_amount_positive" CHECK ("payments"."payment_intents"."amount_minor" > 0),
	CONSTRAINT "payment_intents_refund_bounds" CHECK ("payments"."payment_intents"."refunded_minor" >= 0 and "payments"."payment_intents"."refunded_minor" <= "payments"."payment_intents"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "payments"."refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reason" text NOT NULL,
	"method" "payments"."refund_method" NOT NULL,
	"status" "payments"."refund_status" DEFAULT 'pending' NOT NULL,
	"external_reference" varchar(128),
	"requested_by" varchar(128) NOT NULL,
	"scope" varchar(128),
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "refunds_amount_positive" CHECK ("payments"."refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments"."status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"from_status" "payments"."payment_status",
	"to_status" "payments"."payment_status" NOT NULL,
	"source" varchar(32) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(128),
	"event_type" varchar(64),
	"signature_valid" integer NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "payments"."payment_attempts" ADD CONSTRAINT "payment_attempts_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payments"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."refunds" ADD CONSTRAINT "refunds_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payments"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."status_history" ADD CONSTRAINT "status_history_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payments"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_events_due_idx" ON "payments"."outbound_events" USING btree ("next_attempt_at") WHERE "payments"."outbound_events"."delivered_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_number_uq" ON "payments"."payment_attempts" USING btree ("intent_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_id_uq" ON "payments"."payment_attempts" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_idempotency_uq" ON "payments"."payment_intents" USING btree ("client","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_intents_reference_idx" ON "payments"."payment_intents" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_idempotency_uq" ON "payments"."refunds" USING btree ("intent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "status_history_intent_idx" ON "payments"."status_history" USING btree ("intent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "payments"."webhook_events" USING btree ("provider","provider_event_id");