CREATE TYPE "public"."staff_role" AS ENUM('super_admin', 'finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin');--> statement-breakpoint
CREATE TABLE "staff_role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"granted_by" uuid,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "blocked_by" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "block_reason" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "blocked_from_status" "record_status";--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_role_grants_active_uq" ON "staff_role_grants" USING btree ("user_id","role") WHERE "staff_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "staff_role_grants_user_idx" ON "staff_role_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Existing platform admins become super admins, support staff become support admins.
INSERT INTO "staff_role_grants" ("user_id", "role", "reason")
SELECT "id", CASE "role" WHEN 'admin' THEN 'super_admin'::staff_role ELSE 'support_admin'::staff_role END, 'Migrated from the former platform role'
FROM "users" WHERE "role" IN ('admin', 'support');
--> statement-breakpoint
-- Grants are history: never deleted; once given, only the revocation can be recorded (once).
CREATE OR REPLACE FUNCTION staff_role_grants_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.reason <> OLD.reason OR NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'A staff role grant cannot be rewritten' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A revoked staff role stays revoked; grant it again instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER staff_role_grants_guard BEFORE UPDATE ON staff_role_grants FOR EACH ROW EXECUTE FUNCTION staff_role_grants_guard();
--> statement-breakpoint
CREATE TRIGGER staff_role_grants_no_delete BEFORE DELETE ON staff_role_grants FOR EACH ROW EXECUTE FUNCTION forbid_delete();
