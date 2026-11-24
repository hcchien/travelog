import { schema } from "@travelog/db";
import { assertCan } from "@travelog/domain";
import { createUploadInput } from "@travelog/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { drainStorageDeletions } from "../lib/maintenance.js";
import { randomToken } from "../lib/crypto.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { loadTrip, logActivity } from "./access.js";

type AttachmentRow = typeof schema.attachments.$inferSelect;

const serialize = (a: AttachmentRow) => ({
  id: a.id,
  itemId: a.itemId,
  filename: a.filename,
  mime: a.mime,
  sizeBytes: a.sizeBytes,
  status: a.status,
  uploadedBy: a.uploadedBy,
  createdAt: a.createdAt,
});

/** 附件（訂位憑證、票券）：客戶端直接上傳到儲存空間，API 只簽發短效網址（ARCHITECTURE §6.1）。 */
export function attachmentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, storage } = deps;
  const auth = requireAuth(deps);

  async function loadAttachment(tripId: string, attachmentId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw notFound("附件");
    const [a] = await db
      .select()
      .from(schema.attachments)
      .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.tripId, tripId)));
    if (!a) throw notFound("附件");
    return a;
  }

  app.get("/v1/trips/:tripId/attachments", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const itemId = c.req.query("itemId");
    const rows = await db
      .select()
      .from(schema.attachments)
      .where(
        and(
          eq(schema.attachments.tripId, trip.id),
          eq(schema.attachments.status, "ready"),
          itemId === "none"
            ? isNull(schema.attachments.itemId)
            : itemId
              ? eq(schema.attachments.itemId, itemId)
              : undefined,
        ),
      )
      .orderBy(desc(schema.attachments.createdAt));
    return c.json({ attachments: rows.map(serialize) });
  });

  app.post(
    "/v1/trips/:tripId/attachments/uploads",
    auth,
    validate("json", createUploadInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "attachment.upload");
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
      // 物件名稱不含使用者輸入的檔名，避免路徑問題
      const storageKey = `trips/${trip.id}/${randomToken(18)}`;
      const a = await db.transaction(async (tx) => {
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, me.userId)).for("update");
        if (!user || user.deletedAt) throw new ApiError(401, "/problems/unauthorized", "帳號已失效");
        await tx.select({ id: schema.trips.id }).from(schema.trips).where(eq(schema.trips.id, trip.id)).for("update");
        const [tripQuota] = await tx.select({ count: sql<number>`count(*)::int`, size: sql<string>`coalesce(sum(${schema.attachments.sizeBytes}), 0)` })
          .from(schema.attachments).where(eq(schema.attachments.tripId, trip.id));
        const [userQuota] = await tx.select({ size: sql<string>`coalesce(sum(${schema.attachments.sizeBytes}), 0)` })
          .from(schema.attachments).where(eq(schema.attachments.uploadedBy, me.userId));
        if ((tripQuota?.count ?? 0) >= 500 || Number(tripQuota?.size ?? 0) + input.sizeBytes > 1024 ** 3 || Number(userQuota?.size ?? 0) + input.sizeBytes > 5 * 1024 ** 3)
          throw new ApiError(429, "/problems/storage-quota", "附件已達儲存配額");
        const [row] = await tx.insert(schema.attachments)
        .values({
          tripId: trip.id,
          itemId: input.itemId ?? null,
          storageKey,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          uploadedBy: me.userId,
          createdAt: deps.now(),
        })
        .returning();
        return row;
      });
      if (!a) throw new Error("建立附件失敗");
      const upload = await storage.signUpload(storageKey, { mime: a.mime, size: a.sizeBytes });
      return c.json({ attachment: serialize(a), upload: { method: "PUT", ...upload } }, 201);
    },
  );

  app.post("/v1/trips/:tripId/attachments/:attachmentId/complete", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "attachment.upload");
    const a = await loadAttachment(trip.id, c.req.param("attachmentId"));
    if (a.status === "ready") return c.json(serialize(a));
    if (a.uploadedBy !== me.userId) throw notFound("附件");
    const obj = await storage.stat(a.storageKey);
    if (!obj) throw new ApiError(409, "/problems/upload-missing", "還沒有收到檔案，請重新上傳");
    if (obj.size !== a.sizeBytes) {
      await db.delete(schema.attachments).where(eq(schema.attachments.id, a.id));
      throw new ApiError(409, "/problems/upload-mismatch", "檔案大小與申報的不符");
    }
    const [ready] = await db
      .update(schema.attachments)
      .set({ status: "ready", storageGeneration: obj.generation })
      .where(and(eq(schema.attachments.id, a.id), eq(schema.attachments.status, "pending")))
      .returning();
    if (!ready) return c.json(serialize(await loadAttachment(trip.id, a.id)));
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: "attachment.uploaded",
      targetType: "attachment",
      targetId: a.id,
      diff: { title: a.filename },
    });
    return c.json(serialize(ready as AttachmentRow));
  });

  app.get("/v1/trips/:tripId/attachments/:attachmentId/download", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const a = await loadAttachment(trip.id, c.req.param("attachmentId"));
    if (a.status !== "ready") throw notFound("附件");
    // Backfill legacy completed objects once; all new completions pin their generation.
    let generation = a.storageGeneration;
    if (!generation) {
      const object = await storage.stat(a.storageKey);
      if (!object) throw notFound("檔案");
      const [pinned] = await db.update(schema.attachments).set({ storageGeneration: object.generation })
        .where(and(eq(schema.attachments.id, a.id), isNull(schema.attachments.storageGeneration))).returning();
      generation = pinned?.storageGeneration ?? (await loadAttachment(trip.id, a.id)).storageGeneration;
    }
    const url = await storage.signDownload(a.storageKey, { filename: a.filename, mime: a.mime, generation });
    return c.json({ url });
  });

  /** 上傳者或擁有者可以刪除。 */
  app.delete("/v1/trips/:tripId/attachments/:attachmentId", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "attachment.upload");
    const a = await loadAttachment(trip.id, c.req.param("attachmentId"));
    if (a.uploadedBy !== me.userId && ctx.role !== "owner") {
      throw new ApiError(403, "/problems/forbidden", "只能刪除自己上傳的附件");
    }
    await db.delete(schema.attachments).where(eq(schema.attachments.id, a.id));
    await drainStorageDeletions(deps);
    if (a.status === "ready") {
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "attachment.deleted",
        targetType: "attachment",
        targetId: a.id,
        diff: { title: a.filename },
      });
    }
    return c.body(null, 204);
  });

  return app;
}
