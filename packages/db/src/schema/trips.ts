import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, tstz, updatedAt } from "./columns.js";
import { tripRole, tripStatus } from "./enums.js";
import { users } from "./users.js";

export interface TripDestination {
  cityKey: string;
  name: string;
}

export const trips = pgTable(
  "trips",
  {
    id: id(),
    title: text("title").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    primaryTz: text("primary_tz").notNull(),
    destinations: jsonb("destinations").$type<TripDestination[]>().notNull().default([]),
    /** 封面：內建圖庫的 key 或配色名稱。 */
    cover: text("cover"),
    status: tripStatus("status").notNull().default("planning"),
    viewerCanWriteJournal: boolean("viewer_can_write_journal").notNull().default(true),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("trips_date_range", sql`${t.endDate} >= ${t.startDate}`), index().on(t.ownerId)],
);

export const tripMembers = pgTable(
  "trip_members",
  {
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tripRole("role").notNull(),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.userId] }), index().on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** SHA-256(token)；原始 token 只出現在邀請連結中。 */
    tokenHash: text("token_hash").notNull().unique(),
    role: tripRole("role").notNull(),
    email: text("email"),
    expiresAt: tstz("expires_at"),
    revokedAt: tstz("revoked_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    acceptedAt: tstz("accepted_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [check("invitations_no_owner", sql`${t.role} <> 'owner'`), index().on(t.tripId)],
);

export const tripDays = pgTable(
  "trip_days",
  {
    id: id(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    title: text("title"),
    notes: text("notes"),
  },
  (t) => [unique("trip_days_trip_date").on(t.tripId, t.date)],
);
