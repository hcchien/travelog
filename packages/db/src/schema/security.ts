import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns.js";

/** Shared fixed-window budgets. Keys are hashes, never raw credentials or IP addresses. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull(),
  expiresAt: tstz("expires_at").notNull(),
}, (t) => [index().on(t.expiresAt)]);

/** Created by a DELETE trigger so FK cascades cannot discard an object key. */
export const storageDeletions = pgTable("storage_deletions", {
  storageKey: text("storage_key").primaryKey(),
  availableAt: tstz("available_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
}, (t) => [index().on(t.availableAt)]);
