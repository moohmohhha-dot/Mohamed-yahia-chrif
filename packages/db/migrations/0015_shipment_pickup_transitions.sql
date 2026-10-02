-- Parcels for relay points / courier desks: on the road, then waiting at the desk; not collected, then sent back.
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
      WHEN 'ready_for_pickup' THEN ARRAY['delivered', 'returning', 'returned']
      WHEN 'in_transit' THEN ARRAY['ready_for_pickup', 'out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned']
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
