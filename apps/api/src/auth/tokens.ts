import { randomUUID } from "node:crypto";
import { type Database, schema } from "@travelog/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  type CryptoKey,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import type { Config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { unauthorized } from "../lib/problem.js";

export const FIRST_PARTY_CLIENTS = ["web", "app"] as const;
export type FirstPartyClient = (typeof FIRST_PARTY_CLIENTS)[number];

export interface AccessClaims {
  userId: string;
  clientId: FirstPartyClient;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

const ALG = "ES256";

export class TokenService {
  private constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
    private readonly publicKey: CryptoKey,
    private readonly now: () => Date,
  ) {}

  static async create(db: Database, config: Config, now: () => Date = () => new Date()) {
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    if (config.jwt.privateKeyPem) {
      privateKey = await importPKCS8(config.jwt.privateKeyPem, ALG, { extractable: true });
      // 從私鑰推出公鑰
      const jwk = await exportJWK(privateKey);
      const { d: _d, ...pub } = jwk;
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

  async issueAccessToken(userId: string, clientId: FirstPartyClient): Promise<string> {
    const iat = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ cid: clientId })
      .setProtectedHeader({ alg: ALG, kid: this.publicJwk.kid as string, typ: "at+jwt" })
      .setIssuer(this.config.jwt.issuer)
      .setAudience(this.config.apiOrigin)
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.accessTokenTtlSeconds)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.config.jwt.issuer,
        audience: this.config.apiOrigin,
        algorithms: [ALG],
        typ: "at+jwt",
        currentDate: this.now(),
      });
      const cid = payload.cid;
      if (typeof payload.sub !== "string" || (cid !== "web" && cid !== "app")) {
        throw new Error("invalid claims");
      }
      return { userId: payload.sub, clientId: cid };
    } catch {
      throw unauthorized("登入已過期或無效");
    }
  }

  /** 登入成功時呼叫：建立新的 refresh token family。 */
  async issue(userId: string, clientId: FirstPartyClient): Promise<IssuedTokens> {
    const refreshToken = await this.insertRefreshToken(this.db, userId, clientId, randomUUID());
    return {
      accessToken: await this.issueAccessToken(userId, clientId),
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshToken,
    };
  }

  /**
   * 輪替 refresh token。已被替換過的 token 再次使用時，撤銷整個 family（視為外洩）。
   */
  async rotate(raw: string): Promise<IssuedTokens & AccessClaims> {
    const now = this.now();
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256(raw)))
        .for("update");
      if (!row) return { ok: false as const };

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

      const clientId = row.clientId as FirstPartyClient;
      await tx
        .update(schema.refreshTokens)
        .set({ replacedAt: now, lastUsedAt: now })
        .where(eq(schema.refreshTokens.id, row.id));
      const refreshToken = await this.insertRefreshToken(tx, row.userId, clientId, row.familyId);
      return { ok: true as const, userId: row.userId, clientId, refreshToken };
    });

    if (!result.ok) throw unauthorized("登入已過期，請重新登入");
    return {
      userId: result.userId,
      clientId: result.clientId,
      refreshToken: result.refreshToken,
      accessToken: await this.issueAccessToken(result.userId, result.clientId),
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  /** 登出：撤銷這個 token 所屬的整個 family。 */
  async revoke(raw: string): Promise<void> {
    const [row] = await this.db
      .select({ familyId: schema.refreshTokens.familyId })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, sha256(raw)));
    if (!row) return;
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

  private async insertRefreshToken(
    db: Pick<Database, "insert">,
    userId: string,
    clientId: string,
    familyId: string,
  ): Promise<string> {
    const raw = randomToken(32);
    const expiresAt = new Date(this.now().getTime() + this.config.refreshTokenTtlDays * 86_400_000);
    await db
      .insert(schema.refreshTokens)
      .values({ userId, clientId, familyId, tokenHash: sha256(raw), expiresAt });
    return raw;
  }
}
