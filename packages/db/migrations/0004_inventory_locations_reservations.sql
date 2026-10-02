CREATE TYPE "public"."inventory_location_type" AS ENUM('warehouse', 'shop', 'fulfillment_center', 'dropship');--> statement-breakpoint
CREATE TYPE "public"."inventory_reservation_status" AS ENUM('active', 'released', 'consumed', 'expired');--> statement-breakpoint
ALTER TYPE "public"."inventory_reason" ADD VALUE 'reserved';--> statement-breakpoint
ALTER TYPE "public"."inventory_reason" ADD VALUE 'released';--> statement-breakpoint
ALTER TYPE "public"."inventory_reason" ADD VALUE 'transfer_out';--> statement-breakpoint
ALTER TYPE "public"."inventory_reason" ADD VALUE 'transfer_in';--> statement-breakpoint
ALTER TYPE "public"."inventory_reason" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"offer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_levels_offer_id_location_id_pk" PRIMARY KEY("offer_id","location_id"),
	CONSTRAINT "inventory_levels_on_hand_nonneg" CHECK ("inventory_levels"."on_hand" >= 0),
	CONSTRAINT "inventory_levels_reserved_nonneg" CHECK ("inventory_levels"."reserved" >= 0),
	CONSTRAINT "inventory_levels_no_oversell" CHECK ("inventory_levels"."reserved" <= "inventory_levels"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"type" "inventory_location_type" DEFAULT 'warehouse' NOT NULL,
	"country" char(2),
	"region" text,
	"city" text,
	"address_line" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory_reservation_status" DEFAULT 'active' NOT NULL,
	"reference_type" varchar(32) NOT NULL,
	"reference_id" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("inventory_reservations"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT "offers_stock_nonneg";--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reserved_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reserved_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reference_type" varchar(32);--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reference_id" varchar(128);--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sku" varchar(64);--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "on_hand_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "reserved_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "available_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "low_stock_threshold" integer DEFAULT 5;--> statement-breakpoint
-- Data migration 1/4: each offer gets the merchant's SKU = the variant SKU (suffixed if a merchant has duplicates).
UPDATE "offers" o SET "sku" = d."sku"
FROM (
  SELECT o2."id",
         CASE WHEN count(*) OVER (PARTITION BY o2."merchant_id", v."sku") > 1
              THEN left(v."sku", 55) || '-' || left(o2."id"::text, 8)
              ELSE v."sku" END AS "sku"
  FROM "offers" o2 JOIN "product_variants" v ON v."id" = o2."variant_id"
) d
WHERE d."id" = o."id";--> statement-breakpoint
ALTER TABLE "offers" ALTER COLUMN "sku" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_levels_location_idx" ON "inventory_levels" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_merchant_code_uq" ON "inventory_locations" USING btree ("merchant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_one_default_uq" ON "inventory_locations" USING btree ("merchant_id") WHERE "inventory_locations"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_ref_line_uq" ON "inventory_reservations" USING btree ("reference_type","reference_id","offer_id","location_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_offer_idx" ON "inventory_reservations" USING btree ("offer_id","status");--> statement-breakpoint
CREATE INDEX "inventory_reservations_expiry_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE "inventory_reservations"."status" = 'active' and "inventory_reservations"."expires_at" is not null;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_reference_idx" ON "inventory_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_merchant_sku_uq" ON "offers" USING btree ("merchant_id","sku");--> statement-breakpoint
-- Offer totals are derived from inventory_levels by this trigger; the application never writes them.
CREATE OR REPLACE FUNCTION sync_offer_inventory_totals() RETURNS trigger AS $$
DECLARE
  target uuid := COALESCE(NEW."offer_id", OLD."offer_id");
BEGIN
  UPDATE "offers" o SET
    "on_hand_quantity" = t.on_hand,
    "reserved_quantity" = t.reserved,
    "available_quantity" = t.on_hand - t.reserved
  FROM (
    SELECT COALESCE(sum("on_hand"), 0)::int AS on_hand, COALESCE(sum("reserved"), 0)::int AS reserved
    FROM "inventory_levels" WHERE "offer_id" = target
  ) t
  WHERE o."id" = target;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inventory_levels_sync_offer
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_levels"
  FOR EACH ROW EXECUTE FUNCTION sync_offer_inventory_totals();
--> statement-breakpoint
-- Data migration 2/4: one default location per merchant.
INSERT INTO "inventory_locations" ("merchant_id", "code", "name", "country", "is_default")
SELECT "id", 'MAIN', 'Main warehouse', "country", true FROM "merchants";--> statement-breakpoint
-- Data migration 3/4: existing stock becomes on-hand stock at the default location.
INSERT INTO "inventory_levels" ("offer_id", "location_id", "on_hand")
SELECT o."id", l."id", o."stock_quantity"
FROM "offers" o JOIN "inventory_locations" l ON l."merchant_id" = o."merchant_id" AND l."is_default";--> statement-breakpoint
-- Data migration 4/4: attach past movements to the default location. The history table is append-only,
-- so its guard is suspended for this one schema migration only.
ALTER TABLE "inventory_movements" DISABLE TRIGGER inventory_movements_append_only;--> statement-breakpoint
UPDATE "inventory_movements" m SET "location_id" = l."id"
FROM "inventory_locations" l WHERE l."merchant_id" = m."merchant_id" AND l."is_default";--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE TRIGGER inventory_movements_append_only;--> statement-breakpoint
ALTER TABLE "offers" DROP COLUMN "stock_quantity";--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_available_nonneg" CHECK ("offers"."available_quantity" >= 0);