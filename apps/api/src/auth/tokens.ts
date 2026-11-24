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
  familyId: string;
  /** channel=mcp 時，原本授權的 OAuth client。 */
  oauthClientId?: string | undefined;
}

/** /mcp 端點接受的 access token（audience 為 MCP 資源）。 */
export interface McpClaims {
  userId: string;
  oauthClientId: string;
  scopes: OAuthScope[];
  familyId: string;
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

  async assertActiveUser(userId: string, db: Pick<Database, "select"> = this.db) {
    const [user] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    if (!user) throw unauthorized("帳號已失效");
  }

  private async createGrant(userId: string, clientId: string, scope?: string, resource?: string) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(schema.users)
        .where(eq(schema.users.id, userId)).for("update");
      if (!user || user.deletedAt) throw unauthorized("帳號已失效");
      const familyId = randomUUID();
      const refreshToken = await this.insertRefreshToken(tx, {
        userId, clientId, familyId, ...(scope !== undefined ? { scope } : {}),
        ...(resource !== undefined ? { resource } : {}),
      });
      return { familyId, refreshToken };
    });
  }

  async issueAccessToken(userId: string, clientId: FirstPartyClient, familyId?: string): Promise<string> {
    await this.assertActiveUser(userId);
    const family = familyId ?? (await this.createGrant(userId, clientId)).familyId;
    return this.sign({ cid: clientId, fid: family }, userId,
      this.config.apiOrigin, this.config.accessTokenTtlSeconds);
  }

  /** /mcp 呼叫 API 用的內部權杖，也綁定相同的授權 family。 */
  async issueInternalToken(userId: string, scopes: OAuthScope[], oauthClientId: string, familyId?: string): Promise<string> {
    await this.assertActiveUser(userId);
    const family = familyId ?? (await this.createGrant(userId, oauthClientId, scopes.join(" "), this.mcpResource)).familyId;
    if (!(await this.hasActiveGrant(userId, oauthClientId, family, scopes))) throw unauthorized();
    return this.sign({ cid: "mcp", scope: scopes.join(" "), ocid: oauthClientId, fid: family },
      userId, this.config.apiOrigin, INTERNAL_TTL);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const p = await this.verify(token, this.config.apiOrigin);
      await this.assertActiveUser(p.sub);
      if (typeof p.fid !== "string") throw new Error("missing family");
      if (p.cid === "web" || p.cid === "app") {
        if (!(await this.hasActiveGrant(p.sub, p.cid, p.fid))) throw new Error("revoked");
        return { userId: p.sub, clientId: p.cid, familyId: p.fid, scopes: [] };
      }
      if (p.cid === "mcp" && typeof p.scope === "string" && typeof p.ocid === "string") {
        const scopes = parseScopes(p.scope);
        if (!(await this.hasActiveGrant(p.sub, p.ocid, p.fid, scopes))) throw new Error("revoked");
        return { userId: p.sub, clientId: "mcp", familyId: p.fid, scopes, oauthClientId: p.ocid };
      }
      throw new Error("invalid cid");
    } catch { throw unauthorized("登入已過期或無效"); }
  }

  async verifyMcpToken(token: string): Promise<McpClaims> {
    try {
      const p = await this.verify(token, this.mcpResource);
      if (typeof p.cid !== "string" || typeof p.scope !== "string" || typeof p.fid !== "string") throw new Error("invalid claims");
      await this.assertActiveUser(p.sub);
      const scopes = parseScopes(p.scope);
      if (!(await this.hasActiveGrant(p.sub, p.cid, p.fid, scopes))) throw new Error("revoked");
      return { userId: p.sub, oauthClientId: p.cid, familyId: p.fid, scopes };
    } catch { throw unauthorized("授權已過期或無效"); }
  }

  /** 不輪替 cookie；只用於驗證同一瀏覽器的帳號連結交易。 */
  async webSession(raw: string | undefined) {
    if (!raw) throw unauthorized();
    const [row] = await this.db.select().from(schema.refreshTokens).where(and(
      eq(schema.refreshTokens.tokenHash, sha256(raw)), eq(schema.refreshTokens.clientId, "web"),
      isNull(schema.refreshTokens.revokedAt), isNull(schema.refreshTokens.replacedAt),
      gt(schema.refreshTokens.expiresAt, this.now()),
    ));
    if (!row) throw unauthorized();
    await this.assertActiveUser(row.userId);
    return row;
  }

  /** 第一方登入成功：建立新的 refresh token family。 */
  async issue(userId: string, clientId: FirstPartyClient): Promise<IssuedTokens> {
    const { refreshToken, familyId } = await this.createGrant(userId, clientId);
    return {
      accessToken: await this.issueAccessToken(userId, clientId, familyId),
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
    const { refreshToken, familyId } = await this.createGrant(userId, oauthClientId, scope, this.mcpResource);
    return {
      accessToken: await this.sign(
        { cid: oauthClientId, scope, fid: familyId },
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
      const [candidate] = await tx.select({ userId: schema.refreshTokens.userId }).from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256(raw)));
      if (!candidate) return { ok: false as const };
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, candidate.userId)).for("update");
      if (!user || user.deletedAt) return { ok: false as const };
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
        accessToken: await this.issueAccessToken(row.userId, row.clientId, row.familyId),
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
        { cid: row.clientId, scope: scopes.join(" "), fid: row.familyId },
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
  async hasActiveGrant(userId: string, oauthClientId: string, familyId: string, scopes: OAuthScope[] = []): Promise<boolean> {
    const [row] = await this.db
      .select({ scope: schema.refreshTokens.scope })
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          eq(schema.refreshTokens.clientId, oauthClientId),
          eq(schema.refreshTokens.familyId, familyId),
          isNull(schema.refreshTokens.replacedAt),
          isNull(schema.refreshTokens.revokedAt),
          gt(schema.refreshTokens.expiresAt, this.now()),
        ),
      )
      .limit(1);
    return !!row && scopes.every((scope) => parseScopes(row.scope).includes(scope));
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
      createdAt: this.now(),
      expiresAt,
    });
    return raw;
  }
}
