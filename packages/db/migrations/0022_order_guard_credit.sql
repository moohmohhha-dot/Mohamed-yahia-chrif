-- Store credit given back on an order (returns, cancellations) may grow after the order is placed, like refunds.
CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'status_changed_at' - 'payment_status' - 'payment_intent_id' - 'refunded_minor' - 'credit_returned_minor')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'status_changed_at' - 'payment_status' - 'payment_intent_id' - 'refunded_minor' - 'credit_returned_minor') THEN
    RAISE EXCEPTION 'Order %: only the status can change after the order is placed', OLD."number"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."credit_returned_minor" < OLD."credit_returned_minor" THEN
    RAISE EXCEPTION 'Order %: credit given back cannot decrease', OLD."number" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."refunded_minor" < OLD."refunded_minor" THEN
    RAISE EXCEPTION 'Order %: refunded amount cannot decrease', OLD."number" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."payment_intent_id" IS NOT NULL AND NEW."payment_intent_id" IS DISTINCT FROM OLD."payment_intent_id" THEN
    RAISE EXCEPTION 'Order %: payment cannot be re-linked', OLD."number" USING ERRCODE = 'insufficient_privilege';
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
