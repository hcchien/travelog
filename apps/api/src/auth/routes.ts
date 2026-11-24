import { createHash } from "node:crypto";
import { schema } from "@travelog/db";
import { googleNativeLoginInput, refreshInput } from "@travelog/schema";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { requireAuth } from "../lib/middleware.js";
import { conflict, notFound, unauthorized } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { findOrCreateUser, linkIdentity } from "./identities.js";
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

/** Web session is relayed by the same-origin BFF; refresh credentials are never returned to JS. */
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

  async function beginGoogle(
    c: Parameters<typeof setOAuthState>[0],
    link?: { userId: string; familyId: string },
  ) {
    const verifier = randomToken(32);
    const state = randomToken(32);
    const nonce = randomToken(32);
    await deps.db.insert(schema.browserAuthStates).values({
      stateHash: sha256(state),
      userId: link?.userId ?? null,
      expiresAt: new Date(deps.now().getTime() + 600_000),
    });
    await setOAuthState(c, config, {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(c.req.query("returnTo")),
      ...(link ? { linkUserId: link.userId, linkFamilyId: link.familyId } : {}),
    });
    return google.authorizationUrl({
      state,
      nonce,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    });
  }

  app.get("/v1/auth/google", async (c) => {
    // Legacy transferable link tokens are deliberately not accepted.
    if (c.req.query("link")) throw unauthorized("請從帳號設定重新開始連結");
    return c.redirect(await beginGoogle(c), 302);
  });

  app.get("/v1/auth/google/callback", async (c) => {
    const saved = await takeOAuthState(c, config);
    const code = c.req.query("code");
    if (!saved || !code || c.req.query("state") !== saved.state) {
      return c.redirect(`${config.appOrigin}/login?error=state`, 302);
    }
    const [transaction] = await deps.db
      .delete(schema.browserAuthStates)
      .where(
        and(
          eq(schema.browserAuthStates.stateHash, sha256(saved.state)),
          gt(schema.browserAuthStates.expiresAt, deps.now()),
        ),
      )
      .returning();
    if (!transaction) return c.redirect(`${config.appOrigin}/login?error=state`, 302);
    try {
      const { idToken } = await google.exchangeCode({ code, codeVerifier: saved.verifier });
      const profile = await google.verifyIdToken(idToken, { nonce: saved.nonce });
      if (saved.linkUserId) {
        // 帳號連結：不建立新帳號、不換發登入狀態
        const session = await tokens.webSession(getRefreshCookie(c));
        if (session.userId !== saved.linkUserId || session.familyId !== saved.linkFamilyId)
          throw unauthorized();
        const result = await linkIdentity(
          deps.db,
          saved.linkUserId,
          "google",
          profile,
          session.familyId,
          deps.now(),
        );
        return c.redirect(`${config.appOrigin}/settings?link=${result}`, 302);
      }
      const { userId } = await findOrCreateUser(deps.db, "google", profile);
      const issued = await tokens.issue(userId, "web");
      setRefreshCookie(c, config, issued.refreshToken);
      const target = `${config.appOrigin}${saved.returnTo}`;
      return c.redirect(target, 302);
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
      const rotated = await tokens.rotate(body.refreshToken, (cid) => cid === "app");
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
      const rotated = await tokens.rotate(cookie, (cid) => cid === "web");
      return respondWithTokens(c, deps, "web", rotated);
    } catch (err) {
      clearRefreshCookie(c, config);
      throw err;
    }
  });

  app.post("/v1/auth/logout", validate("json", refreshInput), async (c) => {
    const body = c.req.valid("json");
    if (body.refreshToken) {
      await tokens.revoke(body.refreshToken, (cid) => cid === "app");
    } else {
      assertAllowedOrigin(c, config);
      const cookie = getRefreshCookie(c);
      if (cookie) await tokens.revoke(cookie, (cid) => cid === "web");
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

  // ---- 帳號連結
  app.post("/v1/me/identities/link/google", requireAuth(deps), async (c) => {
    const me = c.get("auth");
    assertAllowedOrigin(c, config);
    if (me.clientId !== "web") throw unauthorized("請在 Travelog 網站連結帳號");
    const session = await tokens.webSession(getRefreshCookie(c));
    if (session.userId !== me.userId || session.familyId !== me.familyId) throw unauthorized();
    const [first] = await deps.db
      .select({ createdAt: schema.refreshTokens.createdAt })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.familyId, session.familyId))
      .orderBy(asc(schema.refreshTokens.createdAt))
      .limit(1);
    if (!first || deps.now().getTime() - first.createdAt.getTime() > 600_000)
      throw unauthorized("新增登入方式前，請先登出並重新登入");
    return c.json({ url: await beginGoogle(c, session) });
  });

  /** 移除登入方式：帳號至少要保留一個 Google 或 Apple 身分。 */
  app.delete("/v1/me/identities/:id", requireAuth(deps), async (c) => {
    const me = c.get("auth");
    if (me.clientId !== "web" && me.clientId !== "app") throw unauthorized();
    await deps.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, me.userId))
        .for("update");
      await tokens.assertActiveUser(me.userId, tx);
      const identities = await tx
        .select({ id: schema.userIdentities.id })
        .from(schema.userIdentities)
        .where(eq(schema.userIdentities.userId, me.userId));
      if (!identities.some((i) => i.id === c.req.param("id"))) throw notFound("登入方式");
      if (identities.length <= 1) throw conflict("至少要保留一個 Google 或 Apple 登入方式");
      await tx.delete(schema.userIdentities).where(eq(schema.userIdentities.id, c.req.param("id")));
    });
    return c.body(null, 204);
  });

  return app;
}
