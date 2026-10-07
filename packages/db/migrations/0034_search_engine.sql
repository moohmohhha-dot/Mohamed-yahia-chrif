-- Fuzzy matching (typo correction, autocomplete). pg_trgm is a trusted extension: no superuser needed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (tsv);
--> statement-breakpoint
CREATE INDEX search_documents_name_trgm_idx ON search_documents USING gin (name_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX search_documents_merchants_idx ON search_documents USING gin (merchant_ids);
--> statement-breakpoint
CREATE INDEX search_documents_categories_idx ON search_documents USING gin (category_ids);
--> statement-breakpoint
CREATE INDEX search_terms_trgm_idx ON search_terms USING gin (term gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX search_queries_text_idx ON search_queries USING gin (query gin_trgm_ops);
--> statement-breakpoint

-- Every change a customer could see queues the products concerned; the indexer rebuilds them.
CREATE OR REPLACE FUNCTION search_enqueue(ids uuid[]) RETURNS void AS $$
BEGIN
  INSERT INTO search_queue (product_id) SELECT DISTINCT unnest(ids) ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION search_queue_product() RETURNS trigger AS $$
DECLARE
  cat_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    PERFORM search_enqueue(ARRAY[COALESCE(NEW.id, OLD.id)]);
  ELSIF TG_TABLE_NAME IN ('product_translations', 'product_variants', 'product_categories', 'product_images') THEN
    PERFORM search_enqueue(ARRAY[COALESCE(NEW.product_id, OLD.product_id)]);
  ELSIF TG_TABLE_NAME = 'reviews' THEN
    IF COALESCE(NEW.product_id, OLD.product_id) IS NOT NULL THEN PERFORM search_enqueue(ARRAY[COALESCE(NEW.product_id, OLD.product_id)]); END IF;
  ELSIF TG_TABLE_NAME = 'offers' THEN
    PERFORM search_enqueue(ARRAY(SELECT product_id FROM product_variants WHERE id IN (NEW.variant_id, OLD.variant_id)));
  ELSIF TG_TABLE_NAME = 'offer_prices' THEN
    PERFORM search_enqueue(ARRAY(SELECT v.product_id FROM offers o JOIN product_variants v ON v.id = o.variant_id WHERE o.id IN (NEW.offer_id, OLD.offer_id)));
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    PERFORM search_enqueue(ARRAY(SELECT v.product_id FROM offers o JOIN product_variants v ON v.id = o.variant_id WHERE o.merchant_id = NEW.id));
  ELSIF TG_TABLE_NAME = 'store_merchants' THEN
    PERFORM search_enqueue(ARRAY(SELECT v.product_id FROM offers o JOIN product_variants v ON v.id = o.variant_id WHERE o.merchant_id = NEW.merchant_id AND o.store_id = NEW.store_id));
  ELSIF TG_TABLE_NAME = 'brands' THEN
    PERFORM search_enqueue(ARRAY(SELECT id FROM products WHERE brand_id = NEW.id));
  ELSIF TG_TABLE_NAME IN ('categories', 'category_translations') THEN
    -- Separate branches: category_translations has no id column, categories no category_id.
    IF TG_TABLE_NAME = 'categories' THEN
      cat_id := COALESCE(NEW.id, OLD.id);
    ELSE
      cat_id := COALESCE(NEW.category_id, OLD.category_id);
    END IF;
    PERFORM search_enqueue(ARRAY(
      WITH RECURSIVE tree AS (
        SELECT id FROM categories WHERE id = cat_id
        UNION SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
      )
      SELECT pc.product_id FROM product_categories pc JOIN tree t ON t.id = pc.category_id));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER search_queue_products AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_product_translations AFTER INSERT OR UPDATE OR DELETE ON product_translations FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_product_variants AFTER INSERT OR UPDATE OR DELETE ON product_variants FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_product_categories AFTER INSERT OR UPDATE OR DELETE ON product_categories FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_product_images AFTER INSERT OR UPDATE OR DELETE ON product_images FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_reviews AFTER INSERT OR UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_offers AFTER INSERT OR UPDATE OR DELETE ON offers FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_offer_prices AFTER INSERT OR UPDATE OR DELETE ON offer_prices FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_merchants AFTER UPDATE ON merchants FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.verification_status IS DISTINCT FROM NEW.verification_status OR OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_store_merchants AFTER INSERT OR UPDATE ON store_merchants FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_brands AFTER UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_categories AFTER UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
CREATE TRIGGER search_queue_category_translations AFTER INSERT OR UPDATE OR DELETE ON category_translations FOR EACH ROW EXECUTE FUNCTION search_queue_product();
--> statement-breakpoint
-- Everything that exists today goes into the index once.
INSERT INTO search_queue (product_id) SELECT id FROM products ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Starter synonyms for perfumes, across Arabic, French and English (ARUMA edits them in the Admin Panel).
INSERT INTO search_synonyms (terms) VALUES
  (ARRAY['عطر','عطور','parfum','perfume','fragrance']),
  (ARRAY['عود','oud','agarwood']),
  (ARRAY['مسك','musc','musk']),
  (ARRAY['عنبر','ambre','amber']),
  (ARRAY['ورد','وردة','rose']),
  (ARRAY['ياسمين','jasmin','jasmine']),
  (ARRAY['فانيليا','vanille','vanilla']),
  (ARRAY['زعفران','safran','saffron']),
  (ARRAY['خشب','خشبي','bois','boise','wood','woody']),
  (ARRAY['زهري','زهور','floral','fleur','flower']),
  (ARRAY['منعش','frais','fraiche','fresh']),
  (ARRAY['شرقي','oriental']),
  (ARRAY['بحري','marin','marine']),
  (ARRAY['رجالي','رجال','homme','hommes','men','man','masculin']),
  (ARRAY['نسائي','نساء','femme','femmes','women','woman','feminin']),
  (ARRAY['هدية','cadeau','gift']),
  (ARRAY['كولونيا','cologne']);
