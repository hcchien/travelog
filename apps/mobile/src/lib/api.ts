import * as SecureStore from "expo-secure-store";

export const API_ORIGIN = (process.env.EXPO_PUBLIC_API_ORIGIN ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const REFRESH_KEY = "travelog.refreshToken";

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

/** 連不上伺服器（離線、逾時）。 */
export class OfflineError extends Error {
  constructor() {
    super("目前沒有網路");
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string> | null = null;
let onSignedOut: (() => void) | null = null;

export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

export async function saveSession(tokens: { accessToken: string; refreshToken: string }) {
  accessToken = tokens.accessToken;
  await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
}

export async function clearSession() {
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

export const getRefreshToken = () => SecureStore.getItemAsync(REFRESH_KEY);
export const hasAccessToken = () => accessToken !== null;

async function rawFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new OfflineError();
  }
}

/** 用 refresh token 換新的 access token（同時只發一個請求；refresh token 會輪替）。 */
export function refreshSession(): Promise<string> {
  refreshing ??= (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) throw new ApiError(401, "/problems/unauthorized", "需要登入", {});
    const res = await rawFetch(`${API_ORIGIN}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status === 401) {
      await clearSession();
      onSignedOut?.();
      throw new ApiError(401, "/problems/unauthorized", "登入已過期，請重新登入", {});
    }
    if (!res.ok) throw new ApiError(res.status, "/problems/refresh", "暫時無法更新登入狀態", {});
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    await saveSession(body);
    return body.accessToken;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
): Promise<T> {
  const send = async () => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return rawFetch(`${API_ORIGIN}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  };
  if (opts.auth !== false && !accessToken) await refreshSession();
  let res = await send();
  if (res.status === 401 && opts.auth !== false) {
    await refreshSession();
    res = await send();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body.type ?? ""),
      String(body.title ?? `錯誤 ${res.status}`),
      body,
    );
  }
  return body as T;
}

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "發生錯誤，請再試一次";
