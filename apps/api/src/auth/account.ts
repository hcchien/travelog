import { schema } from "@travelog/db";
import { FIRST_PARTY_CHANNELS } from "@travelog/domain";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context.js";
import { drainStorageDeletions } from "../lib/maintenance.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError } from "../lib/problem.js";
import { validate } from "../lib/validate.js";

const deleteAccountInput = z.object({ confirm: z.literal("DELETE") });
const pushTokenInput = z.object({
  token: z.string().regex(/^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/, "不是 Expo 推播權杖"),
  platform: z.enum(["ios", "android"]),
});

export const DELETED_USER_NAME = "已刪除的使用者";

/**
 * 帳號刪除（PRD A-4、App Store 指南 5.1.1(v)）與推播權杖。
 *
 * 刪除方式是「去識別化」：行程點、附件、活動紀錄仍屬於共同行程，保留但不再連到任何個資。
 * - 自己擁有、還有其他成員的行程：擁有權轉給資歷最久的編輯者（沒有編輯者則給檢視者）
 * - 自己擁有、沒有其他成員的行程：整趟刪除（含附件檔案）
 * - 自己寫的心得與快速筆記：刪除
 * - 登入方式、Passkey、權杖、MCP 授權、地點庫、推播權杖：刪除
 */
export function accountRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now } = deps;
  const auth = requireAuth(deps);

  app.delete("/v1/me", auth, validate("json", deleteAccountInput), async (c) => {
    const me = c.get("auth");
    if (!FIRST_PARTY_CHANNELS.has(me.via))
      throw new ApiError(403, "/problems/forbidden", "只能在 Travelog 網站或 App 刪除帳號");

    await db.transaction(async (tx) => {
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, me.userId)).for("update");
      const owned = await tx
        .select({ id: schema.trips.id })
        .from(schema.trips)
        .where(eq(schema.trips.ownerId, me.userId))
        .for("update");
      const toDelete: string[] = [];
      for (const { id: tripId } of owned) {
        const [heir] = await tx
          .select({ userId: schema.tripMembers.userId })
          .from(schema.tripMembers)
          .where(
            and(eq(schema.tripMembers.tripId, tripId), ne(schema.tripMembers.userId, me.userId)),
          )
          // editor 排在 viewer 前面（enum 順序 viewer < editor < owner）
          .orderBy(desc(schema.tripMembers.role), asc(schema.tripMembers.joinedAt))
          .limit(1);
        if (!heir) {
          toDelete.push(tripId);
          continue;
        }
        await tx
          .update(schema.trips)
          .set({ ownerId: heir.userId })
          .where(eq(schema.trips.id, tripId));
        await tx
          .update(schema.tripMembers)
          .set({ role: "owner" })
          .where(
            and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, heir.userId)),
          );
        await tx.insert(schema.activityLog).values({
          tripId,
          actorId: me.userId,
          via: me.via,
          action: "trip.ownership_transferred",
          targetType: "trip",
          targetId: tripId,
          diff: { reason: "account_deleted", to: heir.userId },
        });
      }

      if (toDelete.length) await tx.delete(schema.trips).where(inArray(schema.trips.id, toDelete));

      await tx.delete(schema.notes).where(eq(schema.notes.authorId, me.userId));
      await tx.delete(schema.journalEntries).where(eq(schema.journalEntries.authorId, me.userId));
      await tx.delete(schema.wishlistVotes).where(eq(schema.wishlistVotes.userId, me.userId));
      await tx.delete(schema.tripMembers).where(eq(schema.tripMembers.userId, me.userId));
      await tx.delete(schema.savedPlaces).where(eq(schema.savedPlaces.userId, me.userId));
      await tx.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, me.userId));
      await tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, me.userId));
      await tx
        .delete(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.userId, me.userId));
      await tx
        .delete(schema.webauthnChallenges)
        .where(eq(schema.webauthnChallenges.userId, me.userId));
      await tx.delete(schema.browserAuthStates).where(eq(schema.browserAuthStates.userId, me.userId));
      await tx.delete(schema.oauthRequests).where(eq(schema.oauthRequests.userId, me.userId));
      // TODO(Apple 登入上線時)：先用 providerRefreshTokenEnc 呼叫 Apple /auth/revoke
      await tx.delete(schema.userIdentities).where(eq(schema.userIdentities.userId, me.userId));
      await tx
        .update(schema.users)
        .set({
          displayName: DELETED_USER_NAME,
          avatarUrl: null,
          primaryEmail: null,
          deletedAt: now(),
          updatedAt: now(),
        })
        .where(eq(schema.users.id, me.userId));
    });

    await drainStorageDeletions(deps);
    return c.body(null, 204);
  });

  // ---- 推播權杖（App 登入後註冊；同一個裝置換帳號時改綁）
  app.post("/v1/me/push-tokens", auth, validate("json", pushTokenInput), async (c) => {
    const me = c.get("auth");
    if (me.via !== "app") throw new ApiError(403, "/problems/forbidden", "只有 App 可以註冊推播");
    const input = c.req.valid("json");
    await db
      .insert(schema.pushTokens)
      .values({ userId: me.userId, token: input.token, platform: input.platform })
      .onConflictDoUpdate({
        target: schema.pushTokens.token,
        set: { userId: me.userId, platform: input.platform, lastSeenAt: now() },
      });
    return c.body(null, 204);
  });

  app.delete(
    "/v1/me/push-tokens",
    auth,
    validate("json", pushTokenInput.pick({ token: true })),
    async (c) => {
      const me = c.get("auth");
      await db
        .delete(schema.pushTokens)
        .where(
          and(
            eq(schema.pushTokens.userId, me.userId),
            eq(schema.pushTokens.token, c.req.valid("json").token),
          ),
        );
      return c.body(null, 204);
    },
  );

  return app;
}
