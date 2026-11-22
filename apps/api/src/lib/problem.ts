import { DomainError } from "@travelog/domain";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** API 自己丟出的 HTTP 錯誤，輸出為 RFC 9457 Problem Details。 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = "資源") =>
  new ApiError(404, "/problems/not-found", `找不到${what}`);
export const unauthorized = (msg = "需要登入") => new ApiError(401, "/problems/unauthorized", msg);
export const conflict = (msg: string, extra?: Record<string, unknown>) =>
  new ApiError(409, "/problems/conflict", msg, extra);

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function problem(
  c: Context,
  status: ContentfulStatusCode,
  type: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ type, title, status, ...extra }, status, {
    "Content-Type": "application/problem+json",
  });
}

export function handleError(err: Error, c: Context) {
  if (err instanceof ApiError) return problem(c, err.status, err.type, err.message, err.extra);

  if (err instanceof DomainError) {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(err)) {
      if (!["status", "problemType", "name", "message", "stack"].includes(k)) extra[k] = v;
    }
    return problem(c, err.status as ContentfulStatusCode, err.problemType, err.message, extra);
  }

  if (err instanceof HTTPException) {
    return problem(c, err.status as ContentfulStatusCode, "/problems/http", err.message || "錯誤");
  }

  switch (pgCode(err)) {
    case "TL423":
      return problem(c, 423, "/problems/item-confirmed", "行程點已確定，不能修改或刪除");
    case "23503":
      return problem(c, 409, "/problems/conflict", "資料仍被其他資料參照，無法完成");
    case "23505":
      return problem(c, 409, "/problems/conflict", "資料重複");
  }

  console.error(err);
  return problem(c, 500, "/problems/internal", "伺服器發生錯誤");
}
