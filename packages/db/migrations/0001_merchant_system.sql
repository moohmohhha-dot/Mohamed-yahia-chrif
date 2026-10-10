CREATE TYPE "public"."identity_document_type" AS ENUM('national_id', 'passport', 'driving_license');--> statement-breakpoint
CREATE TYPE "public"."merchant_document_kind" AS ENUM('id_front', 'id_back', 'selfie', 'commercial_register', 'auto_entrepreneur_card', 'craft_register_card', 'tax_id_card', 'articles_of_association', 'payout_proof');--> statement-breakpoint
CREATE TYPE "public"."merchant_type" AS ENUM('individual', 'business');--> statement-breakpoint
CREATE TYPE "public"."payout_method_type" AS ENUM('bank_account', 'postal_account');--> statement-breakpoint
CREATE TYPE "public"."registration_type" AS ENUM('commercial_register', 'auto_entrepreneur', 'craft_register');--> statement-breakpoint
CREATE TYPE "public"."verification_kind" AS ENUM('phone', 'email', 'identity', 'business', 'payout');--> statement-breakpoint
CREATE TABLE "merchant_activity_rules" (
	"country" char(2) NOT NULL,
	"activity_code" varchar(64) NOT NULL,
	"individual_requires_registration" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_activity_rules_country_activity_code_pk" PRIMARY KEY("country","activity_code")
);
--> statement-breakpoint
CREATE TABLE "merchant_addresses" (
	"merchant_id" uuid NOT NULL,
	"kind" varchar(16) DEFAULT 'registered' NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"postal_code" varchar(16),
	"country" char(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_addresses_merchant_id_kind_pk" PRIMARY KEY("merchant_id","kind")
);
--> statement-breakpoint
CREATE TABLE "merchant_business_profiles" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text,
	"legal_form" varchar(32),
	"registration_type" "registration_type" NOT NULL,
	"registration_number" varchar(64) NOT NULL,
	"tax_id" varchar(32),
	"statistical_id" varchar(32),
	"tax_article_number" varchar(32),
	"incorporation_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" "merchant_document_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"content_type" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"uploaded_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_identities" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"nationality" char(2) NOT NULL,
	"document_type" "identity_document_type" NOT NULL,
	"document_number_encrypted" text NOT NULL,
	"document_number_last4" varchar(4) NOT NULL,
	"document_expiry" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_payout_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"type" "payout_method_type" NOT NULL,
	"holder_name" text NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"account_number_last4" varchar(4) NOT NULL,
	"institution_name" text,
	"currency" char(3) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_verifications" (
	"merchant_id" uuid NOT NULL,
	"kind" "verification_kind" NOT NULL,
	"status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"verified_value" text,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_verifications_merchant_id_kind_pk" PRIMARY KEY("merchant_id","kind")
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"subject_id" text NOT NULL,
	"target" varchar(254) NOT NULL,
	"code_hash" char(64) NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_verifications" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "merchant_verifications" ALTER COLUMN "status" SET DEFAULT 'unverified'::text;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "verification_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "verification_status" SET DEFAULT 'unverified'::text;--> statement-breakpoint
-- Data migration: map the old merchant-level statuses onto the new ones.
UPDATE "merchants" SET "verification_status" = 'under_review' WHERE "verification_status" = 'pending';--> statement-breakpoint
UPDATE "merchants" SET "verification_status" = 'unverified' WHERE "verification_status" = 'rejected';--> statement-breakpoint
DROP TYPE "public"."verification_status";--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'under_review', 'verified', 'suspended');--> statement-breakpoint
ALTER TABLE "merchant_verifications" ALTER COLUMN "status" SET DEFAULT 'unverified'::"public"."verification_status";--> statement-breakpoint
ALTER TABLE "merchant_verifications" ALTER COLUMN "status" SET DATA TYPE "public"."verification_status" USING "status"::"public"."verification_status";--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "verification_status" SET DEFAULT 'unverified'::"public"."verification_status";--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "verification_status" SET DATA TYPE "public"."verification_status" USING "verification_status"::"public"."verification_status";--> statement-breakpoint
UPDATE "merchants" SET "country" = 'DZ' WHERE "country" IS NULL;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "country" SET NOT NULL;--> statement-breakpoint
-- Existing merchants predate merchant types; they are treated as businesses with a general activity.
ALTER TABLE "merchants" ADD COLUMN "type" "merchant_type" NOT NULL DEFAULT 'business';--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "activity_code" varchar(64) NOT NULL DEFAULT 'general';--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "activity_code" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "activity_description" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "merchant_activity_rules" ADD CONSTRAINT "merchant_activity_rules_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_addresses" ADD CONSTRAINT "merchant_addresses_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_addresses" ADD CONSTRAINT "merchant_addresses_country_countries_code_fk" FOREIGN KEY ("country") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_business_profiles" ADD CONSTRAINT "merchant_business_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_identities" ADD CONSTRAINT "merchant_identities_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_identities" ADD CONSTRAINT "merchant_identities_nationality_countries_code_fk" FOREIGN KEY ("nationality") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_payout_methods" ADD CONSTRAINT "merchant_payout_methods_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_payout_methods" ADD CONSTRAINT "merchant_payout_methods_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_verifications" ADD CONSTRAINT "merchant_verifications_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_verifications" ADD CONSTRAINT "merchant_verifications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_documents_merchant_idx" ON "merchant_documents" USING btree ("merchant_id","kind");--> statement-breakpoint
CREATE INDEX "merchant_payout_methods_merchant_idx" ON "merchant_payout_methods" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_verifications_status_idx" ON "merchant_verifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verification_codes_subject_idx" ON "verification_codes" USING btree ("purpose","subject_id","created_at");--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "legal_name";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "verification_submitted_at";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "verification_decided_at";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "verification_note";;--> statement-breakpoint
-- Merchants verified under the previous single-step process keep selling: carry the approval over to every check.
INSERT INTO "merchant_verifications" ("merchant_id", "kind", "status", "reviewed_at", "note")
SELECT m."id", k."kind", 'verified', now(), 'Carried over from the previous verification process'
FROM "merchants" m
CROSS JOIN unnest(enum_range(NULL::"verification_kind")) AS k("kind")
WHERE m."verification_status" = 'verified';