import { randomBytes } from "node:crypto";
import { schema } from "@travelog/db";
import { assertCan, type JournalDoc, slugFromBytes, timeInTimeZone } from "@travelog/domain";
import { createShareLinkInput } from "@travelog/schema";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { loadTrip, logActivity } from "./access.js";

type ShareRow = typeof schema.shareLinks.$inferSelect;

const serializeLink = (l: ShareRow, appOrigin: string) => ({
  id: l.id,
  slug: l.slug,
  url: `${appOrigin}/s/${l.slug}`,
  options: l.options,
  createdAt: l.createdAt,
});

/**
 * 公開遊記（M6）。只公開：行程標題與日期、每天的行程點名稱／類型／當地時間／地點名稱，
 * 以及作者設為「公開」的心得。訂位資料、附件、快速筆記、成員 email 一律不公開。
 */
export function shareRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, config, now } = deps;
  const auth = requireAuth(deps);

  app.get("/v1/trips/:tripId/share-links", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.publish");
    const rows = await db
      .select()
      .from(schema.shareLinks)
      .where(and(eq(schema.shareLinks.tripId, trip.id), isNull(schema.shareLinks.revokedAt)))
      .orderBy(desc(schema.shareLinks.createdAt));
    return c.json({ links: rows.map((l) => serializeLink(l, config.appOrigin)) });
  });

  app.post(
    "/v1/trips/:tripId/share-links",
    auth,
    validate("json", createShareLinkInput),
    async (c) => {
      const me = c.get("auth");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "trip.publish");
      const [link] = await db
        .insert(schema.shareLinks)
        .values({
          tripId: trip.id,
          slug: slugFromBytes(randomBytes(16), 12),
          options: c.req.valid("json"),
          createdBy: me.userId,
        })
        .returning();
      if (!link) throw new Error("建立分享連結失敗");
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "share.created",
        targetType: "share_link",
        targetId: link.id,
      });
      return c.json(serializeLink(link, config.appOrigin), 201);
    },
  );

  app.delete("/v1/trips/:tripId/share-links/:linkId", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.publish");
    const linkId = c.req.param("linkId");
    if (!/^[0-9a-f-]{36}$/i.test(linkId)) throw notFound("分享連結");
    const [l] = await db
      .update(schema.shareLinks)
      .set({ revokedAt: now() })
      .where(
        and(
          eq(schema.shareLinks.id, linkId),
          eq(schema.shareLinks.tripId, trip.id),
          isNull(schema.shareLinks.revokedAt),
        ),
      )
      .returning();
    if (!l) throw notFound("分享連結");
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: "share.revoked",
      targetType: "share_link",
      targetId: l.id,
    });
    return c.body(null, 204);
  });

  // ---- 公開頁（不需登入）
  app.get("/v1/public/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[2-9a-z]{8,20}$/.test(slug)) throw notFound("遊記");
    const [row] = await db
      .select({ link: schema.shareLinks, trip: schema.trips })
      .from(schema.shareLinks)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.shareLinks.tripId))
      .where(and(eq(schema.shareLinks.slug, slug), isNull(schema.shareLinks.revokedAt)));
    if (!row) throw notFound("遊記");
    const { trip, link } = row;

    const days = await db
      .select()
      .from(schema.tripDays)
      .where(eq(schema.tripDays.tripId, trip.id))
      .orderBy(asc(schema.tripDays.date));

    const items = link.options.journalOnly
      ? []
      : await db
          .select({
            item: schema.itineraryItems,
            placeName: schema.places.name,
            location: schema.places.location,
          })
          .from(schema.itineraryItems)
          .leftJoin(schema.places, eq(schema.places.id, schema.itineraryItems.placeId))
          .where(eq(schema.itineraryItems.tripId, trip.id))
          .orderBy(asc(schema.itineraryItems.sortKey));

    const entries = await db
      .select({ entry: schema.journalEntries, authorName: schema.users.displayName })
      .from(schema.journalEntries)
      .leftJoin(schema.users, eq(schema.users.id, schema.journalEntries.authorId))
      .where(
        and(
          eq(schema.journalEntries.tripId, trip.id),
          eq(schema.journalEntries.visibility, "public"),
        ),
      )
      .orderBy(asc(schema.journalEntries.createdAt));

    // 行程點層級的心得歸到該行程點所在的那一天
    const itemDay = new Map<string, string | null>();
    if (entries.some((e) => e.entry.scope === "item")) {
      const ids = entries
        .filter((e) => e.entry.scope === "item")
        .map((e) => e.entry.scopeId as string);
      for (const r of await db
        .select({ id: schema.itineraryItems.id, dayId: schema.itineraryItems.dayId })
        .from(schema.itineraryItems)
        .where(inArray(schema.itineraryItems.id, ids))) {
        itemDay.set(r.id, r.dayId);
      }
    }

    const publicItem = (r: (typeof items)[number]) => ({
      id: r.item.id,
      title: r.item.title,
      type: r.item.type,
      time: r.item.startAt ? timeInTimeZone(r.item.startAt, r.item.tz) : null,
      place: r.placeName
        ? { name: r.placeName, lat: r.location?.y ?? null, lng: r.location?.x ?? null }
        : null,
    });
    const publicEntry = (r: (typeof entries)[number]) => ({
      id: r.entry.id,
      title: r.entry.title,
      body: r.entry.body as unknown as JournalDoc,
      author: r.authorName,
      itemId: r.entry.scope === "item" ? r.entry.scopeId : null,
    });
    const dayOf = (r: (typeof entries)[number]) =>
      r.entry.scope === "day"
        ? r.entry.scopeId
        : r.entry.scope === "item"
          ? (itemDay.get(r.entry.scopeId as string) ?? null)
          : null;

    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.json({
      trip: {
        title: trip.title,
        startDate: trip.startDate,
        endDate: trip.endDate,
        destinations: trip.destinations,
        cover: trip.cover,
      },
      options: link.options,
      entries: entries.filter((e) => e.entry.scope === "trip").map(publicEntry),
      days: days.map((d) => ({
        date: d.date,
        title: d.title,
        items: items
          .filter(
            (r) => r.item.dayId === d.id && !(link.options.hideLodging && r.item.type === "stay"),
          )
          .map(publicItem),
        entries: entries
          .filter((e) => e.entry.scope !== "trip" && dayOf(e) === d.id)
          .map(publicEntry),
      })),
    });
  });

  return app;
}
