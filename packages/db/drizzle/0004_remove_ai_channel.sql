ALTER TABLE "activity_log" ALTER COLUMN "via" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."access_channel";--> statement-breakpoint
CREATE TYPE "public"."access_channel" AS ENUM('web', 'app', 'mcp');--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "via" SET DATA TYPE "public"."access_channel" USING "via"::"public"."access_channel";