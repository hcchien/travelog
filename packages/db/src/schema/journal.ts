import { index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tstz, updatedAt } from "./columns.js";
import { accessChannel, journalScope, journalVisibility } from "./enums.js";
import { trips } from "./trips.js";
import { users } from "./users.js";

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    scope: journalScope("scope").notNull(),
    /** scope 為 day 時指向 trip_days.id，為 item 時指向 itinerary_items.id。 */
    scopeId: uuid("scope_id"),
    title: text("title"),
    /** Tiptap/ProseMirror JSON，schema 限定文字節點。 */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    /** 純文字版本，供搜尋與 MCP／AI 使用。 */
    bodyText: text("body_text").notNull().default(""),
    visibility: journalVisibility("visibility").notNull().default("members"),
    publishedAt: tstz("published_at"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.tripId, t.scope, t.scopeId)],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    via: accessChannel("via").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.tripId, t.createdAt)],
);
