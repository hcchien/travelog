import { schema, type Transaction } from "@travelog/db";
import { assertCan } from "@travelog/domain";
import { createTripInput, updateTripInput } from "@travelog/schema";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { conflict } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { etag, loadTrip, logActivity, requireIfMatch, type TripRow } from "./access.js";
import { datesBetween } from "./days.js";

export const serializeTrip = (t: TripRow) => ({
  id: t.id,
  title: t.title,
  startDate: t.startDate,
  endDate: t.endDate,
  primaryTz: t.primaryTz,
  destinations: t.destinations,
  cover: t.cover,
  status: t.status,
  ownerId: t.ownerId,
  viewerCanWriteJournal: t.viewerCanWriteJournal,
  version: t.version,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export function tripRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  const auth = requireAuth(deps);

  app.post("/v1/trips", auth, validate("json", createTripInput), async (c) => {
    const me = c.get("auth");
    const input = c.req.valid("json");
    const result = await db.transaction(async (tx) => {
      const [trip] = await tx
        .insert(schema.trips)
        .values({ ...input, ownerId: me.userId })
        .returning();
      if (!trip) throw new Error("建立行程失敗");
      await tx
        .insert(schema.tripMembers)
        .values({ tripId: trip.id, userId: me.userId, role: "owner" });
      const days = await tx
        .insert(schema.tripDays)
        .values(
          datesBetween(trip.startDate, trip.endDate).map((date) => ({ tripId: trip.id, date })),
        )
        .returning();
      await logActivity(tx, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "trip.created",
        targetType: "trip",
        targetId: trip.id,
      });
      return { trip, days };
    });
    c.header("ETag", etag(result.trip.version));
    return c.json(
      { ...serializeTrip(result.trip), myRole: "owner", days: result.days.sort(byDate) },
      201,
    );
  });

  app.get("/v1/trips", auth, async (c) => {
    const me = c.get("auth");
    const rows = await db
      .select({ trip: schema.trips, role: schema.tripMembers.role })
      .from(schema.tripMembers)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.tripMembers.tripId))
      .where(eq(schema.tripMembers.userId, me.userId))
      .orderBy(desc(schema.trips.startDate));
    return c.json({ trips: rows.map((r) => ({ ...serializeTrip(r.trip), myRole: r.role })) });
  });

  app.get("/v1/trips/:tripId", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const [days, members] = await Promise.all([
      db
        .select()
        .from(schema.tripDays)
        .where(eq(schema.tripDays.tripId, trip.id))
        .orderBy(asc(schema.tripDays.date)),
      db
        .select({
          userId: schema.users.id,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
          role: schema.tripMembers.role,
        })
        .from(schema.tripMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.tripMembers.userId))
        .where(eq(schema.tripMembers.tripId, trip.id)),
    ]);
    c.header("ETag", etag(trip.version));
    return c.json({ ...serializeTrip(trip), myRole: ctx.role, days, members });
  });

  app.patch("/v1/trips/:tripId", auth, validate("json", updateTripInput), async (c) => {
    const me = c.get("auth");
    const input = c.req.valid("json");
    const updated = await db.transaction(async (tx) => {
      const { trip, ctx } = await loadTrip(tx, c.req.param("tripId"), me);
      assertCan(ctx, "trip.update");
      if (input.viewerCanWriteJournal !== undefined) assertCan(ctx, "member.manage");
      requireIfMatch(c, trip.version);

      const startDate = input.startDate ?? trip.startDate;
      const endDate = input.endDate ?? trip.endDate;
      if (endDate < startDate) throw conflict("結束日期不能早於開始日期");

      if (startDate !== trip.startDate || endDate !== trip.endDate) {
        await syncDays(tx, trip.id, datesBetween(startDate, endDate));
      }

      const [row] = await tx
        .update(schema.trips)
        .set({ ...input, version: trip.version + 1 })
        .where(eq(schema.trips.id, trip.id))
        .returning();
      if (!row) throw new Error("更新行程失敗");
      await logActivity(tx, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "trip.updated",
        targetType: "trip",
        targetId: trip.id,
        diff: input,
      });
      return { trip: row, role: ctx.role };
    });
    c.header("ETag", etag(updated.trip.version));
    return c.json({ ...serializeTrip(updated.trip), myRole: updated.role });
  });

  app.delete("/v1/trips/:tripId", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.delete");
    await db.delete(schema.trips).where(eq(schema.trips.id, trip.id));
    return c.body(null, 204);
  });

  return app;
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);

/**
 * 依新的日期區間增減 trip_days。被移除的日子如果還有行程點，回 409 並列出這些日子，
 * 由使用者先把行程點移走（已確定的行程點必須先解除確定）。
 */
async function syncDays(tx: Transaction, tripId: string, wanted: string[]) {
  const existing = await tx
    .select({ id: schema.tripDays.id, date: schema.tripDays.date })
    .from(schema.tripDays)
    .where(eq(schema.tripDays.tripId, tripId));
  const wantedSet = new Set(wanted);
  const removed = existing.filter((d) => !wantedSet.has(d.date));

  if (removed.length > 0) {
    const removedIds = removed.map((d) => d.id);
    const busy = await tx
      .select({ dayId: schema.itineraryItems.dayId, n: count() })
      .from(schema.itineraryItems)
      .where(
        and(
          eq(schema.itineraryItems.tripId, tripId),
          inArray(schema.itineraryItems.dayId, removedIds),
        ),
      )
      .groupBy(schema.itineraryItems.dayId);
    if (busy.length > 0) {
      const busyDates = removed
        .filter((d) => busy.some((b) => b.dayId === d.id))
        .map((d) => d.date);
      throw conflict("這些日子還有行程點，請先移到其他天", { dates: busyDates.sort() });
    }
    await tx.delete(schema.tripDays).where(inArray(schema.tripDays.id, removedIds));
  }

  const have = new Set(existing.map((d) => d.date));
  const added = wanted.filter((d) => !have.has(d));
  if (added.length > 0) {
    await tx.insert(schema.tripDays).values(added.map((date) => ({ tripId, date })));
  }
}
