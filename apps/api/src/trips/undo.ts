import { schema } from "@travelog/db";
import { assertCan } from "@travelog/domain";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, conflict, notFound } from "../lib/problem.js";
import { loadTrip, logActivity } from "./access.js";

/** 可以復原的動作（只限透過 MCP 的修改）。ARCHITECTURE §8.3。 */
export const UNDOABLE_ACTIONS = new Set([
  "item.created",
  "item.updated",
  "item.moved",
  "wishlist.added",
]);

const changed = () => conflict("這個行程點之後已被修改，無法復原");

/** 活動紀錄中的時間欄位是 JSON 字串，寫回資料庫前轉成 Date。 */
function revive(before: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...before };
  for (const k of ["startAt", "endAt"]) {
    if (typeof out[k] === "string") out[k] = new Date(out[k] as string);
  }
  return out;
}

export function undoRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;

  app.post("/v1/trips/:tripId/activity/:activityId/undo", requireAuth(deps), async (c) => {
    const me = c.get("auth");
    const activityId = c.req.param("activityId");
    if (!/^[0-9a-f-]{36}$/i.test(activityId)) throw notFound("活動紀錄");

    await db.transaction(async (tx) => {
      const { trip, ctx } = await loadTrip(tx, c.req.param("tripId"), me);
      assertCan(ctx, "activity.undo");
      const [entry] = await tx
        .select()
        .from(schema.activityLog)
        .where(and(eq(schema.activityLog.id, activityId), eq(schema.activityLog.tripId, trip.id)));
      if (!entry) throw notFound("活動紀錄");
      if (entry.via !== "mcp" || !UNDOABLE_ACTIONS.has(entry.action) || !entry.targetId) {
        throw new ApiError(
          422,
          "/problems/not-undoable",
          "只能復原透過 MCP 新增、修改、移動的行程點與想去清單",
        );
      }
      const [already] = await tx
        .select({ id: schema.activityLog.id })
        .from(schema.activityLog)
        .where(
          and(
            eq(schema.activityLog.action, "activity.undone"),
            eq(schema.activityLog.targetId, entry.id),
          ),
        );
      if (already) throw conflict("這筆修改已經復原過了");

      const diff = (entry.diff ?? {}) as Record<string, unknown>;
      if (entry.action === "wishlist.added") {
        const rows = await tx
          .delete(schema.wishlistItems)
          .where(
            and(
              eq(schema.wishlistItems.id, entry.targetId),
              eq(schema.wishlistItems.tripId, trip.id),
            ),
          )
          .returning({ id: schema.wishlistItems.id });
        if (rows.length === 0) throw conflict("這個地點已經不在想去清單裡");
      } else {
        const [item] = await tx
          .select()
          .from(schema.itineraryItems)
          .where(
            and(
              eq(schema.itineraryItems.id, entry.targetId),
              eq(schema.itineraryItems.tripId, trip.id),
            ),
          )
          .for("update");
        if (!item) throw conflict("這個行程點已經不存在");
        // 只有在之後沒有其他人改過時才能復原
        if (item.version !== diff.afterVersion) throw changed();

        if (entry.action === "item.created") {
          await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, item.id));
        } else if (entry.action === "item.updated") {
          await tx
            .update(schema.itineraryItems)
            .set({
              ...revive((diff.before ?? {}) as Record<string, unknown>),
              updatedBy: me.userId,
              version: item.version + 1,
            })
            .where(eq(schema.itineraryItems.id, item.id));
        } else if (entry.action === "item.moved") {
          await tx
            .update(schema.itineraryItems)
            .set({
              dayId: (diff.fromDayId as string | null) ?? null,
              sortKey: diff.fromSortKey as string,
              updatedBy: me.userId,
              version: item.version + 1,
            })
            .where(eq(schema.itineraryItems.id, item.id));
        }
      }
      await logActivity(tx, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "activity.undone",
        targetType: "activity",
        targetId: entry.id,
        diff: { action: entry.action, title: diff.title ?? null },
      });
    });
    return c.body(null, 204);
  });

  return app;
}
