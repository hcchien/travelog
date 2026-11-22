CREATE TABLE "push_dispatches" (
	"key" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_index" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_client_key" UNIQUE("author_id","client_key");