import { schema } from "@travelog/db";
import { and, eq, lt, lte, sql } from "drizzle-orm";
import type { Deps } from "../context.js";

type MaintenanceDeps = Pick<Deps, "db" | "storage" | "now">;

/** Safe across instances: locked rows are skipped; failures remain durable and retryable. */
export async function drainStorageDeletions({ db, storage, now }: MaintenanceDeps) {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.storageDeletions)
      .where(lte(schema.storageDeletions.availableAt, now()))
      .limit(20)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      try {
        await storage.remove(row.storageKey);
        await tx
          .delete(schema.storageDeletions)
          .where(eq(schema.storageDeletions.storageKey, row.storageKey));
      } catch {
        await tx
          .update(schema.storageDeletions)
          .set({
            attempts: row.attempts + 1,
            availableAt: new Date(
              now().getTime() + Math.min(3600_000, 60_000 * 2 ** Math.min(row.attempts, 6)),
            ),
          })
          .where(eq(schema.storageDeletions.storageKey, row.storageKey));
        console.error("storage cleanup failed; retry queued");
      }
    }
  });
}

export async function maintenance(deps: MaintenanceDeps) {
  const { db, now } = deps;
  await db
    .delete(schema.attachments)
    .where(
      and(
        eq(schema.attachments.status, "pending"),
        lt(schema.attachments.createdAt, new Date(now().getTime() - 86400_000)),
      ),
    );
  await db.delete(schema.browserAuthStates).where(lt(schema.browserAuthStates.expiresAt, now()));
  await db.delete(schema.webauthnChallenges).where(lt(schema.webauthnChallenges.expiresAt, now()));
  await db.delete(schema.oauthRequests).where(lt(schema.oauthRequests.expiresAt, now()));
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.expiresAt, now()));
  // Keep spent refresh rows until expiry for family-reuse detection.
  await db.delete(schema.refreshTokens).where(lt(schema.refreshTokens.expiresAt, now()));
  await db.execute(sql`DELETE FROM oauth_clients c WHERE c.created_at < ${new Date(now().getTime() - 30 * 86400_000)}
    AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.client_id = c.client_id AND r.revoked_at IS NULL AND r.expires_at > ${now()})
    AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.client_id AND r.expires_at > ${now()})`);
  await drainStorageDeletions(deps);
}
