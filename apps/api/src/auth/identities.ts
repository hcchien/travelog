import { type Database, schema } from "@travelog/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { unauthorized } from "../lib/problem.js";
import type { IdentityProfile } from "./google.js";

/**
 * 以 (provider, sub) 找使用者；沒有就建立新帳號。
 * 依規格，不以 email 自動合併帳號。
 */
export async function findOrCreateUser(
  db: Database,
  provider: "google" | "apple",
  profile: IdentityProfile,
): Promise<{ userId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: schema.userIdentities.userId, id: schema.userIdentities.id })
      .from(schema.userIdentities)
      .where(
        and(
          eq(schema.userIdentities.provider, provider),
          eq(schema.userIdentities.providerSub, profile.sub),
        ),
      );

    if (existing) {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, existing.userId)).for("update");
      if (!user || user.deletedAt) throw unauthorized("帳號已失效");
      await tx
        .update(schema.userIdentities)
        .set({ email: profile.email, emailVerified: profile.emailVerified })
        .where(eq(schema.userIdentities.id, existing.id));
      return { userId: existing.userId, created: false };
    }

    const [user] = await tx
      .insert(schema.users)
      .values({
        displayName: profile.name ?? profile.email?.split("@")[0] ?? "旅人",
        avatarUrl: profile.picture,
        primaryEmail: profile.emailVerified ? profile.email : null,
      })
      .returning({ id: schema.users.id });
    if (!user) throw new Error("建立使用者失敗");

    await tx.insert(schema.userIdentities).values({
      userId: user.id,
      provider,
      providerSub: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      isPrivateRelay: profile.email?.endsWith("@privaterelay.appleid.com") ?? false,
    });
    return { userId: user.id, created: true };
  });
}

/**
 * 把身分連結到既有帳號。已連結到同一個帳號時視為成功；已屬於其他帳號時回傳 conflict。
 */
export async function linkIdentity(
  db: Database,
  userId: string,
  provider: "google" | "apple",
  profile: IdentityProfile,
  familyId: string,
  now: Date,
): Promise<"linked" | "already" | "conflict"> {
  return db.transaction(async (tx) => {
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  if (!user || user.deletedAt) throw unauthorized();
  const [session] = await tx.select().from(schema.refreshTokens).where(and(
    eq(schema.refreshTokens.userId, userId), eq(schema.refreshTokens.familyId, familyId),
    eq(schema.refreshTokens.clientId, "web"), isNull(schema.refreshTokens.revokedAt),
    isNull(schema.refreshTokens.replacedAt), gt(schema.refreshTokens.expiresAt, now),
  )).for("update");
  if (!session) throw unauthorized();
  const [existing] = await tx
    .select({ userId: schema.userIdentities.userId })
    .from(schema.userIdentities)
    .where(
      and(
        eq(schema.userIdentities.provider, provider),
        eq(schema.userIdentities.providerSub, profile.sub),
      ),
    );
  if (existing) return existing.userId === userId ? "already" : "conflict";
  await tx.insert(schema.userIdentities).values({
    userId,
    provider,
    providerSub: profile.sub,
    email: profile.email,
    emailVerified: profile.emailVerified,
    isPrivateRelay: profile.email?.endsWith("@privaterelay.appleid.com") ?? false,
  });
  return "linked";
  });
}
