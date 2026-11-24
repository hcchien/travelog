import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, sortKey, tstz, updatedAt } from "./columns.js";
import { bookingKind, bookingStatus, confirmSource, itemType } from "./enums.js";
import { places } from "./places.js";
import { tripDays, trips } from "./trips.js";
import { users } from "./users.js";

export const itineraryItems = pgTable(
  "itinerary_items",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /**
     * null 表示尚未排入某一天。刪除某一天時，必須先把該天的行程點移走（NO ACTION），
     * 避免縮短行程日期時，已訂位的行程點被默默移出。
     */
    dayId: uuid("day_id").references(() => tripDays.id),
    type: itemType("type").notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    placeId: uuid("place_id").references(() => places.id),
    startAt: tstz("start_at"),
    endAt: tstz("end_at"),
    /** 事件所在地的 IANA 時區，顯示時以此為準。 */
    tz: text("tz").notNull(),
    sortKey: sortKey("sort_key").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    /** 不為 null 即為已確定（釘選），見 ARCHITECTURE §5.5。 */
    confirmedAt: tstz("confirmed_at"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmSource: confirmSource("confirm_source"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "itinerary_items_confirm_consistent",
      sql`(${t.confirmedAt} IS NULL) = (${t.confirmSource} IS NULL)`,
    ),
    check(
      "itinerary_items_time_order",
      sql`${t.endAt} IS NULL OR ${t.startAt} IS NULL OR ${t.endAt} >= ${t.startAt}`,
    ),
    index().on(t.tripId, t.dayId, t.sortKey),
  ],
);

export const bookings = pgTable("bookings", {
  id: id(),
  itemId: uuid("item_id")
    .notNull()
    .unique()
    .references(() => itineraryItems.id, { onDelete: "cascade" }),
  kind: bookingKind("kind").notNull(),
  status: bookingStatus("status").notNull().default("planned"),
  confirmationCode: text("confirmation_code"),
  provider: text("provider"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    note: text("note"),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique("wishlist_items_trip_place").on(t.tripId, t.placeId)],
);

export const wishlistVotes = pgTable(
  "wishlist_votes",
  {
    wishlistItemId: uuid("wishlist_item_id")
      .notNull()
      .references(() => wishlistItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [unique("wishlist_votes_once").on(t.wishlistItemId, t.userId)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => itineraryItems.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull().unique(),
    storageGeneration: text("storage_generation"),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** 行中模式是否預先下載供離線查看。 */
    offline: boolean("offline").notNull().default(false),
    status: text("status").notNull().default("pending"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("attachments_status", sql`${t.status} IN ('pending', 'ready')`),
    check("attachments_size", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 10485760`),
    index().on(t.tripId),
  ],
);
