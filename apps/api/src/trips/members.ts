import { schema } from "@travelog/db";
import { assertCan, canInviteAs, ForbiddenError } from "@travelog/domain";
import { createInvitationInput, transferOwnershipInput, updateMemberInput } from "@travelog/schema";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { loadTrip, logActivity } from "./access.js";

type InvitationRow = typeof schema.invitations.$inferSelect;

const maskEmail = (email: string) => {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, name.length - 1))}@${domain}`;
};

function invitationStatus(inv: InvitationRow, now: Date) {
  if (inv.revokedAt) return "revoked" as const;
  if (inv.email && inv.acceptedAt) return "used" as const;
  if (inv.expiresAt && inv.expiresAt <= now) return "expired" as const;
  return "valid" as const;
}

const serializeInvitation = (inv: InvitationRow, now: Date) => ({
  id: inv.id,
  role: inv.role,
  email: inv.email,
  expiresAt: inv.expiresAt,
  status: invitationStatus(inv, now),
  createdBy: inv.createdBy,
  createdAt: inv.createdAt,
});

export function memberRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, now, config } = deps;
  const auth = requireAuth(deps);

  async function members(tripId: string) {
    return db
      .select({
        userId: schema.users.id,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        role: schema.tripMembers.role,
        joinedAt: schema.tripMembers.joinedAt,
      })
      .from(schema.tripMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.tripMembers.userId))
      .where(eq(schema.tripMembers.tripId, tripId));
  }

  async function loadInvitationByToken(token: string) {
    const [row] = await db
      .select({
        inv: schema.invitations,
        tripTitle: schema.trips.title,
        startDate: schema.trips.startDate,
        endDate: schema.trips.endDate,
        inviterName: schema.users.displayName,
      })
      .from(schema.invitations)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.invitations.tripId))
      .innerJoin(schema.users, eq(schema.users.id, schema.invitations.createdBy))
      .where(eq(schema.invitations.tokenHash, sha256(token)));
    if (!row) throw notFound("邀請");
    return row;
  }

  // ---- 成員
  app.get("/v1/trips/:tripId/members", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    return c.json({ members: await members(trip.id) });
  });

  app.patch(
    "/v1/trips/:tripId/members/:userId",
    auth,
    validate("json", updateMemberInput),
    async (c) => {
      const me = c.get("auth");
      const { role } = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      assertCan(ctx, "member.manage");
      const targetId = c.req.param("userId");
      if (targetId === trip.ownerId) throw conflict("擁有者的角色不能直接修改，請使用轉移擁有權");
      const [row] = await db
        .update(schema.tripMembers)
        .set({ role })
        .where(and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, targetId)))
        .returning();
      if (!row) throw notFound("成員");
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "member.role_changed",
        targetType: "user",
        targetId,
        diff: { role },
      });
      return c.json({ userId: row.userId, role: row.role });
    },
  );

  /** 移除成員；移除自己即「離開行程」（擁有者需先轉移擁有權）。 */
  app.delete("/v1/trips/:tripId/members/:userId", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    const targetId = c.req.param("userId");
    const leaving = targetId === me.userId;
    if (targetId === trip.ownerId) {
      throw conflict(leaving ? "擁有者要先把擁有權轉移給其他成員才能離開" : "不能移除擁有者");
    }
    if (!leaving) assertCan(ctx, "member.manage");
    const rows = await db
      .delete(schema.tripMembers)
      .where(and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, targetId)))
      .returning();
    if (rows.length === 0) throw notFound("成員");
    await logActivity(db, {
      tripId: trip.id,
      actorId: me.userId,
      via: me.via,
      action: leaving ? "member.left" : "member.removed",
      targetType: "user",
      targetId,
    });
    return c.body(null, 204);
  });

  app.post(
    "/v1/trips/:tripId/transfer-ownership",
    auth,
    validate("json", transferOwnershipInput),
    async (c) => {
      const me = c.get("auth");
      const { userId } = c.req.valid("json");
      await db.transaction(async (tx) => {
        const { trip, ctx } = await loadTrip(tx, c.req.param("tripId"), me);
        assertCan(ctx, "trip.transferOwnership");
        if (userId === me.userId) throw conflict("你已經是擁有者");
        const [target] = await tx
          .update(schema.tripMembers)
          .set({ role: "owner" })
          .where(and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, userId)))
          .returning();
        if (!target) throw notFound("成員");
        await tx
          .update(schema.tripMembers)
          .set({ role: "editor" })
          .where(
            and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, me.userId)),
          );
        await tx
          .update(schema.trips)
          .set({ ownerId: userId, version: trip.version + 1 })
          .where(eq(schema.trips.id, trip.id));
        await logActivity(tx, {
          tripId: trip.id,
          actorId: me.userId,
          via: me.via,
          action: "trip.ownership_transferred",
          targetType: "user",
          targetId: userId,
        });
      });
      return c.json({ ownerId: userId });
    },
  );

  // ---- 邀請
  app.post(
    "/v1/trips/:tripId/invitations",
    auth,
    validate("json", createInvitationInput),
    async (c) => {
      const me = c.get("auth");
      const input = c.req.valid("json");
      const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
      if (!canInviteAs(ctx, input.role)) throw new ForbiddenError("沒有權限邀請成員");

      const token = randomToken(32);
      const expiresAt =
        input.expiresInDays === null
          ? null
          : new Date(now().getTime() + input.expiresInDays * 86_400_000);
      const [inv] = await db
        .insert(schema.invitations)
        .values({
          tripId: trip.id,
          tokenHash: sha256(token),
          role: input.role,
          email: input.email?.toLowerCase() ?? null,
          expiresAt,
          createdBy: me.userId,
        })
        .returning();
      if (!inv) throw new Error("建立邀請失敗");
      const url = `${config.appOrigin}/invite/${token}`;

      if (inv.email) {
        const [inviter] = await db
          .select({ name: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.id, me.userId));
        await deps.mailer.sendInvitation({
          to: inv.email,
          url,
          tripTitle: trip.title,
          inviterName: inviter?.name ?? "",
        });
      }
      await logActivity(db, {
        tripId: trip.id,
        actorId: me.userId,
        via: me.via,
        action: "invitation.created",
        targetType: "invitation",
        targetId: inv.id,
        diff: { role: inv.role, email: inv.email },
      });
      // token 只在建立時回傳一次；資料庫只存雜湊
      return c.json({ ...serializeInvitation(inv, now()), url }, 201);
    },
  );

  app.get("/v1/trips/:tripId/invitations", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "member.invite");
    const t = now();
    const rows = await db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tripId, trip.id),
          isNull(schema.invitations.revokedAt),
          or(isNull(schema.invitations.expiresAt), gt(schema.invitations.expiresAt, t)),
        ),
      )
      .orderBy(desc(schema.invitations.createdAt));
    return c.json({
      invitations: rows.map((r) => serializeInvitation(r, t)).filter((r) => r.status === "valid"),
    });
  });

  app.delete("/v1/trips/:tripId/invitations/:id", auth, async (c) => {
    const me = c.get("auth");
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), me);
    assertCan(ctx, "member.invite");
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("邀請");
    const rows = await db
      .update(schema.invitations)
      .set({ revokedAt: now() })
      .where(and(eq(schema.invitations.id, id), eq(schema.invitations.tripId, trip.id)))
      .returning({ id: schema.invitations.id });
    if (rows.length === 0) throw notFound("邀請");
    return c.body(null, 204);
  });

  /** 邀請預覽：不需登入（登入頁會顯示「誰邀請你加入哪趟行程」）。 */
  app.get("/v1/invitations/:token", async (c) => {
    const row = await loadInvitationByToken(c.req.param("token"));
    return c.json({
      trip: {
        id: row.inv.tripId,
        title: row.tripTitle,
        startDate: row.startDate,
        endDate: row.endDate,
      },
      role: row.inv.role,
      invitedBy: row.inviterName,
      status: invitationStatus(row.inv, now()),
      email: row.inv.email ? maskEmail(row.inv.email) : null,
    });
  });

  app.post("/v1/invitations/:token/accept", auth, async (c) => {
    const me = c.get("auth");
    const row = await loadInvitationByToken(c.req.param("token"));
    const inv = row.inv;
    const status = invitationStatus(inv, now());
    if (status !== "valid") {
      const messages = {
        revoked: "這個邀請已被撤回",
        used: "這個邀請已經被使用",
        expired: "這個邀請已過期",
      };
      throw new ApiError(410, `/problems/invitation-${status}`, messages[status]);
    }

    const [existing] = await db
      .select({ role: schema.tripMembers.role })
      .from(schema.tripMembers)
      .where(
        and(eq(schema.tripMembers.tripId, inv.tripId), eq(schema.tripMembers.userId, me.userId)),
      );
    if (existing) {
      // 已經是成員：不改變現有角色（避免用邀請把自己降級或升級）
      return c.json({ tripId: inv.tripId, role: existing.role, alreadyMember: true });
    }

    if (inv.email) {
      const identities = await db
        .select({
          email: schema.userIdentities.email,
          verified: schema.userIdentities.emailVerified,
        })
        .from(schema.userIdentities)
        .where(eq(schema.userIdentities.userId, me.userId));
      const ok = identities.some((i) => i.verified && i.email?.toLowerCase() === inv.email);
      if (!ok) {
        throw new ApiError(
          403,
          "/problems/invitation-email-mismatch",
          `這個邀請是給 ${maskEmail(inv.email)} 的，請用該帳號登入，或請對方改傳邀請連結`,
        );
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(schema.tripMembers)
        .values({ tripId: inv.tripId, userId: me.userId, role: inv.role });
      if (inv.email) {
        await tx
          .update(schema.invitations)
          .set({ acceptedBy: me.userId, acceptedAt: now() })
          .where(eq(schema.invitations.id, inv.id));
      }
      await logActivity(tx, {
        tripId: inv.tripId,
        actorId: me.userId,
        via: me.via,
        action: "member.joined",
        targetType: "invitation",
        targetId: inv.id,
        diff: { role: inv.role },
      });
    });
    return c.json({ tripId: inv.tripId, role: inv.role, alreadyMember: false });
  });

  // ---- 活動紀錄
  app.get("/v1/trips/:tripId/activity", auth, async (c) => {
    const { trip, ctx } = await loadTrip(db, c.req.param("tripId"), c.get("auth"));
    assertCan(ctx, "trip.view");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = await db
      .select({
        id: schema.activityLog.id,
        action: schema.activityLog.action,
        via: schema.activityLog.via,
        targetType: schema.activityLog.targetType,
        targetId: schema.activityLog.targetId,
        diff: schema.activityLog.diff,
        createdAt: schema.activityLog.createdAt,
        actorId: schema.activityLog.actorId,
        actorName: schema.users.displayName,
      })
      .from(schema.activityLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.activityLog.actorId))
      .where(eq(schema.activityLog.tripId, trip.id))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(limit);
    return c.json({ activity: rows });
  });

  return app;
}
