-- 1. Every journal entry balances (sum of debits = sum of credits), checked when the transaction commits.
CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0) INTO d, c
  FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debits %, credits %)', NEW.entry_id, d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
--> statement-breakpoint
-- 2. The ledger and its rules are append-only.
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_rules_append_only BEFORE UPDATE OR DELETE ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_settings_append_only BEFORE UPDATE OR DELETE ON finance_settings FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER settlements_append_only BEFORE UPDATE OR DELETE ON settlements FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- 3. A hold is released once; holds and payouts are never deleted.
CREATE OR REPLACE FUNCTION balance_holds_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at') THEN
    RAISE EXCEPTION 'Balance hold % can only be released once', OLD.order_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER balance_holds_guard BEFORE UPDATE ON balance_holds FOR EACH ROW EXECUTE FUNCTION balance_holds_guard();
--> statement-breakpoint
CREATE TRIGGER balance_holds_no_delete BEFORE DELETE ON balance_holds FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payouts_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.settlement_id <> OLD.settlement_id
     OR NEW.merchant_id <> OLD.merchant_id OR NEW.destination::text <> OLD.destination::text THEN
    RAISE EXCEPTION 'Payout %: amount and destination cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status::text, NEW.status::text) IN (
    ('requested', 'sent'), ('requested', 'failed'), ('sent', 'paid'), ('sent', 'failed')
  ) THEN
    RAISE EXCEPTION 'Payout %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payouts_guard BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_guard();
--> statement-breakpoint
CREATE TRIGGER payouts_no_delete BEFORE DELETE ON payouts FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS settlement_number_seq START 1;
--> statement-breakpoint
-- 4. Initial configuration: 8 % commission, 7-day hold before merchant money is available, no per-order fee.
INSERT INTO commission_rules (scope, bps, effective_from, reason) VALUES ('platform', 800, '2026-01-01T00:00:00Z', 'Initial ARUMA commission (8 %)');
--> statement-breakpoint
INSERT INTO finance_settings (key, value, effective_from, reason) VALUES
  ('hold_days', 7, '2026-01-01T00:00:00Z', 'Returns window before merchant money becomes available'),
  ('order_fee_minor', 0, '2026-01-01T00:00:00Z', 'No per-order fee at launch');
--> statement-breakpoint
-- 5. Store-merchant commissions that were never decided (the old default 0) now follow the rules.
UPDATE store_merchants SET commission_bps = NULL WHERE commission_bps = 0;
