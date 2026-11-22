import { createHash } from "node:crypto";
import { schema } from "@travelog/db";
import { googleNativeLoginInput, refreshInput } from "@travelog/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { randomToken } from "../lib/crypto.js";
import { requireAuth } from "../lib/middleware.js";
import { notFound, unauthorized } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { findOrCreateUser } from "./identities.js";
import {
  assertAllowedOrigin,
  clearRefreshCookie,
  getRefreshCookie,
  safeReturnTo,
  setOAuthState,
  setRefreshCookie,
  takeOAuthState,
} from "./session.js";
import type { FirstPartyClient, IssuedTokens } from "./tokens.js";

/** 依 client 回傳權杖：Web 的 refresh token 只放 HttpOnly cookie。 */
export function respondWithTokens(
  // biome-ignore lint/suspicious/noExplicitAny: Hono Context 泛型在不同路由間不同
  c: any,
  deps: Deps,
  client: FirstPartyClient,
  tokens: IssuedTokens,
) {
  if (client === "web") {
    setRefreshCookie(c, deps.config, tokens.refreshToken);
    return c.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  }
  return c.json(tokens);
}

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { config, google, tokens } = deps;

  // ---- Google（網頁）
  app.get("/v1/auth/google", async (c) => {
    const verifier = randomToken(32);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    await setOAuthState(c, config, {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(c.req.query("returnTo")),
    });
    return c.redirect(google.authorizationUrl({ state, nonce, codeChallenge }), 302);
  });

  app.get("/v1/auth/google/callback", async (c) => {
    const saved = await takeOAuthState(c, config);
    const code = c.req.query("code");
    if (!saved || !code || c.req.query("state") !== saved.state) {
      return c.redirect(`${config.appOrigin}/login?error=state`, 302);
    }
    try {
      const { idToken } = await google.exchangeCode({ code, codeVerifier: saved.verifier });
      const profile = await google.verifyIdToken(idToken, { nonce: saved.nonce });
      const { userId } = await findOrCreateUser(deps.db, "google", profile);
      const issued = await tokens.issue(userId, "web");
      setRefreshCookie(c, config, issued.refreshToken);
      return c.redirect(`${config.appOrigin}${saved.returnTo}`, 302);
    } catch {
      return c.redirect(`${config.appOrigin}/login?error=google`, 302);
    }
  });

  // ---- Google（原生 App）
  app.post("/v1/auth/google/native", validate("json", googleNativeLoginInput), async (c) => {
    const { idToken, nonce } = c.req.valid("json");
    const profile = await google.verifyIdToken(idToken, { nonce });
    const { userId } = await findOrCreateUser(deps.db, "google", profile);
    return c.json(await tokens.issue(userId, "app"));
  });

  // ---- Refresh / Logout
  app.post("/v1/auth/refresh", validate("json", refreshInput), async (c) => {
    const body = c.req.valid("json");
    if (body.refreshToken) {
      const rotated = await tokens.rotate(body.refreshToken);
      if (rotated.clientId !== "app") throw unauthorized();
      return c.json({
        accessToken: rotated.accessToken,
        expiresIn: rotated.expiresIn,
        refreshToken: rotated.refreshToken,
      });
    }
    assertAllowedOrigin(c, config);
    const cookie = getRefreshCookie(c);
    if (!cookie) throw unauthorized();
    try {
      const rotated = await tokens.rotate(cookie);
      if (rotated.clientId !== "web") throw unauthorized();
      return respondWithTokens(c, deps, "web", rotated);
    } catch (err) {
      clearRefreshCookie(c, config);
      throw err;
    }
  });

  app.post("/v1/auth/logout", validate("json", refreshInput), async (c) => {
    const body = c.req.valid("json");
    if (body.refreshToken) {
      await tokens.revoke(body.refreshToken);
    } else {
      assertAllowedOrigin(c, config);
      const cookie = getRefreshCookie(c);
      if (cookie) await tokens.revoke(cookie);
      clearRefreshCookie(c, config);
    }
    return c.body(null, 204);
  });

  app.get("/.well-known/jwks.json", (c) => c.json({ keys: [tokens.publicJwk] }));

  // ---- 目前使用者
  app.get("/v1/me", requireAuth(deps), async (c) => {
    const { userId } = c.get("auth");
    const user = await deps.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: {
        id: true,
        displayName: true,
        avatarUrl: true,
        primaryEmail: true,
        defaultTz: true,
        locale: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt) throw notFound("使用者");
    const identities = await deps.db
      .select({
        id: schema.userIdentities.id,
        provider: schema.userIdentities.provider,
        email: schema.userIdentities.email,
        isPrivateRelay: schema.userIdentities.isPrivateRelay,
      })
      .from(schema.userIdentities)
      .where(eq(schema.userIdentities.userId, userId));
    const { deletedAt: _deleted, ...profile } = user;
    return c.json({ ...profile, identities });
  });

  return app;
}
