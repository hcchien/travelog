import { geometry, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tstz, updatedAt } from "./columns.js";
import { accessChannel, journalScope, journalVisibility } from "./enums.js";
import { itineraryItems } from "./itinerary.js";
import { tripDays, trips } from "./trips.js";
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
  (t) => [
    index().on(t.tripId, t.scope, t.scopeId),
    // 每個人在同一個範圍（整趟／某天／某行程點）只有一篇心得
    unique("journal_entries_one_per_scope")
      .on(t.tripId, t.authorId, t.scope, t.scopeId)
      .nullsNotDistinct(),
  ],
);

/** 公開遊記的分享連結（ARCHITECTURE §5.2）。 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    options: jsonb("options").$type<{ hideLodging: boolean; journalOnly: boolean }>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    revokedAt: tstz("revoked_at"),
  },
  (t) => [index().on(t.tripId)],
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

/** 行中快速筆記（ARCHITECTURE §5.2）。 */
export const notes = pgTable(
  "notes",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    takenAt: tstz("taken_at").notNull().defaultNow(),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }),
    /** 依 taken_at 在行程時區的日期自動對應；行程外的日期為 null。 */
    dayId: uuid("day_id").references(() => tripDays.id, { onDelete: "set null" }),
    itemId: uuid("item_id").references(() => itineraryItems.id, { onDelete: "set null" }),
    mergedIntoEntryId: uuid("merged_into_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    /** App 離線佇列的 Idempotency-Key：重送時不會重複建立。 */
    clientKey: text("client_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.tripId, t.takenAt),
    unique("notes_author_client_key").on(t.authorId, t.clientKey),
  ],
);
