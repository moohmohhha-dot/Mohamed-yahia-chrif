CREATE TYPE "public"."courier_integration" AS ENUM('manual', 'api');--> statement-breakpoint
CREATE TYPE "public"."geo_area_level" AS ENUM('region', 'district', 'locality');--> statement-breakpoint
CREATE TYPE "public"."shipment_event_source" AS ENUM('merchant', 'courier', 'platform', 'system');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'ready_for_pickup', 'in_transit', 'out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shipping_method_type" AS ENUM('merchant_delivery', 'courier', 'local_pickup', 'pickup_point');--> statement-breakpoint
CREATE TABLE "courier_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_code" varchar(32) NOT NULL,
	"merchant_id" uuid,
	"label" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "couriers" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" char(2) NOT NULL,
	"integration" "courier_integration" DEFAULT 'manual' NOT NULL,
	"tracking_url_template" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_areas" (
	"id" varchar(96) PRIMARY KEY NOT NULL,
	"country" char(2) NOT NULL,
	"level" "geo_area_level" NOT NULL,
	"parent_id" varchar(96),
	"code" varchar(16),
	"names" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_code" varchar(32),
	"area_id" varchar(96) NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"phone" varchar(20),
	"hours" text,
	"external_id" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" "shipment_status" NOT NULL,
	"source" "shipment_event_source" NOT NULL,
	"actor_user_id" uuid,
	"description" text,
	"location" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_event_id" varchar(128),
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"method_id" uuid,
	"method_type" "shipping_method_type" NOT NULL,
	"courier_code" varchar(32),
	"courier_account_id" uuid,
	"tracking_number" varchar(64),
	"external_id" varchar(64),
	"label_url" text,
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"destination" jsonb NOT NULL,
	"cod_amount_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"created_by" uuid,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"type" "shipping_method_type" NOT NULL,
	"name" text NOT NULL,
	"courier_code" varchar(32),
	"courier_account_id" uuid,
	"pickup_location" jsonb,
	"cash_on_delivery" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_methods_courier_required" CHECK (("shipping_methods"."type" not in ('courier', 'pickup_point')) or "shipping_methods"."courier_code" is not null),
	CONSTRAINT "shipping_methods_pickup_location" CHECK ("shipping_methods"."type" <> 'local_pickup' or "shipping_methods"."pickup_location" is not null)
);
--> statement-breakpoint
CREATE TABLE "shipping_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method_id" uuid NOT NULL,
	"zone_id" uuid,
	"currency" char(3) NOT NULL,
	"price_minor" bigint NOT NULL,
	"free_above_minor" bigint,
	"min_days" smallint DEFAULT 1 NOT NULL,
	"max_days" smallint DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_rates_method_zone_currency_uq" UNIQUE NULLS NOT DISTINCT("method_id","zone_id","currency"),
	CONSTRAINT "shipping_rates_price_positive" CHECK ("shipping_rates"."price_minor" >= 0 and ("shipping_rates"."free_above_minor" is null or "shipping_rates"."free_above_minor" >= 0)),
	CONSTRAINT "shipping_rates_days" CHECK ("shipping_rates"."min_days" >= 0 and "shipping_rates"."max_days" >= "shipping_rates"."min_days")
);
--> statement-breakpoint
CREATE TABLE "shipping_zone_areas" (
	"zone_id" uuid NOT NULL,
	"area_id" varchar(96) NOT NULL,
	CONSTRAINT "shipping_zone_areas_zone_id_area_id_pk" PRIMARY KEY("zone_id","area_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"country" char(2) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_method_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery" jsonb;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "couriers" ADD CONSTRAINT "couriers_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_areas" ADD CONSTRAINT "geo_areas_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_areas" ADD CONSTRAINT "geo_areas_parent_id_geo_areas_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."geo_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_area_id_geo_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_method_id_shipping_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_courier_account_id_courier_accounts_id_fk" FOREIGN KEY ("courier_account_id") REFERENCES "public"."courier_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_courier_account_id_courier_accounts_id_fk" FOREIGN KEY ("courier_account_id") REFERENCES "public"."courier_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_method_id_shipping_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zone_areas" ADD CONSTRAINT "shipping_zone_areas_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zone_areas" ADD CONSTRAINT "shipping_zone_areas_area_id_geo_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courier_accounts_merchant_idx" ON "courier_accounts" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "geo_areas_parent_idx" ON "geo_areas" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "geo_areas_country_level_idx" ON "geo_areas" USING btree ("country","level");--> statement-breakpoint
CREATE INDEX "pickup_points_area_idx" ON "pickup_points" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_events_external_uq" ON "shipment_events" USING btree ("shipment_id","external_event_id") WHERE "shipment_events"."external_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_order_uq" ON "shipments" USING btree ("order_id") WHERE "shipments"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tracking_uq" ON "shipments" USING btree ("courier_code","tracking_number") WHERE "shipments"."tracking_number" is not null;--> statement-breakpoint
CREATE INDEX "shipments_merchant_idx" ON "shipments" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "shipping_methods_merchant_idx" ON "shipping_methods" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "shipping_zone_areas_area_idx" ON "shipping_zone_areas" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "shipping_zones_merchant_idx" ON "shipping_zones" USING btree ("merchant_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_method_id_shipping_methods_id_fk" FOREIGN KEY ("shipping_method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE restrict ON UPDATE no action;