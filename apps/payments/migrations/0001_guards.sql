-- History and refunds are the payment audit trail: never rewritten or erased.
CREATE OR REPLACE FUNCTION payments.forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payments.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER status_history_append_only BEFORE UPDATE OR DELETE ON payments.status_history FOR EACH ROW EXECUTE FUNCTION payments.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER status_history_no_truncate BEFORE TRUNCATE ON payments.status_history FOR EACH STATEMENT EXECUTE FUNCTION payments.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON payments.refunds FOR EACH ROW EXECUTE FUNCTION payments.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON payments.payment_intents FOR EACH ROW EXECUTE FUNCTION payments.forbid_mutation();
--> statement-breakpoint
-- An intent's amount, currency and reference are fixed once created.
CREATE OR REPLACE FUNCTION payments.intent_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.reference_type <> OLD.reference_type OR NEW.reference_id <> OLD.reference_id
     OR NEW.method <> OLD.method OR NEW.client <> OLD.client THEN
    RAISE EXCEPTION 'Payment %: amount, currency, method and reference cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.refunded_minor < OLD.refunded_minor THEN
    RAISE EXCEPTION 'Payment %: refunded amount cannot decrease', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_intents_guard BEFORE UPDATE ON payments.payment_intents FOR EACH ROW EXECUTE FUNCTION payments.intent_guard();
