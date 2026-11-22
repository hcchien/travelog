import { type DbOrTx, schema } from "@travelog/db";
import {
  appendDoc,
  assertCan,
  docToText,
  type JournalDoc,
  textToDoc,
  timeInTimeZone,
} from "@travelog/domain";
import {
  createJournalEntryInput,
  mergeNotesInput,
  updateJournalEntryInput,
} from "@travelog/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { loadTrip, logActivity, type TripRow } from "./access.js";

type EntryRow = typeof schema.journalEntries.$inferSelect;

export const serializeEntry = (e: EntryRow, authorName: string | null) => ({
  id: e.id,
  scope: e.scope,
  dayId: e.scope === "day" ? e.scopeId : null,
  itemId: e.scope === "item" ? e.scopeId : null,
  title: e.title,
  body: e.body as unknown as JournalDoc,
  bodyText: e.bodyText,
  visibility: e.visibility,
  version: e.version,
  author: { userId: e.authorId, displayName: authorName },
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

async function assertTarget(
  db: DbOrTx,
  trip: TripRow,
  target: { scope: string; dayId?: string; itemId?: string },
) {
  if (target.scope === "day") {
    const [d] = await db
      .select({ id: schema.tripDays.id })
      .from(schema.tripDays)
      .where(
        and(eq(schema.tripDays.id, target.dayId as string), eq(schema.tripDays.tripId, trip.id)),
      );
    if (!d) throw notFound("日期");
    return d.id;
  }
  if (target.scope === "item") {
    const [i] = await db
      .select({ id: schema.itineraryItems.id })
      .from(schema.itineraryItems)
      .where(
        and(
          eq(schema.itineraryItems.id, target.itemId as string),
          eq(schema.itineraryItems.tripId, trip.id),
        ),
      );
    if (!i) throw notFound("行程點");
    return i.id;
  }
  return null;
}

async function authorName(db: DbOrTx, userId: string) {
  const [u] = await db
    .select({ name: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return u?.name ?? null;
}

/** 心得（M3）與筆記轉心得（M6）。 */
export function journalRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  const settings = (trip: TripRow) => ({ viewerCanWriteJournal: trip.viewerCanWriteJournal });

  async function loadEntry(conn: DbOrTx, tripId: string, entryId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) throw notFound("心得");
    const [e] = await conn
      .select()
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.id, entryId), eq(schema.journalEntries.tripId, tripId)));
    if (!e) throw notFound("心得");
    return e;
  }

  app.get("/v1/trips/:tripId/journal", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const rows = await db
      .select({ entry: schema.journalEntries, authorName: schema.users.displayName })
      .from(schema.journalEntries)
      .leftJoin(schema.users, eq(schema.users.id, schema.journalEntries.authorId))
      .where(eq(schema.journalEntries.tripId, trip.id))
      .orderBy(asc(schema.journalEntries.createdAt));
    return c.json({ entries: rows.map((r) => serializeEntry(r.entry, r.authorName)) });
  });

  app.post(
    "/v1/trips/:tripId/journal",
    auth,
    validate("json", createJournalEntryInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "journal.writeOwn", settings(trip));
      const scopeId = await assertTarget(db, trip, input.target);
      const body = input.body ?? textToDoc(input.bodyText ?? "");
      const [existing] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.tripId, trip.id),
            eq(schema.journalEntries.authorId, me.userId),
            eq(schema.journalEntries.scope, input.target.scope),
            scopeId
              ? eq(schema.journalEntries.scopeId, scopeId)
              : isNull(schema.journalEntries.scopeId),
          ),
        );
      if (existing)
        throw conflict("你在這個範圍已經有一篇心得，請改用編輯", { entryId: existing.id });
      const [entry] = await db
        .insert(schema.journalEntries)
        .values({
          tripId: trip.id,
          authorId: me.userId,
          scope: input.target.scope,
          scopeId,
          title: input.title ?? null,
          body: body as unknown as Record<string, unknown>,
          bodyText: docToText(body),
          visibility: input.visibility ?? "members",
        })
        .returning();
      if (!entry) throw new Error("建立心得失敗");
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "journal.created",
        targetType: "journal_entry",
        targetId: entry.id,
        diff: { title: entry.title ?? undefined },
      });
      return c.json(serializeEntry(entry, await authorName(db, me.userId)), 201);
    },
  );

  /** 只有作者可以修改；以 version 做樂觀鎖。 */
  app.patch(
    "/v1/trips/:tripId/journal/:entryId",
    auth,
    validate("json", updateJournalEntryInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "journal.writeOwn", settings(trip));
      const e = await loadEntry(db, trip.id, c.req.param("entryId"));
      if (e.authorId !== me.userId)
        throw new ApiError(403, "/problems/forbidden", "只能修改自己的心得");
      const body =
        input.body ?? (input.bodyText !== undefined ? textToDoc(input.bodyText) : undefined);
      const [updated] = await db
        .update(schema.journalEntries)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(body
            ? { body: body as unknown as Record<string, unknown>, bodyText: docToText(body) }
            : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          version: e.version + 1,
          updatedAt: now(),
        })
        .where(
          and(eq(schema.journalEntries.id, e.id), eq(schema.journalEntries.version, input.version)),
        )
        .returning();
      if (!updated) {
        throw new ApiError(
          412,
          "/problems/version-conflict",
          "心得已在別的地方修改過，請重新載入",
          {
            currentVersion: e.version,
          },
        );
      }
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "journal.updated",
        targetType: "journal_entry",
        targetId: e.id,
        diff: { title: updated.title ?? undefined },
      });
      return c.json(serializeEntry(updated, await authorName(db, me.userId)));
    },
  );

  /** 作者或擁有者可以刪除；併入這篇的筆記會恢復成未併入。 */
  app.delete("/v1/trips/:tripId/journal/:entryId", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "trip.view");
    const e = await loadEntry(db, trip.id, c.req.param("entryId"));
    if (e.authorId !== me.userId && ctx.role !== "owner") {
      throw new ApiError(403, "/problems/forbidden", "只能刪除自己的心得");
    }
    await db.delete(schema.journalEntries).where(eq(schema.journalEntries.id, e.id));
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: "journal.deleted",
      targetType: "journal_entry",
      targetId: e.id,
      diff: { title: e.title ?? undefined },
    });
    return c.body(null, 204);
  });

  /**
   * 筆記轉心得（M6）：把自己在某天、還沒併入的快速筆記依時間順序接到當天的心得最後；
   * 當天還沒有心得就建立一篇。筆記本身保留，只標記已併入。
   */
  app.post(
    "/v1/trips/:tripId/journal/merge-notes",
    auth,
    validate("json", mergeNotesInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "journal.writeOwn", settings(trip));
      await assertTarget(db, trip, { scope: "day", dayId: input.dayId });

      const result = await db.transaction(async (tx) => {
        const notes = await tx
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.tripId, trip.id),
              eq(schema.notes.authorId, me.userId),
              eq(schema.notes.dayId, input.dayId),
              isNull(schema.notes.mergedIntoEntryId),
              input.noteIds ? inArray(schema.notes.id, input.noteIds) : undefined,
            ),
          )
          .orderBy(asc(schema.notes.takenAt))
          .for("update");
        if (notes.length === 0) {
          throw new ApiError(409, "/problems/nothing-to-merge", "這天沒有還沒併入的筆記");
        }
        const addition = textToDoc(
          notes
            .map(
              (n) =>
                `${timeInTimeZone(n.takenAt, trip.primaryTz)}　${n.body.replace(/\s*\n\s*/g, " ")}`,
            )
            .join("\n"),
        );
        const [existing] = await tx
          .select()
          .from(schema.journalEntries)
          .where(
            and(
              eq(schema.journalEntries.tripId, trip.id),
              eq(schema.journalEntries.authorId, me.userId),
              eq(schema.journalEntries.scope, "day"),
              eq(schema.journalEntries.scopeId, input.dayId),
            ),
          )
          .for("update");
        let entry: EntryRow | undefined;
        if (existing) {
          const body = appendDoc(existing.body as unknown as JournalDoc, addition);
          [entry] = await tx
            .update(schema.journalEntries)
            .set({
              body: body as unknown as Record<string, unknown>,
              bodyText: docToText(body),
              version: existing.version + 1,
              updatedAt: now(),
            })
            .where(eq(schema.journalEntries.id, existing.id))
            .returning();
        } else {
          [entry] = await tx
            .insert(schema.journalEntries)
            .values({
              tripId: trip.id,
              authorId: me.userId,
              scope: "day",
              scopeId: input.dayId,
              body: addition as unknown as Record<string, unknown>,
              bodyText: docToText(addition),
            })
            .returning();
        }
        if (!entry) throw new Error("併入筆記失敗");
        await tx
          .update(schema.notes)
          .set({ mergedIntoEntryId: entry.id })
          .where(
            inArray(
              schema.notes.id,
              notes.map((n) => n.id),
            ),
          );
        await logActivity(tx, {
          tripId: trip.id,
          actorId: me.userId,
          via: me.via,
          action: "journal.notes_merged",
          targetType: "journal_entry",
          targetId: entry.id,
          diff: { count: notes.length },
        });
        return { entry, merged: notes.length, created: !existing };
      });
      return c.json(
        {
          entry: serializeEntry(result.entry, await authorName(db, me.userId)),
          merged: result.merged,
        },
        result.created ? 201 : 200,
      );
    },
  );

  return app;
}
