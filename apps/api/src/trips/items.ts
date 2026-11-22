import { type DbOrTx, schema, type Transaction } from "@travelog/db";
import {
  type AccessContext,
  assertBookingDetailsMutable,
  assertCan,
  assertItemMutable,
  findOverlapsWithConfirmed,
  type ItineraryItemState,
  planBookingStatusChange,
} from "@travelog/domain";
import {
  bookingInput,
  createItemInput,
  moveItemInput,
  unconfirmItemInput,
  updateBookingInput,
  updateItemInput,
} from "@travelog/schema";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { Hono } from "hono";
import type { AppEnv, Auth, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { type PlaceRow, resolvePlace, serializePlace } from "../places/resolve.js";
import { etag, loadTrip, logActivity, requireIfMatch, type TripRow } from "./access.js";

type ItemRow = typeof schema.itineraryItems.$inferSelect;
type BookingRow = typeof schema.bookings.$inferSelect;

const toState = (r: ItemRow): ItineraryItemState => ({
  id: r.id,
  dayId: r.dayId,
  startAt: r.startAt,
  endAt: r.endAt,
  tz: r.tz,
  placeId: r.placeId,
  type: r.type,
  sortKey: r.sortKey,
  confirmedAt: r.confirmedAt,
  confirmedBy: r.confirmedBy,
  confirmSource: r.confirmSource,
});

const serializeBooking = (b: BookingRow) => ({
  id: b.id,
  kind: b.kind,
  status: b.status,
  confirmationCode: b.confirmationCode,
  provider: b.provider,
  details: b.details,
});

const serializeItem = (r: ItemRow, booking: BookingRow | null, place: PlaceRow | null = null) => ({
  id: r.id,
  tripId: r.tripId,
  dayId: r.dayId,
  type: r.type,
  title: r.title,
  notes: r.notes,
  placeId: r.placeId,
  place: place ? serializePlace(place) : null,
  startAt: r.startAt,
  endAt: r.endAt,
  tz: r.tz,
  sortKey: r.sortKey,
  details: r.details,
  confirmed: r.confirmedAt !== null,
  confirmedAt: r.confirmedAt,
  confirmedBy: r.confirmedBy,
  confirmSource: r.confirmSource,
  booking: booking ? serializeBooking(booking) : null,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

async function placesById(db: DbOrTx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (wanted.length === 0) return new Map<string, PlaceRow>();
  const rows = await db.select().from(schema.places).where(inArray(schema.places.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

/** 回應用：附上地點資料。 */
export async function present(db: DbOrTx, item: ItemRow, booking: BookingRow | null) {
  const places = await placesById(db, [item.placeId]);
  return serializeItem(item, booking, item.placeId ? (places.get(item.placeId) ?? null) : null);
}

async function loadItem(db: DbOrTx, trip: TripRow, itemId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw notFound("行程點");
  const [row] = await db
    .select({ item: schema.itineraryItems, booking: schema.bookings })
    .from(schema.itineraryItems)
    .leftJoin(schema.bookings, eq(schema.bookings.itemId, schema.itineraryItems.id))
    .where(and(eq(schema.itineraryItems.id, itemId), eq(schema.itineraryItems.tripId, trip.id)))
    .for("update", { of: schema.itineraryItems });
  if (!row) throw notFound("行程點");
  return row;
}

export async function assertDayInTrip(db: DbOrTx, tripId: string, dayId: string | null) {
  if (dayId === null) return;
  const [day] = await db
    .select({ id: schema.tripDays.id })
    .from(schema.tripDays)
    .where(and(eq(schema.tripDays.id, dayId), eq(schema.tripDays.tripId, tripId)));
  if (!day) throw notFound("日期");
}

const sameDay = (tripId: string, dayId: string | null) =>
  and(
    eq(schema.itineraryItems.tripId, tripId),
    dayId === null ? isNull(schema.itineraryItems.dayId) : eq(schema.itineraryItems.dayId, dayId),
  );

/** 在某一天的第 index 個位置產生排序鍵（exceptId：移動中的行程點本身）。 */
export async function sortKeyAt(
  db: DbOrTx,
  tripId: string,
  dayId: string | null,
  index: number,
  exceptId?: string,
) {
  const siblings = (
    await db
      .select({ id: schema.itineraryItems.id, sortKey: schema.itineraryItems.sortKey })
      .from(schema.itineraryItems)
      .where(sameDay(tripId, dayId))
      .orderBy(asc(schema.itineraryItems.sortKey))
  ).filter((s) => s.id !== exceptId);
  const at = Math.min(index, siblings.length);
  return {
    index: at,
    sortKey: generateKeyBetween(siblings[at - 1]?.sortKey ?? null, siblings[at]?.sortKey ?? null),
  };
}

async function lastSortKey(db: DbOrTx, tripId: string, dayId: string | null) {
  const rows = await db
    .select({ sortKey: schema.itineraryItems.sortKey })
    .from(schema.itineraryItems)
    .where(sameDay(tripId, dayId))
    .orderBy(asc(schema.itineraryItems.sortKey));
  return rows.at(-1)?.sortKey ?? null;
}

/** 與同一天已確定行程點的時間重疊（只警告）。 */
async function overlapWarnings(db: DbOrTx, item: ItemRow) {
  if (item.dayId === null || item.startAt === null) return [];
  const others = await db
    .select({
      id: schema.itineraryItems.id,
      startAt: schema.itineraryItems.startAt,
      endAt: schema.itineraryItems.endAt,
      confirmedAt: schema.itineraryItems.confirmedAt,
    })
    .from(schema.itineraryItems)
    .where(and(sameDay(item.tripId, item.dayId), ne(schema.itineraryItems.id, item.id)));
  return findOverlapsWithConfirmed(item, others).map((itemId) => ({
    type: "overlaps-confirmed" as const,
    itemId,
  }));
}

function log(
  tx: Transaction,
  me: Auth,
  trip: TripRow,
  action: string,
  itemId: string,
  diff?: Record<string, unknown>,
) {
  return logActivity(tx, {
    tripId: trip.id,
    actorId: me.userId,
    via: me.via,
    action,
    targetType: "itinerary_item",
    targetId: itemId,
    diff: diff ?? null,
  });
}

export function itemRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  /** 在交易內載入行程與行程點並檢查權限。 */
  async function withItem<T>(
    me: Auth,
    tripId: string,
    itemId: string,
    fn: (args: {
      tx: Transaction;
      trip: TripRow;
      ctx: AccessContext;
      item: ItemRow;
      booking: BookingRow | null;
    }) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      const { trip, ctx } = await loadTrip(tx, tripId, me);
      const { item, booking } = await loadItem(tx, trip, itemId);
      return fn({ tx, trip, ctx, item, booking });
    });
  }

  async function bumpItem(tx: Transaction, item: ItemRow, me: Auth, set: Partial<ItemRow>) {
    const [row] = await tx
      .update(schema.itineraryItems)
      .set({ ...set, updatedBy: me.userId, version: item.version + 1 })
      .where(eq(schema.itineraryItems.id, item.id))
      .returning();
    if (!row) throw new Error("更新行程點失敗");
    return row;
  }

  // ---- 列表
  app.get("/v1/trips/:tripId/items", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const dayId = c.req.query("dayId");
    const where =
      dayId === undefined
        ? eq(schema.itineraryItems.tripId, trip.id)
        : sameDay(trip.id, dayId === "none" ? null : dayId);
    const rows = await db
      .select({ item: schema.itineraryItems, booking: schema.bookings })
      .from(schema.itineraryItems)
      .leftJoin(schema.bookings, eq(schema.bookings.itemId, schema.itineraryItems.id))
      .where(where)
      .orderBy(asc(schema.itineraryItems.dayId), asc(schema.itineraryItems.sortKey));
    const places = await placesById(
      db,
      rows.map((r) => r.item.placeId),
    );
    return c.json({
      items: rows.map((r) =>
        serializeItem(
          r.item,
          r.booking,
          r.item.placeId ? (places.get(r.item.placeId) ?? null) : null,
        ),
      ),
    });
  });

  // ---- 新增
  app.post("/v1/trips/:tripId/items", auth, validate("json", createItemInput), async (c) => {
    const me = c.get("auth");
    const { googlePlaceId, sessionToken, ...input } = c.req.valid("json");
    // 向 Google 查詢放在交易之外，避免長時間持有鎖
    const place = googlePlaceId
      ? await resolvePlace(db, deps.places, googlePlaceId, { sessionToken, now })
      : null;
    const result = await db.transaction(async (tx) => {
      const { trip, ctx } = await loadTrip(tx, c.req.param("tripId"), me);
      assertCan(ctx, "item.create");
      const booked = input.booking?.status === "booked";
      if (booked) assertCan(ctx, "item.confirm");
      await assertDayInTrip(tx, trip.id, input.dayId);

      const [item] = await tx
        .insert(schema.itineraryItems)
        .values({
          tripId: trip.id,
          dayId: input.dayId,
          type: input.type,
          title: input.title,
          notes: input.notes,
          startAt: input.startAt,
          endAt: input.endAt,
          placeId: place?.id ?? null,
          tz: input.tz ?? place?.tz ?? trip.primaryTz,
          details: input.details,
          sortKey: generateKeyBetween(await lastSortKey(tx, trip.id, input.dayId), null),
          confirmedAt: booked ? now() : null,
          confirmedBy: booked ? me.userId : null,
          confirmSource: booked ? "booking" : null,
          createdBy: me.userId,
        })
        .returning();
      if (!item) throw new Error("建立行程點失敗");

      let booking: BookingRow | null = null;
      if (input.booking) {
        [booking = null] = await tx
          .insert(schema.bookings)
          .values({ ...input.booking, itemId: item.id })
          .returning();
      }
      await log(tx, me, trip, "item.created", item.id, { title: item.title, booked });
      return { item, booking, warnings: await overlapWarnings(tx, item) };
    });
    c.header("ETag", etag(result.item.version));
    return c.json(
      { item: await present(db, result.item, result.booking), warnings: result.warnings },
      201,
    );
  });

  // ---- 單筆
  app.get("/v1/trips/:tripId/items/:itemId", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const { item, booking } = await loadItem(db, trip, c.req.param("itemId"));
    c.header("ETag", etag(item.version));
    return c.json(await present(db, item, booking));
  });

  // ---- 修改
  app.patch(
    "/v1/trips/:tripId/items/:itemId",
    auth,
    validate("json", updateItemInput),
    async (c) => {
      const me = c.get("auth");
      const { googlePlaceId, ...rest } = c.req.valid("json");
      const place =
        googlePlaceId === undefined || googlePlaceId === null
          ? null
          : await resolvePlace(db, deps.places, googlePlaceId, { now });
      const patch = {
        ...rest,
        ...(googlePlaceId === undefined ? {} : { placeId: place?.id ?? null }),
      };
      const result = await withItem(
        me,
        c.req.param("tripId"),
        c.req.param("itemId"),
        async ({ tx, trip, ctx, item, booking }) => {
          assertCan(ctx, "item.update");
          requireIfMatch(c, item.version);
          assertItemMutable(toState(item), { kind: "update", patch });
          const startAt = patch.startAt !== undefined ? patch.startAt : item.startAt;
          const endAt = patch.endAt !== undefined ? patch.endAt : item.endAt;
          if (startAt && endAt && endAt < startAt) throw conflict("結束時間不能早於開始時間");

          const row = await bumpItem(tx, item, me, patch);
          await log(tx, me, trip, "item.updated", item.id, patch);
          return { item: row, booking, warnings: await overlapWarnings(tx, row) };
        },
      );
      c.header("ETag", etag(result.item.version));
      return c.json({
        item: await present(db, result.item, result.booking),
        warnings: result.warnings,
      });
    },
  );

  // ---- 移動（換天、排序）
  app.post(
    "/v1/trips/:tripId/items/:itemId/move",
    auth,
    validate("json", moveItemInput),
    async (c) => {
      const me = c.get("auth");
      const { dayId, index } = c.req.valid("json");
      const result = await withItem(
        me,
        c.req.param("tripId"),
        c.req.param("itemId"),
        async ({ tx, trip, ctx, item, booking }) => {
          assertCan(ctx, "item.move");
          assertItemMutable(toState(item), { kind: "move" });
          await assertDayInTrip(tx, trip.id, dayId);

          const { index: at, sortKey } = await sortKeyAt(tx, trip.id, dayId, index, item.id);

          const row = await bumpItem(tx, item, me, { dayId, sortKey });
          await log(tx, me, trip, "item.moved", item.id, {
            fromDayId: item.dayId,
            toDayId: dayId,
            index: at,
          });
          return { item: row, booking, warnings: await overlapWarnings(tx, row) };
        },
      );
      c.header("ETag", etag(result.item.version));
      return c.json({
        item: await present(db, result.item, result.booking),
        warnings: result.warnings,
      });
    },
  );

  // ---- 刪除
  app.delete("/v1/trips/:tripId/items/:itemId", auth, async (c) => {
    const me = c.get("auth");
    await withItem(
      me,
      c.req.param("tripId"),
      c.req.param("itemId"),
      async ({ tx, trip, ctx, item }) => {
        assertCan(ctx, "item.delete");
        assertItemMutable(toState(item), { kind: "delete" });
        await log(tx, me, trip, "item.deleted", item.id, { title: item.title });
        await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, item.id));
      },
    );
    return c.body(null, 204);
  });

  // ---- 手動確定
  app.post("/v1/trips/:tripId/items/:itemId/confirm", auth, async (c) => {
    const me = c.get("auth");
    const result = await withItem(
      me,
      c.req.param("tripId"),
      c.req.param("itemId"),
      async ({ tx, trip, ctx, item, booking }) => {
        assertCan(ctx, "item.confirm");
        if (item.confirmedAt) throw conflict("行程點已經是確定狀態");
        const row = await bumpItem(tx, item, me, {
          confirmedAt: now(),
          confirmedBy: me.userId,
          confirmSource: "manual",
        });
        await log(tx, me, trip, "item.confirmed", item.id, { source: "manual" });
        return { item: row, booking };
      },
    );
    c.header("ETag", etag(result.item.version));
    return c.json(await present(db, result.item, result.booking));
  });

  // ---- 解除確定
  app.post(
    "/v1/trips/:tripId/items/:itemId/unconfirm",
    auth,
    validate("json", unconfirmItemInput),
    async (c) => {
      const me = c.get("auth");
      const { reason, note } = c.req.valid("json");
      const result = await withItem(
        me,
        c.req.param("tripId"),
        c.req.param("itemId"),
        async ({ tx, trip, ctx, item, booking }) => {
          assertCan(ctx, "item.unconfirm");
          if (!item.confirmedAt) throw conflict("行程點不是確定狀態");
          const row = await bumpItem(tx, item, me, {
            confirmedAt: null,
            confirmedBy: null,
            confirmSource: null,
          });

          let updatedBooking = booking;
          if (booking && item.confirmSource === "booking") {
            [updatedBooking = booking] = await tx
              .update(schema.bookings)
              .set({ status: reason === "cancel" ? "cancelled" : "planned" })
              .where(eq(schema.bookings.id, booking.id))
              .returning();
          }
          await log(tx, me, trip, "item.unconfirmed", item.id, { reason, note: note ?? null });
          return { item: row, booking: updatedBooking };
        },
      );
      c.header("ETag", etag(result.item.version));
      return c.json(await present(db, result.item, result.booking));
    },
  );

  // ---- 訂位
  app.post(
    "/v1/trips/:tripId/items/:itemId/booking",
    auth,
    validate("json", bookingInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const result = await withItem(
        me,
        c.req.param("tripId"),
        c.req.param("itemId"),
        async ({ tx, trip, ctx, item, booking }) => {
          assertCan(ctx, "item.update");
          if (booking) throw conflict("這個行程點已經有訂位資料");
          const effect = planBookingStatusChange(toState(item), "planned", input.status);
          if (effect.requiresAction) assertCan(ctx, effect.requiresAction);
          const [created] = await tx
            .insert(schema.bookings)
            .values({ ...input, itemId: item.id })
            .returning();
          const row =
            effect.confirmation === "confirm"
              ? await bumpItem(tx, item, me, {
                  confirmedAt: now(),
                  confirmedBy: me.userId,
                  confirmSource: "booking",
                })
              : item;
          await log(tx, me, trip, "booking.created", item.id, { status: input.status });
          return { item: row, booking: created ?? null };
        },
      );
      return c.json(await present(db, result.item, result.booking), 201);
    },
  );

  app.patch(
    "/v1/trips/:tripId/items/:itemId/booking",
    auth,
    validate("json", updateBookingInput),
    async (c) => {
      const me = c.get("auth");
      const patch = c.req.valid("json");
      const result = await withItem(
        me,
        c.req.param("tripId"),
        c.req.param("itemId"),
        async ({ tx, trip, ctx, item, booking }) => {
          assertCan(ctx, "item.update");
          if (!booking) throw notFound("訂位資料");
          const state = toState(item);
          if (patch.details) assertBookingDetailsMutable(state, booking.details, patch.details);

          let row = item;
          if (patch.status && patch.status !== booking.status) {
            const effect = planBookingStatusChange(state, booking.status, patch.status);
            if (effect.requiresAction) assertCan(ctx, effect.requiresAction);
            if (effect.confirmation === "confirm") {
              row = await bumpItem(tx, item, me, {
                confirmedAt: now(),
                confirmedBy: me.userId,
                confirmSource: "booking",
              });
            } else if (effect.confirmation === "unconfirm") {
              row = await bumpItem(tx, item, me, {
                confirmedAt: null,
                confirmedBy: null,
                confirmSource: null,
              });
            }
          }
          const [updated] = await tx
            .update(schema.bookings)
            .set({
              ...patch,
              details: patch.details ? { ...booking.details, ...patch.details } : booking.details,
            })
            .where(eq(schema.bookings.id, booking.id))
            .returning();
          await log(tx, me, trip, "booking.updated", item.id, patch);
          return { item: row, booking: updated ?? booking };
        },
      );
      return c.json(await present(db, result.item, result.booking));
    },
  );

  return app;
}
