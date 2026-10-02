-- Tracking history is append-only: what a courier or merchant reported stays visible.
CREATE TRIGGER shipment_events_append_only BEFORE UPDATE OR DELETE ON shipment_events FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER shipment_events_no_truncate BEFORE TRUNCATE ON shipment_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Shipments: never deleted; who/what/where is frozen; status moves only along the allowed transitions
-- (same table as apps/core/src/modules/shipping/statuses.ts).
CREATE OR REPLACE FUNCTION shipments_guard() RETURNS trigger AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shipments cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.merchant_id <> OLD.merchant_id OR NEW.method_type <> OLD.method_type
     OR NEW.destination <> OLD.destination OR NEW.cod_amount_minor <> OLD.cod_amount_minor OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'Shipment % : order, destination and amounts cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.tracking_number IS NOT NULL AND NEW.tracking_number IS DISTINCT FROM OLD.tracking_number AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Shipment % : the tracking number cannot change once the parcel has left', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'pending' THEN ARRAY['ready_for_pickup', 'in_transit', 'out_for_delivery', 'cancelled']
      WHEN 'ready_for_pickup' THEN ARRAY['delivered', 'returned']
      WHEN 'in_transit' THEN ARRAY['out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned']
      WHEN 'out_for_delivery' THEN ARRAY['delivered', 'delivery_failed', 'returning', 'returned']
      WHEN 'delivery_failed' THEN ARRAY['in_transit', 'out_for_delivery', 'delivered', 'returning', 'returned']
      WHEN 'delivered' THEN ARRAY['returning', 'returned']
      WHEN 'returning' THEN ARRAY['returned']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.status::text = ANY (allowed)) THEN
      RAISE EXCEPTION 'Shipment % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER shipments_guard BEFORE UPDATE OR DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION shipments_guard();
--> statement-breakpoint
CREATE TRIGGER shipments_no_truncate BEFORE TRUNCATE ON shipments FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Courier companies operating in Algeria. Tracking is entered by hand until an API integration is
-- built and tested with a real account (see docs/SHIPPING.md). The platform can add others.
INSERT INTO currencies (code, name, minor_units) VALUES ('DZD', 'Algerian Dinar', 2) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO countries (code, name, default_currency) VALUES ('DZ', 'Algeria', 'DZD') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO couriers (code, name, country, integration) VALUES
  ('yalidine', 'Yalidine Express', 'DZ', 'manual'),
  ('zr_express', 'ZR Express', 'DZ', 'manual'),
  ('maystro', 'Maystro Delivery', 'DZ', 'manual')
ON CONFLICT DO NOTHING;
