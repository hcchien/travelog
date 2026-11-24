import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const routes: Record<string, { method: string; path: string }> = {
  google: { method: "GET", path: "/v1/auth/google" },
  "google/callback": { method: "GET", path: "/v1/auth/google/callback" },
  refresh: { method: "POST", path: "/v1/auth/refresh" },
  logout: { method: "POST", path: "/v1/auth/logout" },
  "link/google": { method: "POST", path: "/v1/me/identities/link/google" },
  "passkey/login/options": { method: "POST", path: "/v1/auth/passkey/login/options" },
  "passkey/login/verify": { method: "POST", path: "/v1/auth/passkey/login/verify" },
};

/** Fixed-destination BFF. Only HttpOnly cookies cross the server boundary; never proxy caller-supplied refresh tokens. */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const key = (await ctx.params).path.join("/");
  const route = routes[key];
  if (!route || req.method !== route.method) return new Response(null, { status: 404 });
  const appOrigin = process.env.APP_ORIGIN ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  const apiOrigin = process.env.API_ORIGIN ?? process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:8080";
  if (!appOrigin) return new Response(null, { status: 503 });
  if (req.method === "POST" && req.headers.get("origin") !== new URL(appOrigin).origin)
    return new Response(null, { status: 403 });

  let body: string | undefined;
  if (req.method === "POST") {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 64 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(chunk.value);
      }
    }
    let input: Record<string, unknown>;
    try {
      input = length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (!input || Array.isArray(input) || typeof input !== "object") throw new Error();
    } catch { return new Response(null, { status: 400 }); }
    if ("refreshToken" in input) return new Response(null, { status: 400 });
    if (key === "passkey/login/verify") input.client = "web";
    body = JSON.stringify(input);
  }
  const headers = new Headers({ Origin: new URL(appOrigin).origin });
  const cookies = (req.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => /^(tl_rt|tl_oauth)=/.test(v));
  if (cookies.length) headers.set("Cookie", cookies.join("; "));
  if (key === "link/google") {
    const bearer = req.headers.get("authorization");
    if (bearer) headers.set("Authorization", bearer);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const url = new URL(route.path, apiOrigin);
  // Only fixed auth routes, never an arbitrary proxy target.
  for (const name of ["returnTo", "code", "state", "error"])
    if (req.nextUrl.searchParams.has(name)) url.searchParams.set(name, req.nextUrl.searchParams.get(name) ?? "");
  const res = await fetch(url, { method: route.method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const out = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const name of ["content-type", "location", "retry-after"])
    if (res.headers.has(name)) out.set(name, res.headers.get(name) as string);
  for (const cookie of res.headers.getSetCookie()) {
    if (!/^(tl_rt|tl_oauth)=/.test(cookie)) continue;
    out.append("Set-Cookie", cookie.replace(/Path=\/v1\/auth/gi, "Path=/session"));
  }
  return new Response(res.body, { status: res.status, headers: out });
}
export { proxy as GET, proxy as POST };
