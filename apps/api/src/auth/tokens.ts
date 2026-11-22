import { randomUUID } from "node:crypto";
import { type Database, schema } from "@travelog/db";
import { type OAuthScope, parseScopes } from "@travelog/domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  type CryptoKey,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import type { Config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { unauthorized } from "../lib/problem.js";

export const FIRST_PARTY_CLIENTS = ["web", "app"] as const;
export type FirstPartyClient = (typeof FIRST_PARTY_CLIENTS)[number];
export const isFirstParty = (c: string): c is FirstPartyClient => c === "web" || c === "app";

/**
 * API 接受的 access token：
 * - web / app：第一方 client
 * - mcp：/mcp 端點替使用者簽發的 60 秒內部權杖（帶 OAuth scope）
 */
export interface AccessClaims {
  userId: string;
  clientId: FirstPartyClient | "mcp";
  scopes: OAuthScope[];
  /** channel=mcp 時，原本授權的 OAuth client。 */
  oauthClientId?: string | undefined;
}

/** /mcp 端點接受的 access token（audience 為 MCP 資源）。 */
export interface McpClaims {
  userId: string;
  oauthClientId: string;
  scopes: OAuthScope[];
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

const ALG = "ES256";
const MCP_ACCESS_TTL = 60 * 60;
const INTERNAL_TTL = 60;

export class TokenService {
  readonly mcpResource: string;

  private constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
    private readonly publicKey: CryptoKey,
    private readonly now: () => Date,
  ) {
    this.mcpResource = `${config.apiOrigin}/mcp`;
  }

  static async create(db: Database, config: Config, now: () => Date = () => new Date()) {
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    if (config.jwt.privateKeyPem) {
      privateKey = await importPKCS8(config.jwt.privateKeyPem, ALG, { extractable: true });
      const { d: _d, ...pub } = await exportJWK(privateKey);
      publicKey = (await crypto.subtle.importKey(
        "jwk",
        { ...pub, key_ops: ["verify"] },
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      )) as CryptoKey;
    } else {
      if (config.env === "production") throw new Error("缺少 JWT_PRIVATE_KEY");
      ({ privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true }));
    }
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.alg = ALG;
    publicJwk.use = "sig";
    return new TokenService(db, config, privateKey, publicJwk, publicKey, now);
  }

  private async sign(claims: JWTPayload, sub: string, audience: string, ttl: number) {
    const iat = Math.floor(this.now().getTime() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALG, kid: this.publicJwk.kid as string, typ: "at+jwt" })
      .setIssuer(this.config.jwt.issuer)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  private async verify(token: string, audience: string) {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.config.jwt.issuer,
      audience,
      algorithms: [ALG],
      typ: "at+jwt",
      currentDate: this.now(),
    });
    if (typeof payload.sub !== "string") throw new Error("missing sub");
    return payload as JWTPayload & { sub: string };
  }

  issueAccessToken(userId: string, clientId: FirstPartyClient): Promise<string> {
    return this.sign(
      { cid: clientId },
      userId,
      this.config.apiOrigin,
      this.config.accessTokenTtlSeconds,
    );
  }

  /** /mcp 呼叫 API 用的內部權杖。不會離開這個程序。 */
  issueInternalToken(userId: string, scopes: OAuthScope[], oauthClientId: string): Promise<string> {
    return this.sign(
      { cid: "mcp", scope: scopes.join(" "), ocid: oauthClientId },
      userId,
      this.config.apiOrigin,
      INTERNAL_TTL,
    );
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const p = await this.verify(token, this.config.apiOrigin);
      if (p.cid === "web" || p.cid === "app") return { userId: p.sub, clientId: p.cid, scopes: [] };
      if (p.cid === "mcp" && typeof p.scope === "string" && typeof p.ocid === "string") {
        return {
          userId: p.sub,
          clientId: "mcp",
          scopes: parseScopes(p.scope),
          oauthClientId: p.ocid,
        };
      }
      throw new Error("invalid cid");
    } catch {
      throw unauthorized("登入已過期或無效");
    }
  }

  async verifyMcpToken(token: string): Promise<McpClaims> {
    try {
      const p = await this.verify(token, this.mcpResource);
      if (typeof p.cid !== "string" || typeof p.scope !== "string")
        throw new Error("invalid claims");
      return { userId: p.sub, oauthClientId: p.cid, scopes: parseScopes(p.scope) };
    } catch {
      throw unauthorized("授權已過期或無效");
    }
  }

  /** 帳號連結用的一次性憑證（5 分鐘）：帶著目前使用者的身分走完 Google 登入流程。 */
  issueLinkToken(userId: string): Promise<string> {
    return this.sign({ purpose: "link" }, userId, `${this.config.apiOrigin}/link`, 300);
  }

  async verifyLinkToken(token: string): Promise<string> {
    try {
      const p = await this.verify(token, `${this.config.apiOrigin}/link`);
      if (p.purpose !== "link") throw new Error("bad purpose");
      return p.sub;
    } catch {
      throw unauthorized("連結已過期，請重新操作");
    }
  }

  /** 第一方登入成功：建立新的 refresh token family。 */
  async issue(userId: string, clientId: FirstPartyClient): Promise<IssuedTokens> {
    const refreshToken = await this.insertRefreshToken(this.db, {
      userId,
      clientId,
      familyId: randomUUID(),
    });
    return {
      accessToken: await this.issueAccessToken(userId, clientId),
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshToken,
    };
  }

  /** OAuth（MCP）授權碼換發。 */
  async issueOAuth(
    userId: string,
    oauthClientId: string,
    scopes: OAuthScope[],
  ): Promise<IssuedTokens> {
    const scope = scopes.join(" ");
    const refreshToken = await this.insertRefreshToken(this.db, {
      userId,
      clientId: oauthClientId,
      familyId: randomUUID(),
      scope,
      resource: this.mcpResource,
    });
    return {
      accessToken: await this.sign(
        { cid: oauthClientId, scope },
        userId,
        this.mcpResource,
        MCP_ACCESS_TTL,
      ),
      expiresIn: MCP_ACCESS_TTL,
      refreshToken,
    };
  }

  /**
   * 輪替 refresh token。先確認 client 相符才輪替（避免送錯端點就把 token 用掉）；
   * 已被替換過的 token 再次使用時，撤銷整個 family（視為外洩）。
   */
  async rotate(
    raw: string,
    expect: (clientId: string) => boolean,
  ): Promise<IssuedTokens & { userId: string; clientId: string; scopes: OAuthScope[] }> {
    const now = this.now();
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256(raw)))
        .for("update");
      if (!row || !expect(row.clientId)) return { ok: false as const };
      if (row.revokedAt || row.replacedAt) {
        await tx
          .update(schema.refreshTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.refreshTokens.familyId, row.familyId),
              isNull(schema.refreshTokens.revokedAt),
            ),
          );
        return { ok: false as const };
      }
      if (row.expiresAt <= now) return { ok: false as const };
      await tx
        .update(schema.refreshTokens)
        .set({ replacedAt: now, lastUsedAt: now })
        .where(eq(schema.refreshTokens.id, row.id));
      const refreshToken = await this.insertRefreshToken(tx, {
        userId: row.userId,
        clientId: row.clientId,
        familyId: row.familyId,
        scope: row.scope,
        resource: row.resource,
      });
      return { ok: true as const, row, refreshToken };
    });

    if (!result.ok) throw unauthorized("登入已過期，請重新登入");
    const { row, refreshToken } = result;
    if (isFirstParty(row.clientId)) {
      return {
        userId: row.userId,
        clientId: row.clientId,
        scopes: [],
        refreshToken,
        accessToken: await this.issueAccessToken(row.userId, row.clientId),
        expiresIn: this.config.accessTokenTtlSeconds,
      };
    }
    const scopes = parseScopes(row.scope);
    return {
      userId: row.userId,
      clientId: row.clientId,
      scopes,
      refreshToken,
      accessToken: await this.sign(
        { cid: row.clientId, scope: scopes.join(" ") },
        row.userId,
        this.mcpResource,
        MCP_ACCESS_TTL,
      ),
      expiresIn: MCP_ACCESS_TTL,
    };
  }

  /** 撤銷這個 token 所屬的整個 family。 */
  async revoke(raw: string, expectClient?: (clientId: string) => boolean): Promise<void> {
    const [row] = await this.db
      .select({ familyId: schema.refreshTokens.familyId, clientId: schema.refreshTokens.clientId })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, sha256(raw)));
    if (!row || (expectClient && !expectClient(row.clientId))) return;
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(schema.refreshTokens.familyId, row.familyId),
          isNull(schema.refreshTokens.revokedAt),
        ),
      );
  }

  /** 使用者是否仍授權這個 OAuth client（撤銷後立即生效，不必等 access token 過期）。 */
  async hasActiveGrant(userId: string, oauthClientId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.refreshTokens.id })
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          eq(schema.refreshTokens.clientId, oauthClientId),
          isNull(schema.refreshTokens.revokedAt),
          gt(schema.refreshTokens.expiresAt, this.now()),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async insertRefreshToken(
    db: Pick<Database, "insert">,
    v: {
      userId: string;
      clientId: string;
      familyId: string;
      scope?: string | null;
      resource?: string | null;
    },
  ): Promise<string> {
    const raw = randomToken(32);
    const expiresAt = new Date(this.now().getTime() + this.config.refreshTokenTtlDays * 86_400_000);
    await db.insert(schema.refreshTokens).values({
      userId: v.userId,
      clientId: v.clientId,
      familyId: v.familyId,
      scope: v.scope ?? null,
      resource: v.resource ?? null,
      tokenHash: sha256(raw),
      expiresAt,
    });
    return raw;
  }
}
