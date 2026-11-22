import {
  ACCESS_CHANNELS,
  BOOKING_STATUSES,
  CONFIRM_SOURCES,
  ITEM_TYPES,
  TRIP_ROLES,
} from "@travelog/domain";
import { pgEnum } from "drizzle-orm/pg-core";

// 列舉值的唯一來源是 @travelog/domain，避免資料庫與商業邏輯不一致。
export const tripRole = pgEnum("trip_role", TRIP_ROLES);
export const itemType = pgEnum("item_type", ITEM_TYPES);
export const confirmSource = pgEnum("confirm_source", CONFIRM_SOURCES);
export const bookingStatus = pgEnum("booking_status", BOOKING_STATUSES);
export const accessChannel = pgEnum("access_channel", ACCESS_CHANNELS);

export const identityProvider = pgEnum("identity_provider", ["google", "apple"]);
export const tripStatus = pgEnum("trip_status", ["planning", "ongoing", "done", "archived"]);
export const bookingKind = pgEnum("booking_kind", [
  "flight",
  "lodging",
  "rail",
  "bus",
  "car",
  "ticket",
  "restaurant",
  "other",
]);
export const savedPlaceCategory = pgEnum("saved_place_category", [
  "food",
  "cafe",
  "sight",
  "shopping",
  "stay",
  "other",
]);
export const journalScope = pgEnum("journal_scope", ["trip", "day", "item"]);
export const journalVisibility = pgEnum("journal_visibility", ["members", "public"]);
