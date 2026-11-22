import { createHash } from "node:crypto";
import { schema } from "@travelog/db";
import { OAUTH_SCOPES, type OAuthScope, parseScopes, SCOPE_LABELS } from "@travelog/domain";
import { and, eq, gt, isNull, notInArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { isFirstParty } from "../auth/tokens.js";
import type { AppEnv, Deps } from "../context.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, conflict, notFound } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import {
  clientMetadata,
  fetchClientMetadataOverHttps,
  findClient,
  isAllowedRedirectUri,
} from "./clients.js";

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;

/** RFC 6749 §5.2 的錯誤格式。 */
function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  return c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  }
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
}

const decisionInput = z.object({
  approve: z.boolean(),
  scopes: z.array(z.enum(OAUTH_SCOPES)).optional(),
});

/**
 * OAuth 2.1 授權伺服器（給 MCP client 用）。ARCHITECTURE §4.2。
 * 只支援 public client（PKCE S256，不使用 client secret）。
 */
export function oauthRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, config, tokens, now } = deps;
  const issuer = config.apiOrigin;
  const fetchMetadata = deps.fetchClientMetadata ?? fetchClientMetadataOverHttps;
  const lookup = (clientId: string) => findClient(db, clientId, { fetchMetadata, now });
  const auth = requireAuth(deps);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OAUTH_SCOPES,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  // ---- Dynamic Client Registration（RFC 7591）
  app.post("/oauth/register", async (c) => {
    const parsed = clientMetadata.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return oauthError(c, "invalid_client_metadata", "client metadata 格式錯誤");
    const meta = parsed.data;
    if (!meta.redirect_uris.every(isAllowedRedirectUri)) {
      return oauthError(
        c,
        "invalid_redirect_uri",
        "redirect_uri 必須是 https，或本機 http://localhost",
      );
    }
    const clientId = `tlc_${randomToken(18)}`;
    const [row] = await db
      .insert(schema.oauthClients)
      .values({
        clientId,
        kind: "dcr",
        clientName: meta.client_name ?? null,
        clientUri: meta.client_uri ?? null,
        logoUri: meta.logo_uri ?? null,
        redirectUris: meta.redirect_uris,
      })
      .returning();
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor((row?.createdAt ?? now()).getTime() / 1000),
        client_name: meta.client_name,
        redirect_uris: meta.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  // ---- 授權端點：驗證後轉到 Web 的同意頁
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const client = q.client_id ? await lookup(q.client_id) : null;
    // client 或 redirect_uri 不對時，不能導回去（避免 open redirect），直接顯示錯誤
    if (!client)
      throw new ApiError(400, "/problems/oauth-invalid-client", "未知的應用程式（client_id）");
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      throw new ApiError(400, "/problems/oauth-invalid-redirect", "redirect_uri 與註冊的不符");
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri as string);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", issuer);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code")
      return back("unsupported_response_type", "只支援 response_type=code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back("invalid_request", "需要 PKCE（code_challenge_method=S256）");
    }
    if (q.resource && q.resource !== tokens.mcpResource)
      return back("invalid_target", "不支援的 resource");

    const [req] = await db
      .insert(schema.oauthRequests)
      .values({
        clientId: client.clientId,
        redirectUri: q.redirect_uri,
        scope: parseScopes(q.scope).join(" "),
        state: q.state ?? null,
        codeChallenge: q.code_challenge,
        resource: tokens.mcpResource,
        expiresAt: new Date(now().getTime() + REQUEST_TTL_MS),
      })
      .returning({ id: schema.oauthRequests.id });
    return c.redirect(`${config.appOrigin}/oauth/consent?request=${req?.id}`, 302);
  });

  // ---- 同意頁用（第一方，需登入）
  async function loadPending(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("授權請求");
    const [req] = await db
      .select()
      .from(schema.oauthRequests)
      .where(eq(schema.oauthRequests.id, id));
    if (!req) throw notFound("授權請求");
    if (req.status !== "pending" || req.expiresAt <= now()) {
      throw new ApiError(
        410,
        "/problems/oauth-request-expired",
        "這個授權請求已過期，請回到應用程式重新連線",
      );
    }
    const client = await lookup(req.clientId);
    if (!client) throw notFound("應用程式");
    return { req, client };
  }

  const assertFirstParty = (c: Context<AppEnv>) => {
    if (!isFirstParty(c.get("auth").clientId))
      throw new ApiError(403, "/problems/forbidden", "只能在 Travelog 中操作");
  };

  app.get("/v1/oauth/requests/:id", auth, async (c) => {
    assertFirstParty(c);
    const { req, client } = await loadPending(c.req.param("id"));
    return c.json({
      id: req.id,
      client: {
        name: client.clientName ?? "未命名的應用程式",
        uri: client.clientUri,
        logoUri: client.logoUri,
        verifiedDomain: client.kind === "cimd" ? new URL(client.clientId).hostname : null,
      },
      redirectHost: new URL(req.redirectUri).host,
      scopes: parseScopes(req.scope).map((s) => ({ scope: s, label: SCOPE_LABELS[s] })),
    });
  });

  app.post("/v1/oauth/requests/:id/decision", auth, validate("json", decisionInput), async (c) => {
    assertFirstParty(c);
    const me = c.get("auth");
    const { approve, scopes } = c.req.valid("json");
    const { req } = await loadPending(c.req.param("id"));
    const redirect = new URL(req.redirectUri);
    if (req.state) redirect.searchParams.set("state", req.state);
    redirect.searchParams.set("iss", issuer);

    if (!approve) {
      await db
        .update(schema.oauthRequests)
        .set({ status: "denied" })
        .where(eq(schema.oauthRequests.id, req.id));
      redirect.searchParams.set("error", "access_denied");
      return c.json({ redirectTo: redirect.toString() });
    }
    const requested = parseScopes(req.scope);
    const granted: OAuthScope[] = scopes ? requested.filter((s) => scopes.includes(s)) : requested;
    if (!granted.includes("trips:read")) granted.unshift("trips:read");
    const code = randomToken(32);
    await db
      .update(schema.oauthRequests)
      .set({
        status: "approved",
        userId: me.userId,
        grantedScope: granted.join(" "),
        codeHash: sha256(code),
        codeExpiresAt: new Date(now().getTime() + CODE_TTL_MS),
      })
      .where(eq(schema.oauthRequests.id, req.id));
    redirect.searchParams.set("code", code);
    return c.json({ redirectTo: redirect.toString() });
  });

  // ---- Token 端點
  app.post("/oauth/token", async (c) => {
    const f = await readForm(c);
    if (f.grant_type === "authorization_code") {
      if (!f.code || !f.client_id || !f.redirect_uri || !f.code_verifier) {
        return oauthError(c, "invalid_request", "缺少必要參數");
      }
      const [req] = await db
        .select()
        .from(schema.oauthRequests)
        .where(eq(schema.oauthRequests.codeHash, sha256(f.code)));
      const valid =
        req &&
        req.status === "approved" &&
        req.userId &&
        req.codeExpiresAt &&
        req.codeExpiresAt > now() &&
        req.clientId === f.client_id &&
        req.redirectUri === f.redirect_uri &&
        (!f.resource || f.resource === req.resource) &&
        createHash("sha256").update(f.code_verifier).digest("base64url") === req.codeChallenge;
      if (!valid || !req?.userId)
        return oauthError(c, "invalid_grant", "授權碼無效、已使用或已過期");
      // 單次使用：只有成功把狀態從 approved 改成 used 的請求能換發
      const used = await db
        .update(schema.oauthRequests)
        .set({ status: "used" })
        .where(
          and(eq(schema.oauthRequests.id, req.id), eq(schema.oauthRequests.status, "approved")),
        )
        .returning({ id: schema.oauthRequests.id });
      if (used.length === 0) return oauthError(c, "invalid_grant", "授權碼已使用");

      const issued = await tokens.issueOAuth(
        req.userId,
        req.clientId,
        parseScopes(req.grantedScope),
      );
      return c.json(
        {
          access_token: issued.accessToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
          scope: parseScopes(req.grantedScope).join(" "),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    }

    if (f.grant_type === "refresh_token") {
      if (!f.refresh_token || !f.client_id) return oauthError(c, "invalid_request", "缺少必要參數");
      try {
        const r = await tokens.rotate(
          f.refresh_token,
          (cid) => cid === f.client_id && !isFirstParty(cid),
        );
        return c.json(
          {
            access_token: r.accessToken,
            token_type: "Bearer",
            expires_in: r.expiresIn,
            refresh_token: r.refreshToken,
            scope: r.scopes.join(" "),
          },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch {
        return oauthError(c, "invalid_grant", "refresh token 無效或已撤銷");
      }
    }
    return oauthError(c, "unsupported_grant_type", "只支援 authorization_code 與 refresh_token");
  });

  // RFC 7009：不論 token 是否存在都回 200
  app.post("/oauth/revoke", async (c) => {
    const f = await readForm(c);
    if (f.token && f.client_id)
      await tokens.revoke(f.token, (cid) => cid === f.client_id && !isFirstParty(cid));
    return c.body(null, 200);
  });

  // ---- 已連線的應用程式
  app.get("/v1/me/connections", auth, async (c) => {
    assertFirstParty(c);
    const { userId } = c.get("auth");
    const rows = await db
      .select({
        clientId: schema.refreshTokens.clientId,
        scope: schema.refreshTokens.scope,
        createdAt: schema.refreshTokens.createdAt,
        lastUsedAt: schema.refreshTokens.lastUsedAt,
        name: schema.oauthClients.clientName,
        kind: schema.oauthClients.kind,
      })
      .from(schema.refreshTokens)
      .leftJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.refreshTokens.clientId),
      )
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          notInArray(schema.refreshTokens.clientId, ["web", "app"]),
          isNull(schema.refreshTokens.revokedAt),
          isNull(schema.refreshTokens.replacedAt),
          gt(schema.refreshTokens.expiresAt, now()),
        ),
      );
    const byClient = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = byClient.get(r.clientId);
      if (!prev || r.createdAt > prev.createdAt) byClient.set(r.clientId, r);
    }
    return c.json({
      connections: [...byClient.values()].map((r) => ({
        clientId: r.clientId,
        name: r.name ?? "未命名的應用程式",
        verifiedDomain: r.kind === "cimd" ? new URL(r.clientId).hostname : null,
        scopes: parseScopes(r.scope),
        lastUsedAt: r.lastUsedAt ?? r.createdAt,
      })),
    });
  });

  app.delete("/v1/me/connections/:clientId", auth, async (c) => {
    assertFirstParty(c);
    const { userId } = c.get("auth");
    const clientId = decodeURIComponent(c.req.param("clientId"));
    if (isFirstParty(clientId)) throw conflict("不能在這裡撤銷 Travelog 本身的登入");
    const rows = await db
      .update(schema.refreshTokens)
      .set({ revokedAt: now() })
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          eq(schema.refreshTokens.clientId, clientId),
          isNull(schema.refreshTokens.revokedAt),
        ),
      )
      .returning({ id: schema.refreshTokens.id });
    if (rows.length === 0) throw notFound("已連線的應用程式");
    return c.body(null, 204);
  });

  return app;
}
