import { geometry, index, jsonb, pgTable, smallint, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tstz } from "./columns.js";
import { savedPlaceCategory } from "./enums.js";
import { users } from "./users.js";

/**
 * Google 地點的本地快取。依 Google Maps Platform 條款，只有 google_place_id 可長期保存，
 * 其他欄位需定期刷新（fetched_at）。
 */
export const places = pgTable(
  "places",
  {
    id: id(),
    googlePlaceId: text("google_place_id").notNull().unique(),
    name: text("name").notNull(),
    address: text("address"),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }),
    tz: text("tz"),
    cityKey: text("city_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
  },
  (t) => [index("places_location_gist").using("gist", t.location), index().on(t.cityKey)],
);

/** 我的地點庫：個人、跨行程（ARCHITECTURE §5.6）。 */
export const savedPlaces = pgTable(
  "saved_places",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    cityKey: text("city_key").notNull(),
    cityName: text("city_name").notNull(),
    category: savedPlaceCategory("category").notNull().default("other"),
    tags: text("tags").array().notNull().default([]),
    /** 個人評分 1–5 顆星（null 表示尚未評分）。 */
    rating: smallint("rating"),
    /** 只有本人看得到；加入行程時預設不帶入。 */
    privateNote: text("private_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("saved_places_user_place").on(t.userId, t.placeId),
    index().on(t.userId, t.cityKey),
  ],
);
