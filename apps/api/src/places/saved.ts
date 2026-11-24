import { schema } from "@travelog/db";
import {
  assertCan,
  categoryFromPlaceTypes,
  normalizeTags,
  SAVED_PLACE_CATEGORIES,
} from "@travelog/domain";
import { createSavedPlaceInput, updateSavedPlaceInput } from "@travelog/schema";
import { and, arrayContains, asc, count, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { loadTrip } from "../trips/access.js";
import { type PlaceMetadata, resolvePlace, serializePlace } from "./resolve.js";

type SavedRow = typeof schema.savedPlaces.$inferSelect;
type PlaceRow = typeof schema.places.$inferSelect;

const UNKNOWN_CITY = { cityKey: "unknown", cityName: "其他" };

const serializeSaved = (s: SavedRow, p: PlaceRow) => ({
  id: s.id,
  cityKey: s.cityKey,
  cityName: s.cityName,
  category: s.category,
  tags: s.tags,
  rating: s.rating ?? null,
  privateNote: s.privateNote,
  place: serializePlace(p),
  createdAt: s.createdAt,
});

/**
 * 我的地點庫：個人、跨行程。只有本人可讀寫（ARCHITECTURE §5.6）。
 */
export function savedPlaceRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  app.get("/v1/me/saved-places/cities", auth, async (c) => {
    const { userId } = c.get("auth");
    const rows = await db
      .select({
        cityKey: schema.savedPlaces.cityKey,
        cityName: schema.savedPlaces.cityName,
        count: count(),
      })
      .from(schema.savedPlaces)
      .where(eq(schema.savedPlaces.userId, userId))
      .groupBy(schema.savedPlaces.cityKey, schema.savedPlaces.cityName)
      .orderBy(desc(count()), asc(schema.savedPlaces.cityName));
    return c.json({ cities: rows });
  });

  app.get("/v1/me/saved-places", auth, async (c) => {
    const me = c.get("auth");
    const conditions: SQL[] = [eq(schema.savedPlaces.userId, me.userId)];
    const city = c.req.query("city");
    const category = c.req.query("category");
    const tag = c.req.query("tag");
    const minRating = c.req.query("minRating");
    const tripId = c.req.query("tripId");

    if (city) conditions.push(eq(schema.savedPlaces.cityKey, city));
    if (category) {
      if (!(SAVED_PLACE_CATEGORIES as readonly string[]).includes(category)) {
        return c.json({ items: [] });
      }
      conditions.push(eq(schema.savedPlaces.category, category as SavedRow["category"]));
    }
    if (tag) conditions.push(arrayContains(schema.savedPlaces.tags, [tag]));
    if (minRating) {
      const n = Number(minRating);
      if (Number.isInteger(n) && n >= 1 && n <= 5) {
        conditions.push(gte(schema.savedPlaces.rating, n));
      }
    }
    if (tripId) {
      // 依行程目的地篩選；必須是該行程成員
      const { trip, ctx } = await loadTrip(db, tripId, me);
      assertCan(ctx, "trip.view");
      const keys = trip.destinations.map((d) => d.cityKey);
      if (keys.length === 0) return c.json({ items: [] });
      conditions.push(inArray(schema.savedPlaces.cityKey, keys));
    }

    const rows = await db
      .select({ saved: schema.savedPlaces, place: schema.places })
      .from(schema.savedPlaces)
      .innerJoin(schema.places, eq(schema.places.id, schema.savedPlaces.placeId))
      .where(and(...conditions))
      .orderBy(
        asc(schema.savedPlaces.cityName),
        sql`${schema.savedPlaces.rating} DESC NULLS LAST`,
        desc(schema.savedPlaces.createdAt),
      );
    return c.json({ items: rows.map((r) => serializeSaved(r.saved, r.place)) });
  });

  app.post("/v1/me/saved-places", auth, validate("json", createSavedPlaceInput), async (c) => {
    const { userId } = c.get("auth");
    const input = c.req.valid("json");
    const place = await resolvePlace(db, deps.places, input.googlePlaceId, {
      sessionToken: input.sessionToken,
      now,
    });
    const meta = place.metadata as PlaceMetadata;
    const city =
      place.cityKey && meta.cityName
        ? { cityKey: place.cityKey, cityName: meta.cityName }
        : UNKNOWN_CITY;
    const [row] = await db
      .insert(schema.savedPlaces)
      .values({
        userId,
        placeId: place.id,
        ...city,
        category: input.category ?? categoryFromPlaceTypes(meta.types ?? []),
        tags: normalizeTags(input.tags),
        rating: input.rating ?? null,
        privateNote: input.privateNote,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [existing] = await db
        .select({ id: schema.savedPlaces.id })
        .from(schema.savedPlaces)
        .where(
          and(eq(schema.savedPlaces.userId, userId), eq(schema.savedPlaces.placeId, place.id)),
        );
      throw conflict("這個地點已經在你的地點庫裡", { savedPlaceId: existing?.id });
    }
    return c.json(serializeSaved(row, place), 201);
  });

  app.patch("/v1/me/saved-places/:id", auth, validate("json", updateSavedPlaceInput), async (c) => {
    const { userId } = c.get("auth");
    const patch = c.req.valid("json");
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("我的地點");
    const [row] = await db
      .update(schema.savedPlaces)
      .set({ ...patch, ...(patch.tags ? { tags: normalizeTags(patch.tags) } : {}) })
      .where(and(eq(schema.savedPlaces.id, id), eq(schema.savedPlaces.userId, userId)))
      .returning();
    if (!row) throw notFound("我的地點");
    const [place] = await db.select().from(schema.places).where(eq(schema.places.id, row.placeId));
    return c.json(serializeSaved(row, place as PlaceRow));
  });

  app.delete("/v1/me/saved-places/:id", auth, async (c) => {
    const { userId } = c.get("auth");
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("我的地點");
    const rows = await db
      .delete(schema.savedPlaces)
      .where(and(eq(schema.savedPlaces.id, id), eq(schema.savedPlaces.userId, userId)))
      .returning({ id: schema.savedPlaces.id });
    if (rows.length === 0) throw notFound("我的地點");
    return c.body(null, 204);
  });

  return app;
}
