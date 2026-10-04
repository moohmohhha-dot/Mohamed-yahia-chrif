-- COD history and courier payments are append-only.
CREATE TRIGGER cod_events_append_only BEFORE UPDATE OR DELETE ON cod_events FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cod_events_no_truncate BEFORE TRUNCATE ON cod_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cod_remittances_append_only BEFORE UPDATE OR DELETE ON cod_remittances FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cod_remittances_no_truncate BEFORE TRUNCATE ON cod_remittances FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- COD orders: never deleted; who/what/how much is frozen; counters only go up; the cash only moves forward
-- (awaiting → with the courier → with the merchant, or not collected); a decided confirmation stays decided.
CREATE OR REPLACE FUNCTION cod_orders_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COD records cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.checkout_id <> OLD.checkout_id OR NEW.store_id <> OLD.store_id OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.customer_user_id <> OLD.customer_user_id OR NEW.phone <> OLD.phone OR NEW.amount_due_minor <> OLD.amount_due_minor
     OR NEW.currency <> OLD.currency OR NEW.risk <> OLD.risk THEN
    RAISE EXCEPTION 'COD order % : customer, amount and risk snapshot cannot change', OLD.order_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.call_attempts < OLD.call_attempts OR NEW.delivery_attempts < OLD.delivery_attempts THEN
    RAISE EXCEPTION 'COD order % : attempt counters cannot go down', OLD.order_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.confirmation_status <> 'pending' AND NEW.confirmation_status <> OLD.confirmation_status THEN
    RAISE EXCEPTION 'COD order % : confirmation already decided', OLD.order_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.collection_status <> OLD.collection_status AND NOT (
       (OLD.collection_status = 'awaiting' AND NEW.collection_status IN ('with_courier', 'with_merchant', 'not_collected'))
    OR (OLD.collection_status = 'with_courier' AND NEW.collection_status = 'with_merchant')
  ) THEN
    RAISE EXCEPTION 'COD order % : collection cannot go from % to %', OLD.order_id, OLD.collection_status, NEW.collection_status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.collected_amount_minor IS NOT NULL AND NEW.collected_amount_minor IS DISTINCT FROM OLD.collected_amount_minor THEN
    RAISE EXCEPTION 'COD order % : the collected amount cannot change', OLD.order_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.remittance_id IS NOT NULL AND NEW.remittance_id IS DISTINCT FROM OLD.remittance_id THEN
    RAISE EXCEPTION 'COD order % : already remitted', OLD.order_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cod_orders_guard BEFORE UPDATE OR DELETE ON cod_orders FOR EACH ROW EXECUTE FUNCTION cod_orders_guard();
--> statement-breakpoint
CREATE TRIGGER cod_orders_no_truncate BEFORE TRUNCATE ON cod_orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Blocks are lifted (once, with a reason), never deleted or rewritten.
CREATE OR REPLACE FUNCTION cod_blocks_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COD blocks cannot be deleted; lift them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.phone <> OLD.phone OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.lifted_at IS NULL OR NEW.lift_reason IS NULL THEN
    RAISE EXCEPTION 'COD block % can only be lifted once, with a reason', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cod_blocks_guard BEFORE UPDATE OR DELETE ON cod_blocks FOR EACH ROW EXECUTE FUNCTION cod_blocks_guard();
--> statement-breakpoint
-- Platform COD rules (stores may override them): confirm every order, 3 calls, 3 delivery attempts,
-- COD stops after 3 refusals, no amount limit.
INSERT INTO cod_policies (store_id, require_confirmation, max_call_attempts, max_delivery_attempts, block_after_refusals, max_amount_minor)
VALUES (NULL, true, 3, 3, 3, NULL)
ON CONFLICT DO NOTHING;
