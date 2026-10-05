ALTER TABLE "disputes" ADD COLUMN "appeal_new_outcome" "dispute_outcome";--> statement-breakpoint
-- A closed dispute (resolved or withdrawn) is final: its status, remedy and appeal result never change.
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
  IF OLD.appeal_decided_by IS NOT NULL AND (NEW.appeal_decided_by IS DISTINCT FROM OLD.appeal_decided_by OR NEW.appeal_decision_text IS DISTINCT FROM OLD.appeal_decision_text
     OR NEW.appeal_outcome IS DISTINCT FROM OLD.appeal_outcome OR NEW.appeal_new_outcome IS DISTINCT FROM OLD.appeal_new_outcome) THEN
    RAISE EXCEPTION 'Dispute %: the appeal decision cannot be rewritten', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.appealed_at IS NOT NULL AND NEW.appealed_at IS DISTINCT FROM OLD.appealed_at THEN
    RAISE EXCEPTION 'Dispute %: only one appeal', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('resolved', 'withdrawn') AND (NEW.status <> OLD.status OR NEW.remedy IS DISTINCT FROM OLD.remedy
     OR NEW.remedy_amount_minor IS DISTINCT FROM OLD.remedy_amount_minor) THEN
    RAISE EXCEPTION 'Dispute %: a closed dispute is final', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
