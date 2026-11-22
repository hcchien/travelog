-- 需要的 PostgreSQL extension。PostGIS 需先在系統安裝（macOS: brew install postgis）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
