-- Human-readable order numbers: <year>-<sequence>, e.g. 2026-000042.
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;
--> statement-breakpoint
-- Status changes only along the allowed transitions (same table as orders/transitions.ts).
-- A bug or a manual UPDATE cannot jump, e.g., from "new" to "refunded".
CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'status_changed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'status_changed_at') THEN
    RAISE EXCEPTION 'Order %: only the status can change after the order is placed', OLD."number"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status"::text, NEW."status"::text) IN (
    ('new', 'processing'), ('new', 'cancelled'),
    ('processing', 'preparing'), ('processing', 'cancelled'),
    ('preparing', 'shipping'), ('preparing', 'cancelled'),
    ('shipping', 'delivered'), ('shipping', 'returned'),
    ('delivered', 'returned'),
    ('returned', 'refunded'),
    ('cancelled', 'refunded')
  ) THEN
    RAISE EXCEPTION 'Order %: transition % -> % is not allowed', OLD."number", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER orders_guard BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION orders_guard();
--> statement-breakpoint
CREATE TRIGGER orders_no_delete BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON "orders" FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_lines_append_only BEFORE UPDATE OR DELETE ON "order_lines" FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_lines_no_truncate BEFORE TRUNCATE ON "order_lines" FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON "order_status_history" FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_status_history_no_truncate BEFORE TRUNCATE ON "order_status_history" FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
