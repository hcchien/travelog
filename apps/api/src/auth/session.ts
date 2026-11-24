import type { Context } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import type { Config } from "../config.js";
import { ApiError } from "../lib/problem.js";

export const REFRESH_COOKIE = "tl_rt";
const OAUTH_COOKIE = "tl_oauth";
const AUTH_PATH = "/v1/auth";

export function setRefreshCookie(c: Context, config: Config, token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: AUTH_PATH,
    maxAge: config.refreshTokenTtlDays * 86_400,
  });
}

export function clearRefreshCookie(c: Context, config: Config) {
  deleteCookie(c, REFRESH_COOKIE, {
    path: AUTH_PATH,
    secure: config.secureCookies,
    sameSite: "Lax",
  });
}

export const getRefreshCookie = (c: Context) => getCookie(c, REFRESH_COOKIE);

export interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** 帳號連結流程：要把 Google 身分加到這個使用者。 */
  linkUserId?: string;
  linkFamilyId?: string;
}

export async function setOAuthState(c: Context, config: Config, value: OAuthState) {
  await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify(value), config.cookieSecret, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: AUTH_PATH,
    maxAge: 600,
  });
}

export async function takeOAuthState(c: Context, config: Config): Promise<OAuthState | null> {
  const raw = await getSignedCookie(c, config.cookieSecret, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: AUTH_PATH, secure: config.secureCookies });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthState;
  } catch {
    return null;
  }
}

/**
 * 以 cookie 驗證的端點必須來自允許的 origin（防 CSRF）。
 */
export function assertAllowedOrigin(c: Context, config: Config) {
  const origin = c.req.header("Origin");
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new ApiError(403, "/problems/forbidden-origin", "不允許的來源");
  }
}

/** returnTo 只接受站內相對路徑，避免 open redirect。 */
export function safeReturnTo(value: string | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u0020\u007f]/.test(value)) {
    return "/";
  }
  return value;
}
