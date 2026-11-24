ALTER TABLE "saved_places" ADD COLUMN "rating" smallint;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_rating_check" CHECK ("rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5));
