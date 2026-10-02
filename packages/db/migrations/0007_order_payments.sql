CREATE TYPE "public"."order_payment_status" AS ENUM('pending', 'successful', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'online';--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"payment_refund_id" varchar(64) PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "received_payment_events" (
	"event_id" varchar(64) PRIMARY KEY NOT NULL,
	"type" varchar(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_status" "order_payment_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_intent_id" varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_bounds" CHECK ("orders"."refunded_minor" >= 0 and "orders"."refunded_minor" <= "orders"."total_minor");