-- Review history and reports are kept: events are append-only, reports and reviews are never deleted
-- (authors withdraw, moderators hide).
CREATE TRIGGER review_events_append_only BEFORE UPDATE OR DELETE ON review_events FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER review_events_no_truncate BEFORE TRUNCATE ON review_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER review_reports_no_delete BEFORE DELETE ON review_reports FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- Who wrote what, about which purchase, cannot be changed afterwards.
CREATE OR REPLACE FUNCTION reviews_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.type <> OLD.type OR NEW.customer_user_id <> OLD.customer_user_id OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.verified_purchase <> OLD.verified_purchase OR NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION 'Review %: author, target and purchase cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER reviews_guard BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION reviews_guard();
