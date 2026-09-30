-- Sensitive history tables are append-only, enforced by the database itself:
-- no application bug, merchant request or admin endpoint can rewrite or erase them.
-- Future financial ledgers (balances, settlements, payouts, rewards) get the same trigger.
CREATE OR REPLACE FUNCTION forbid_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_movements_no_truncate
  BEFORE TRUNCATE ON "inventory_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Existing offers start their history with one 'initial' movement equal to their current stock.
INSERT INTO "inventory_movements" ("offer_id", "merchant_id", "delta", "quantity_after", "reason", "note")
SELECT "id", "merchant_id", "stock_quantity", "stock_quantity", 'initial', 'Opening balance'
FROM "offers";
