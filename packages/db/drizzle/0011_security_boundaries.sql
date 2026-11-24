CREATE TABLE browser_auth_states (
  state_hash text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE rate_limits (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX rate_limits_expires_at_idx ON rate_limits(expires_at);
--> statement-breakpoint
CREATE TABLE storage_deletions (storage_key text PRIMARY KEY, available_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0);
CREATE INDEX storage_deletions_available_at_idx ON storage_deletions(available_at);
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN storage_generation text;
--> statement-breakpoint
ALTER TABLE trips DROP CONSTRAINT trips_date_range;
-- NOT VALID permits operators to inspect legacy invalid rows without blocking the security rollout;
-- PostgreSQL still enforces the constraint on every new/updated row.
ALTER TABLE trips ADD CONSTRAINT trips_date_range CHECK (end_date >= start_date AND end_date - start_date < 60) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION queue_attachment_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO storage_deletions(storage_key, available_at)
    VALUES (OLD.storage_key, GREATEST(now(), OLD.created_at + interval '16 minutes'))
    ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_cleanup AFTER DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION queue_attachment_deletion();
--> statement-breakpoint
CREATE INDEX browser_auth_states_expires_at_idx ON browser_auth_states(expires_at);
