import { type DbOrTx, schema } from "@travelog/db";
import { assertCan, itemTypeFromPlaceTypes } from "@travelog/domain";
import { addWishlistInput, scheduleWishlistInput } from "@travelog/schema";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { type PlaceMetadata, resolvePlace, serializePlace } from "../places/resolve.js";
import { etag, loadTrip, logActivity } from "./access.js";
import { assertDayInTrip, present, sortKeyAt } from "./items.js";

export function wishlistRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  async function loadEntry(conn: DbOrTx, tripId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("想去清單項目");
    const [row] = await conn
      .select({ entry: schema.wishlistItems, place: schema.places })
      .from(schema.wishlistItems)
      .innerJoin(schema.places, eq(schema.places.id, schema.wishlistItems.placeId))
      .where(and(eq(schema.wishlistItems.id, id), eq(schema.wishlistItems.tripId, tripId)));
    if (!row) throw notFound("想去清單項目");
    return row;
  }

  app.get("/v1/trips/:tripId/wishlist", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.view");
    const votes = db
      .select({
        wishlistItemId: schema.wishlistVotes.wishlistItemId,
        count: sql<number>`count(*)::int`.as("count"),
        mine: sql<boolean>`bool_or(${schema.wishlistVotes.userId} = ${me.userId})`.as("mine"),
      })
      .from(schema.wishlistVotes)
      .groupBy(schema.wishlistVotes.wishlistItemId)
      .as("votes");
    const rows = await db
      .select({
        entry: schema.wishlistItems,
        place: schema.places,
        addedByName: schema.users.displayName,
        votes: votes.count,
        mine: votes.mine,
      })
      .from(schema.wishlistItems)
      .innerJoin(schema.places, eq(schema.places.id, schema.wishlistItems.placeId))
      .innerJoin(schema.users, eq(schema.users.id, schema.wishlistItems.addedBy))
      .leftJoin(votes, eq(votes.wishlistItemId, schema.wishlistItems.id))
      .where(eq(schema.wishlistItems.tripId, trip.id));
    const items = rows
      .map((r) => ({
        id: r.entry.id,
        note: r.entry.note,
        place: serializePlace(r.place),
        addedBy: { userId: r.entry.addedBy, displayName: r.addedByName },
        votes: r.votes ?? 0,
        votedByMe: r.mine ?? false,
        createdAt: r.entry.createdAt,
      }))
      .sort((a, b) => b.votes - a.votes || a.createdAt.getTime() - b.createdAt.getTime());
    return c.json({ items });
  });

  app.post("/v1/trips/:tripId/wishlist", auth, validate("json", addWishlistInput), async (c) => {
    const me = c.get("auth");
    const input = c.req.valid("json");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "wishlist.edit");

    let placeId: string;
    let note = input.note;
    if (input.savedPlaceId) {
      const [saved] = await db
        .select()
        .from(schema.savedPlaces)
        .where(
          and(
            eq(schema.savedPlaces.id, input.savedPlaceId),
            eq(schema.savedPlaces.userId, me.userId),
          ),
        );
      if (!saved) throw notFound("我的地點");
      placeId = saved.placeId;
      if (input.includePrivateNote && saved.privateNote) {
        note = note ? `${note}\n${saved.privateNote}` : saved.privateNote;
      }
    } else {
      const place = await resolvePlace(db, deps.places, input.googlePlaceId as string, {
        sessionToken: input.sessionToken,
        now,
      });
      placeId = place.id;
    }

    const [entry] = await db
      .insert(schema.wishlistItems)
      .values({ tripId: trip.id, placeId, note, addedBy: me.userId })
      .onConflictDoNothing()
      .returning();
    if (!entry) throw conflict("這個地點已經在想去清單裡");
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: "wishlist.added",
      targetType: "wishlist_item",
      targetId: entry.id,
    });
    const { place } = await loadEntry(db, trip.id, entry.id);
    return c.json(
      {
        id: entry.id,
        note: entry.note,
        place: serializePlace(place),
        addedBy: { userId: me.userId },
        votes: 0,
        votedByMe: false,
        createdAt: entry.createdAt,
      },
      201,
    );
  });

  app.delete("/v1/trips/:tripId/wishlist/:id", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "wishlist.edit");
    const { entry } = await loadEntry(db, trip.id, c.req.param("id"));
    await db.delete(schema.wishlistItems).where(eq(schema.wishlistItems.id, entry.id));
    return c.body(null, 204);
  });

  // 投票：所有成員都可以（包含檢視者）
  app.post("/v1/trips/:tripId/wishlist/:id/vote", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.view");
    const { entry } = await loadEntry(db, trip.id, c.req.param("id"));
    await db
      .insert(schema.wishlistVotes)
      .values({ wishlistItemId: entry.id, userId: me.userId })
      .onConflictDoNothing();
    return c.body(null, 204);
  });

  app.delete("/v1/trips/:tripId/wishlist/:id/vote", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.view");
    const { entry } = await loadEntry(db, trip.id, c.req.param("id"));
    await db
      .delete(schema.wishlistVotes)
      .where(
        and(
          eq(schema.wishlistVotes.wishlistItemId, entry.id),
          eq(schema.wishlistVotes.userId, me.userId),
        ),
      );
    return c.body(null, 204);
  });

  // 排入某一天：建立行程點，預設從想去清單移除
  app.post(
    "/v1/trips/:tripId/wishlist/:id/schedule",
    auth,
    validate("json", scheduleWishlistInput),
    async (c) => {
      const me = c.get("auth");
      const { dayId, index, keepInWishlist } = c.req.valid("json");
      const result = await db.transaction(async (tx) => {
        const { trip, ctx } = await loadTrip(tx, c.req.param("tripId"), me);
        assertCan(ctx, "item.create");
        if (!keepInWishlist) assertCan(ctx, "wishlist.edit");
        const { entry, place } = await loadEntry(tx, trip.id, c.req.param("id"));
        await assertDayInTrip(tx, trip.id, dayId);
        const { sortKey } = await sortKeyAt(tx, trip.id, dayId, index);
        const [item] = await tx
          .insert(schema.itineraryItems)
          .values({
            tripId: trip.id,
            dayId,
            type: itemTypeFromPlaceTypes((place.metadata as PlaceMetadata).types ?? []),
            title: place.name,
            notes: entry.note,
            placeId: place.id,
            tz: place.tz ?? trip.primaryTz,
            sortKey,
            createdBy: me.userId,
          })
          .returning();
        if (!item) throw new Error("建立行程點失敗");
        if (!keepInWishlist) {
          await tx.delete(schema.wishlistItems).where(eq(schema.wishlistItems.id, entry.id));
        }
        await logActivity(tx, {
          tripId: trip.id,
          actorId: me.userId,
          via: me.via,
          action: "wishlist.scheduled",
          targetType: "itinerary_item",
          targetId: item.id,
          diff: { wishlistItemId: entry.id, dayId },
        });
        return item;
      });
      c.header("ETag", etag(result.version));
      return c.json({ item: await present(db, result, null), warnings: [] }, 201);
    },
  );

  return app;
}
