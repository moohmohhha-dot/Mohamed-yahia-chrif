-- A product taken off sale by ARUMA cannot be published again until ARUMA unblocks it.
ALTER TABLE "products" ADD CONSTRAINT "products_blocked_not_active" CHECK ("blocked_at" IS NULL OR "status" <> 'active');
