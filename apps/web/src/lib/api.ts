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
let sessionEpoch = 0;
let sessionUser: string | null = null;
export const sessionScope = () => ({ epoch: sessionEpoch, userId: sessionUser });
export const sameSession = (scope: { epoch: number }) => scope.epoch === sessionEpoch;
export function bindSessionUser(userId: string) {
  if (sessionUser !== userId) {
    sessionEpoch++;
    sessionUser = userId;
  }
}
export class SessionChangedError extends Error {}
export class OfflineError extends Error {}

let refreshing: Promise<string | null> | null = null;
const RT_KEY = "travelog:rt";

export const setAccessToken = (t: string | null) => {
  if (t === null) {
    sessionEpoch++;
    sessionUser = null;
    refreshing = null;
  }
  accessToken = t;
};
export const getAccessToken = () => accessToken;

// Remove credentials persisted by older clients without ever interpreting a URL credential.
function removeLegacyCredential() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RT_KEY);
  } catch {}
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.has("tl_rt")) {
    params.delete("tl_rt");
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${params.size ? `#${params}` : ""}`,
    );
  }
}

/** 最近一次 refresh 是否因為網路斷線失敗（用來判斷離線模式）。 */
export let lastRefreshOffline = false;

/** 透過同站 HttpOnly cookie 換發 access token。 */
export function refreshAccessToken(): Promise<string | null> {
  removeLegacyCredential();
  if (refreshing) return refreshing;
  const scope = sessionScope();
  const work = fetch("/session/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
    .then(async (res) => {
      lastRefreshOffline = false;
      if (!res.ok) {
        if (sameSession(scope) && [401, 403].includes(res.status)) {
          try {
            for (const key of Object.keys(localStorage))
              if (key.startsWith("travelog:")) localStorage.removeItem(key);
          } catch {}
        }
        return null;
      }
      const body = (await res.json()) as { accessToken: string; refreshToken?: string };
      return body.accessToken;
    })
    .catch(() => {
      lastRefreshOffline = true;
      return null;
    })
    .then((token) => {
      if (!sameSession(scope)) return null;
      accessToken = token;
      if (refreshing === work) refreshing = null;
      return token;
    });
  refreshing = work;
  return work;
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
  const target = path.startsWith("/v1/auth/")
    ? `/session/${path.slice("/v1/auth/".length)}`
    : path === "/v1/me/identities/link/google"
      ? "/session/link/google"
      : `${API_ORIGIN}${path}`;
  return fetch(target, {
    method,
    headers,
    credentials: "include",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new OfflineError("連線失敗");
  });
}

export async function api<T = unknown>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const scope = sessionScope();
  let res = await raw(method, path, opts);
  if (!sameSession(scope)) throw new SessionChangedError();
  if (res.status === 401 && !path.startsWith("/v1/auth/")) {
    if (await refreshAccessToken()) res = await raw(method, path, opts);
  }
  if (!sameSession(scope)) throw new SessionChangedError();
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
  if (!sameSession(scope)) throw new SessionChangedError();
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
