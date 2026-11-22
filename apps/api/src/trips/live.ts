import { schema } from "@travelog/db";
import { assertCan, dateInTimeZone, ForbiddenError } from "@travelog/domain";
import { createNoteInput, searchQuery } from "@travelog/schema";
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { serializePlace } from "../places/resolve.js";
import { loadTrip, logActivity } from "./access.js";
import { assertDayInTrip, listItems } from "./items.js";
import { serializeTrip } from "./routes.js";

type NoteRow = typeof schema.notes.$inferSelect;

const serializeNote = (n: NoteRow, authorName: string | null) => ({
  id: n.id,
  body: n.body,
  takenAt: n.takenAt,
  lat: n.location?.y ?? null,
  lng: n.location?.x ?? null,
  dayId: n.dayId,
  itemId: n.itemId,
  mergedIntoEntryId: n.mergedIntoEntryId,
  author: { userId: n.authorId, displayName: authorName },
  createdAt: n.createdAt,
});

/** SQL LIKE 的萬用字元跳脫。 */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export function liveRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  async function listNotes(tripId: string, dayId?: string) {
    const rows = await db
      .select({ note: schema.notes, authorName: schema.users.displayName })
      .from(schema.notes)
      .leftJoin(schema.users, eq(schema.users.id, schema.notes.authorId))
      .where(
        dayId
          ? and(eq(schema.notes.tripId, tripId), eq(schema.notes.dayId, dayId))
          : eq(schema.notes.tripId, tripId),
      )
      .orderBy(desc(schema.notes.takenAt));
    return rows.map((r) => serializeNote(r.note, r.authorName));
  }

  // ---- 快速筆記
  app.get("/v1/trips/:tripId/notes", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    return c.json({ notes: await listNotes(trip.id, c.req.query("dayId")) });
  });

  app.post("/v1/trips/:tripId/notes", auth, validate("json", createNoteInput), async (c) => {
    const me = c.get("auth");
    const input = c.req.valid("json");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "journal.writeOwn", { viewerCanWriteJournal: trip.viewerCanWriteJournal });

    // App 的離線佇列重送時帶同一個 Idempotency-Key：已建立過就回傳原本那則
    const clientKey = c.req.header("Idempotency-Key") ?? null;
    if (clientKey !== null && !/^[A-Za-z0-9_-]{8,100}$/.test(clientKey)) {
      throw new ApiError(400, "/problems/bad-idempotency-key", "Idempotency-Key 格式不正確");
    }
    const existing = async () => {
      if (!clientKey) return null;
      const [row] = await db
        .select({ note: schema.notes, authorName: schema.users.displayName })
        .from(schema.notes)
        .leftJoin(schema.users, eq(schema.users.id, schema.notes.authorId))
        .where(and(eq(schema.notes.authorId, me.userId), eq(schema.notes.clientKey, clientKey)));
      if (row && row.note.tripId !== trip.id) throw conflict("Idempotency-Key 已用在別的行程");
      return row ? serializeNote(row.note, row.authorName) : null;
    };
    const dup = await existing();
    if (dup) return c.json(dup, 200);

    const takenAt = input.takenAt ?? now();
    // 依「行程主要時區」的日期對應到某一天
    let day: { id: string } | undefined;
    if (input.dayId) {
      await assertDayInTrip(db, trip.id, input.dayId);
      day = { id: input.dayId };
    } else {
      const date = dateInTimeZone(takenAt, trip.primaryTz);
      [day] = await db
        .select({ id: schema.tripDays.id })
        .from(schema.tripDays)
        .where(and(eq(schema.tripDays.tripId, trip.id), eq(schema.tripDays.date, date)));
    }
    if (input.itemId) {
      const [item] = await db
        .select({ id: schema.itineraryItems.id })
        .from(schema.itineraryItems)
        .where(
          and(
            eq(schema.itineraryItems.id, input.itemId),
            eq(schema.itineraryItems.tripId, trip.id),
          ),
        );
      if (!item) throw notFound("行程點");
    }
    const [note] = await db
      .insert(schema.notes)
      .values({
        tripId: trip.id,
        authorId: me.userId,
        body: input.body,
        takenAt,
        location:
          input.lat !== undefined && input.lng !== undefined
            ? { x: input.lng, y: input.lat }
            : null,
        dayId: day?.id ?? null,
        itemId: input.itemId ?? null,
        clientKey,
      })
      .onConflictDoNothing({ target: [schema.notes.authorId, schema.notes.clientKey] })
      .returning();
    if (!note) {
      // 同一個 key 的兩個請求同時送達：回傳先建立的那則
      const raced = await existing();
      if (raced) return c.json(raced, 200);
      throw new Error("建立筆記失敗");
    }
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: "note.created",
      targetType: "note",
      targetId: note.id,
      diff: { body: note.body.slice(0, 80) },
    });
    const [author] = await db
      .select({ name: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, me.userId));
    return c.json(serializeNote(note, author?.name ?? null), 201);
  });

  /** 只能刪除自己的筆記；擁有者可以刪除任何筆記。 */
  app.delete("/v1/trips/:tripId/notes/:noteId", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    const noteId = c.req.param("noteId");
    if (!/^[0-9a-f-]{36}$/i.test(noteId)) throw notFound("筆記");
    const [note] = await db
      .select()
      .from(schema.notes)
      .where(and(eq(schema.notes.id, noteId), eq(schema.notes.tripId, trip.id)));
    if (!note) throw notFound("筆記");
    if (note.authorId !== me.userId && ctx.role !== "owner")
      throw new ForbiddenError("只能刪除自己的筆記");
    await db.delete(schema.notes).where(eq(schema.notes.id, note.id));
    return c.body(null, 204);
  });

  // ---- 離線快照：行中模式一次取得需要的資料
  app.get("/v1/trips/:tripId/snapshot", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const [days, members, items, notes] = await Promise.all([
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
      listItems(db, trip.id),
      listNotes(trip.id),
    ]);
    return c.json({
      trip: { ...serializeTrip(trip), myRole: ctx.role, days, members },
      items,
      notes,
      generatedAt: now().toISOString(),
    });
  });

  // ---- 行程內搜尋（行程點、訂位代號、地點名稱、筆記、想去清單）
  app.get("/v1/trips/:tripId/search", auth, validate("query", searchQuery), async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const pattern = likePattern(c.req.valid("query").q);
    const itemMatch: SQL | undefined = or(
      ilike(schema.itineraryItems.title, pattern),
      ilike(schema.itineraryItems.notes, pattern),
      ilike(schema.places.name, pattern),
      ilike(schema.places.address, pattern),
      ilike(schema.bookings.confirmationCode, pattern),
      ilike(schema.bookings.provider, pattern),
    );
    const [itemRows, noteRows, wishRows] = await Promise.all([
      db
        .select({
          id: schema.itineraryItems.id,
          title: schema.itineraryItems.title,
          dayId: schema.itineraryItems.dayId,
          startAt: schema.itineraryItems.startAt,
          tz: schema.itineraryItems.tz,
          confirmed: schema.itineraryItems.confirmedAt,
        })
        .from(schema.itineraryItems)
        .leftJoin(schema.places, eq(schema.places.id, schema.itineraryItems.placeId))
        .leftJoin(schema.bookings, eq(schema.bookings.itemId, schema.itineraryItems.id))
        .where(and(eq(schema.itineraryItems.tripId, trip.id), itemMatch))
        .limit(30),
      db
        .select({
          id: schema.notes.id,
          body: schema.notes.body,
          dayId: schema.notes.dayId,
          takenAt: schema.notes.takenAt,
        })
        .from(schema.notes)
        .where(and(eq(schema.notes.tripId, trip.id), ilike(schema.notes.body, pattern)))
        .limit(30),
      db
        .select({
          id: schema.wishlistItems.id,
          note: schema.wishlistItems.note,
          place: schema.places,
        })
        .from(schema.wishlistItems)
        .innerJoin(schema.places, eq(schema.places.id, schema.wishlistItems.placeId))
        .where(
          and(
            eq(schema.wishlistItems.tripId, trip.id),
            or(ilike(schema.places.name, pattern), ilike(schema.wishlistItems.note, pattern)),
          ),
        )
        .limit(30),
    ]);
    return c.json({
      items: itemRows.map(({ confirmed, ...r }) => ({ ...r, confirmed: confirmed !== null })),
      notes: noteRows,
      wishlist: wishRows.map((w) => ({ id: w.id, note: w.note, place: serializePlace(w.place) })),
    });
  });

  // ---- 即時同步（SSE）
  app.get("/v1/trips/:tripId/events", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.view");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = deps.events.subscribe(trip.id, (e) => {
        queue.push(JSON.stringify(e));
        wake?.();
        // 被移出行程時結束連線
        if (e.action === "member.removed" && e.targetId === me.userId) closed = true;
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ tripId: trip.id }) });
        while (!closed) {
          const next = queue.shift();
          if (next) {
            await stream.writeSSE({ event: "trip", data: next });
            continue;
          }
          // 等待新事件或 25 秒後送心跳
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, deps.sseHeartbeatMs ?? 25_000);
          });
          wake = null;
          if (queue.length === 0 && !closed) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
