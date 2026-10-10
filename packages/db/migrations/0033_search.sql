CREATE TABLE "search_documents" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"visible" boolean NOT NULL,
	"slug" varchar(128) NOT NULL,
	"names" jsonb NOT NULL,
	"image" jsonb,
	"brand_id" uuid,
	"brand_slug" varchar(96),
	"brand_name" text,
	"category_ids" uuid[] DEFAULT '{}' NOT NULL,
	"merchant_ids" uuid[] DEFAULT '{}' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_stock" boolean DEFAULT false NOT NULL,
	"rating_avg" numeric(3, 2),
	"rating_count" integer DEFAULT 0 NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"name_norm" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"query" varchar(200) NOT NULL,
	"locale" varchar(16),
	"results" integer NOT NULL,
	"source" varchar(16) DEFAULT 'typed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queue" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"terms" text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_terms" (
	"store_id" uuid NOT NULL,
	"term" varchar(96) NOT NULL,
	"docs" integer NOT NULL,
	CONSTRAINT "search_terms_store_id_term_pk" PRIMARY KEY("store_id","term")
);
--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_synonyms" ADD CONSTRAINT "search_synonyms_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_synonyms" ADD CONSTRAINT "search_synonyms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_terms" ADD CONSTRAINT "search_terms_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_documents_store_idx" ON "search_documents" USING btree ("store_id","visible");--> statement-breakpoint
CREATE INDEX "search_queries_store_idx" ON "search_queries" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "search_synonyms_store_idx" ON "search_synonyms" USING btree ("store_id");