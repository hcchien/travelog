CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"options" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "share_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_links_trip_id_index" ON "share_links" USING btree ("trip_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_one_per_scope" UNIQUE NULLS NOT DISTINCT("trip_id","author_id","scope","scope_id");