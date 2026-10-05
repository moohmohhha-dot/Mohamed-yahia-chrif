-- The dispute's messages, files and audit trail are append-only; disputes are never deleted.
CREATE TRIGGER dispute_messages_append_only BEFORE UPDATE OR DELETE ON dispute_messages FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER dispute_messages_no_truncate BEFORE TRUNCATE ON dispute_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER dispute_files_append_only BEFORE UPDATE OR DELETE ON dispute_files FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER dispute_files_no_truncate BEFORE TRUNCATE ON dispute_files FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER dispute_events_append_only BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER dispute_events_no_truncate BEFORE TRUNCATE ON dispute_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER disputes_no_delete BEFORE DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- Parties, claim and decisions are written once: a decision or an appeal decision is never rewritten.
CREATE OR REPLACE FUNCTION disputes_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.kind <> OLD.kind OR NEW.opened_by <> OLD.opened_by OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.customer_user_id IS DISTINCT FROM OLD.customer_user_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.description <> OLD.description OR NEW.subject <> OLD.subject THEN
    RAISE EXCEPTION 'Dispute %: parties and claim cannot change', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decision_text IS DISTINCT FROM OLD.decision_text OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'Dispute %: the decision cannot be rewritten', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.appeal_decided_by IS NOT NULL AND (NEW.appeal_decided_by IS DISTINCT FROM OLD.appeal_decided_by OR NEW.appeal_decision_text IS DISTINCT FROM OLD.appeal_decision_text) THEN
    RAISE EXCEPTION 'Dispute %: the appeal decision cannot be rewritten', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.appealed_at IS NOT NULL AND NEW.appealed_at IS DISTINCT FROM OLD.appealed_at THEN
    RAISE EXCEPTION 'Dispute %: only one appeal', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER disputes_guard BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION disputes_guard();
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS dispute_number_seq;
