import { schema } from "@travelog/db";
import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Deps } from "../context.js";
import { sha256 } from "./crypto.js";
import { ApiError } from "./problem.js";

export const MAX_JSON_BYTES = 256 * 1024;
export function assertJsonComplexity(value: unknown) {
  const stack = [{ value, depth: 0 }];
  let elements = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (++elements > 10_000 || current.depth > 32)
      throw new ApiError(413, "/problems/input-limit", "輸入內容太複雜");
    if (current.value && typeof current.value === "object")
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

export async function budget(deps: Pick<Deps, "db" | "now">, identity: string, name: string, max: number, seconds: number) {
  const window = Math.floor(deps.now().getTime() / (seconds * 1000));
  const key = sha256(`${identity}:${name}:${window}`);
  const [accepted] = await deps.db.insert(schema.rateLimits).values({
    key, hits: 1, expiresAt: new Date((window + 1) * seconds * 1000),
  }).onConflictDoUpdate({ target: schema.rateLimits.key,
    set: { hits: sql`${schema.rateLimits.hits} + 1` },
    setWhere: sql`${schema.rateLimits.hits} < ${max}`,
  }).returning({ key: schema.rateLimits.key });
  if (!accepted) throw new ApiError(429, "/problems/rate-limit", "操作過於頻繁，請稍後再試", { retryAfter: seconds });
}

export const inputLimits = () => createMiddleware<AppEnv>(async (c, next) => {
  const localUpload = c.req.path.startsWith("/v1/local-storage/");
  const maxBytes = localUpload ? 10 * 1024 * 1024 : MAX_JSON_BYTES;
  // Count actual streamed bytes even when Content-Length is missing or dishonest.
  const reader = c.req.raw.body ? c.req.raw.clone().body?.getReader() : undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        // A tee cancellation can wait for the other branch; never await it here.
        void reader.cancel().catch(() => {});
        throw new ApiError(413, "/problems/body-limit", "請求內容太大");
      }
      if (!localUpload) chunks.push(chunk.value);
    }
  }
  if (!localUpload && size > 0) {
    const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const oauthForm = ["/oauth/token", "/oauth/revoke"].includes(c.req.path);
    if (type !== "application/json" && !(oauthForm && type === "application/x-www-form-urlencoded"))
      throw new ApiError(415, "/problems/content-type", "請使用 application/json");
    if (type === "application/json") {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new ApiError(400, "/problems/json", "JSON 格式錯誤"); }
      assertJsonComplexity(parsed);
    }
  }
  await next();
});

/** No spoofable forwarded-IP header is trusted. Anonymous budgets are service-wide safety ceilings. */
export const anonymousLimits = (deps: Deps) => createMiddleware<AppEnv>(async (c, next) => {
  const path = c.req.path;
  if (c.req.url.length > 8192) throw new ApiError(414, "/problems/url-limit", "網址太長");
  if (c.req.method === "GET" && path.startsWith("/v1/invitations/"))
    await budget(deps, "global", "invitation-preview-minute", 600, 60);
  if (c.req.method !== "OPTIONS" && (path.startsWith("/oauth/") || path.startsWith("/v1/auth/"))) {
    await budget(deps, "global", "auth-minute", 600, 60);
    if (path === "/oauth/register") await budget(deps, "global", "registration-day", 500, 86400);
    if (path === "/oauth/authorize") await budget(deps, "global", "authorization-hour", 1000, 3600);
    if (path === "/v1/auth/passkey/login/options" || path === "/v1/auth/google")
      await budget(deps, "global", "login-challenge-hour", 1000, 3600);
  }
  await next();
});

export async function userLimits(deps: Deps, userId: string, method: string, path: string) {
  await budget(deps, userId, "api-minute", 600, 60);
  if (path.startsWith("/v1/places/")) {
    await budget(deps, userId, "places-minute", 60, 60);
    await budget(deps, userId, "places-day", 1000, 86400);
    await budget(deps, "global", "places-day", 10000, 86400);
  }
  if (method === "POST" && path.endsWith("/invitations")) {
    await budget(deps, userId, "invitations-hour", 20, 3600);
    await budget(deps, "global", "invitations-day", 1000, 86400);
  }
  if (method === "POST" && path.endsWith("/attachments/uploads"))
    await budget(deps, userId, "uploads-day", 100, 86400);
  if (method === "POST" && path === "/v1/trips")
    await budget(deps, userId, "trips-day", 20, 86400);
}
