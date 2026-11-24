import { type DbOrTx, schema } from "@travelog/db";
import type { AccessChannel, AccessContext } from "@travelog/domain";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Auth } from "../context.js";
import { ApiError, notFound } from "../lib/problem.js";

export type TripRow = typeof schema.trips.$inferSelect;

/**
 * 取得行程與目前使用者的角色。不是成員時一律回 404，不透露行程是否存在。
 */
export async function loadTrip(
  db: DbOrTx,
  tripId: string,
  auth: Auth,
): Promise<{ trip: TripRow; ctx: AccessContext }> {
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) throw notFound("行程");
  const [row] = await db
    .select({ trip: schema.trips, role: schema.tripMembers.role })
    .from(schema.trips)
    .innerJoin(
      schema.tripMembers,
      and(
        eq(schema.tripMembers.tripId, schema.trips.id),
        eq(schema.tripMembers.userId, auth.userId),
      ),
    )
    .where(eq(schema.trips.id, tripId));
  if (!row) throw notFound("行程");
  return { trip: row.trip, ctx: { role: row.role, via: auth.via } };
}

export async function logActivity(
  db: DbOrTx,
  entry: {
    tripId: string;
    actorId: string;
    via: AccessChannel;
    action: string;
    targetType: string;
    targetId?: string | null;
    diff?: Record<string, unknown> | null;
  },
) {
  await db.insert(schema.activityLog).values({
    tripId: entry.tripId,
    actorId: entry.actorId,
    via: entry.via,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    diff: entry.diff ?? null,
  });
}

// ---- 樂觀鎖：ETag / If-Match

export const etag = (version: number) => `"v${version}"`;

/** PATCH 必須帶 If-Match；沒帶回 428，版本不符回 412。 */
export function requireIfMatch(c: Context, currentVersion: number) {
  const header = c.req.header("If-Match");
  if (!header) {
    throw new ApiError(
      428,
      "/problems/precondition-required",
      "需要 If-Match 標頭（目前版本的 ETag）",
    );
  }
  const versions = header.split(",").map((s) => s.trim().replace(/^W\//, ""));
  if (!versions.includes(etag(currentVersion)) && !versions.includes("*")) {
    throw new ApiError(412, "/problems/version-conflict", "資料已被其他人修改，請重新載入", {
      currentVersion,
    });
  }
}
