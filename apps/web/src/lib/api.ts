export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:8080";

/** RFC 9457 Problem Details。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};

/** 用 HttpOnly cookie 換新的 access token（同時只發一個請求）。 */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= fetch(`${API_ORIGIN}/v1/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      return body.accessToken;
    })
    .catch(() => null)
    .then((token) => {
      accessToken = token;
      refreshing = null;
      return token;
    });
  return refreshing;
}

export interface RequestOptions {
  body?: unknown;
  ifMatch?: number;
  signal?: AbortSignal;
}

async function raw(method: string, path: string, opts: RequestOptions) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["If-Match"] = `"v${opts.ifMatch}"`;
  return fetch(`${API_ORIGIN}${path}`, {
    method,
    headers,
    credentials: "include",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export async function api<T = unknown>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  let res = await raw(method, path, opts);
  if (res.status === 401 && !path.startsWith("/v1/auth/")) {
    if (await refreshAccessToken()) res = await raw(method, path, opts);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const problem = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      String(problem.type ?? "/problems/unknown"),
      String(problem.title ?? "發生錯誤，請稍後再試"),
      problem,
    );
  }
  return body as T;
}

export const errorMessage = (e: unknown) => {
  if (e instanceof ApiError) {
    const errors = e.body.errors as { path: string; message: string }[] | undefined;
    if (errors?.length) return errors.map((x) => x.message).join("、");
    return e.message;
  }
  return "連線失敗，請稍後再試";
};
