-- Return history, evidence and store credit movements are append-only.
CREATE TRIGGER return_events_append_only BEFORE UPDATE OR DELETE ON return_events FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER return_events_no_truncate BEFORE TRUNCATE ON return_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER return_evidence_append_only BEFORE UPDATE OR DELETE ON return_evidence FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER return_evidence_no_truncate BEFORE TRUNCATE ON return_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER store_credit_transactions_append_only BEFORE UPDATE OR DELETE ON store_credit_transactions FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER store_credit_transactions_no_truncate BEFORE TRUNCATE ON store_credit_transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Returns and credit balances are never deleted; a balance only changes to the running total of its last movement.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER return_requests_no_delete BEFORE DELETE ON return_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER return_lines_no_delete BEFORE DELETE ON return_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER store_credit_accounts_no_delete BEFORE DELETE ON store_credit_accounts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION store_credit_accounts_guard() RETURNS trigger AS $$
DECLARE
  last_balance bigint;
BEGIN
  SELECT balance_after_minor INTO last_balance FROM store_credit_transactions
   WHERE customer_user_id = NEW.customer_user_id AND currency = NEW.currency
   ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NEW.balance_minor IS DISTINCT FROM coalesce(last_balance, 0) THEN
    RAISE EXCEPTION 'Store credit balance must match its last movement' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER store_credit_accounts_guard BEFORE UPDATE ON store_credit_accounts FOR EACH ROW EXECUTE FUNCTION store_credit_accounts_guard();
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS return_number_seq;
--> statement-breakpoint
-- Platform return rules: 7 days after delivery (the merchant's hold period), 48 h for the merchant to answer,
-- 7 days to escalate, change of mind accepted without fee.
INSERT INTO return_policies (store_id, window_days, merchant_response_hours, escalation_days, allow_change_of_mind, change_of_mind_fee_minor)
VALUES (NULL, 7, 48, 7, true, 0)
ON CONFLICT DO NOTHING;
