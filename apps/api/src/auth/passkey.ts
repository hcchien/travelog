import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { schema } from "@travelog/db";
import {
  passkeyLoginVerifyInput,
  passkeyRegisterVerifyInput,
  renamePasskeyInput,
} from "@travelog/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { ApiError, notFound, unauthorized } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { respondWithTokens } from "./routes.js";
import { assertAllowedOrigin } from "./session.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

const failed = () => new ApiError(400, "/problems/passkey-failed", "Passkey 驗證失敗");

/**
 * Passkey（WebAuthn）。依規格：只能由已登入的使用者新增，不能用來註冊新帳號。
 */
export function passkeyRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, config, now } = deps;
  const { rpId, rpName, origins } = config.webauthn;

  async function saveChallenge(
    challenge: string,
    purpose: "register" | "login",
    userId: string | null,
  ) {
    const [row] = await db
      .insert(schema.webauthnChallenges)
      .values({
        challenge,
        purpose,
        userId,
        expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS),
      })
      .returning({ id: schema.webauthnChallenges.id });
    if (!row) throw new Error("儲存 challenge 失敗");
    return row.id;
  }

  /** 取出並刪除 challenge（單次使用）。 */
  async function consumeChallenge(
    id: string,
    purpose: "register" | "login",
    userId: string | null,
  ) {
    const [row] = await db
      .delete(schema.webauthnChallenges)
      .where(eq(schema.webauthnChallenges.id, id))
      .returning();
    if (!row || row.purpose !== purpose || row.expiresAt <= now() || row.userId !== userId) {
      throw failed();
    }
    return row.challenge;
  }

  // ---- 登入（不需要先輸入帳號：discoverable credential）
  app.post("/v1/auth/passkey/login/options", async (c) => {
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "preferred",
    });
    const challengeId = await saveChallenge(options.challenge, "login", null);
    return c.json({ challengeId, options });
  });

  app.post(
    "/v1/auth/passkey/login/verify",
    validate("json", passkeyLoginVerifyInput),
    async (c) => {
      const body = c.req.valid("json");
      if (body.client === "web") assertAllowedOrigin(c, config);
      const expectedChallenge = await consumeChallenge(body.challengeId, "login", null);
      const response = body.response as unknown as AuthenticationResponseJSON;

      let credentialId: Uint8Array;
      try {
        credentialId = isoBase64URL.toBuffer(response.id);
      } catch {
        throw failed();
      }
      const [cred] = await db
        .select()
        .from(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.credentialId, credentialId));
      if (!cred) throw unauthorized("找不到這把 Passkey，請改用 Google 或 Apple 登入");

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
          credential: {
            id: response.id,
            publicKey: new Uint8Array(cred.publicKey),
            counter: cred.signCount,
            transports: cred.transports as AuthenticatorTransport[],
          },
        });
      } catch {
        throw failed();
      }
      if (!verification.verified) throw failed();

      const { newCounter } = verification.authenticationInfo;
      // 同步型 Passkey 的計數通常一直是 0；只有計數真的倒退時才記錄警示。
      if (cred.signCount > 0 && newCounter <= cred.signCount) {
        console.warn(`passkey counter did not increase: credential=${cred.id}`);
      }
      await db
        .update(schema.webauthnCredentials)
        .set({ signCount: newCounter, lastUsedAt: now() })
        .where(eq(schema.webauthnCredentials.id, cred.id));

      const user = await db.query.users.findFirst({
        where: eq(schema.users.id, cred.userId),
        columns: { deletedAt: true },
      });
      if (!user || user.deletedAt) throw unauthorized();

      return respondWithTokens(
        c,
        deps,
        body.client,
        await deps.tokens.issue(cred.userId, body.client),
      );
    },
  );

  // ---- 新增 Passkey（必須已登入）
  // 每個路由個別掛 requireAuth，避免 "*" middleware 在掛載後影響其他路由。
  const authed = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  authed.post("/v1/auth/passkey/register/options", auth, async (c) => {
    const { userId } = c.get("auth");
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    if (!user) throw notFound("使用者");
    const existing = await db
      .select({
        credentialId: schema.webauthnCredentials.credentialId,
        transports: schema.webauthnCredentials.transports,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));

    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userID: new Uint8Array(user.webauthnUserHandle),
      userName: user.primaryEmail ?? user.displayName,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existing.map((e) => ({
        id: isoBase64URL.fromBuffer(new Uint8Array(e.credentialId)),
        transports: e.transports,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await saveChallenge(options.challenge, "register", userId);
    return c.json({ challengeId, options });
  });

  authed.post(
    "/v1/auth/passkey/register/verify",
    auth,
    validate("json", passkeyRegisterVerifyInput),
    async (c) => {
      const { userId } = c.get("auth");
      const body = c.req.valid("json");
      const expectedChallenge = await consumeChallenge(body.challengeId, "register", userId);

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
        });
      } catch {
        throw failed();
      }
      if (!verification.verified) throw failed();

      const info = verification.registrationInfo;
      const [row] = await db
        .insert(schema.webauthnCredentials)
        .values({
          userId,
          credentialId: isoBase64URL.toBuffer(info.credential.id),
          publicKey: info.credential.publicKey,
          signCount: info.credential.counter,
          transports: info.credential.transports ?? [],
          aaguid: info.aaguid,
          backedUp: info.credentialBackedUp,
          deviceType: info.credentialDeviceType,
          name: body.name ?? "Passkey",
        })
        .returning({
          id: schema.webauthnCredentials.id,
          name: schema.webauthnCredentials.name,
          createdAt: schema.webauthnCredentials.createdAt,
        });
      return c.json(row, 201);
    },
  );

  // ---- 管理 Passkey
  authed.get("/v1/me/passkeys", auth, async (c) => {
    const { userId } = c.get("auth");
    const rows = await db
      .select({
        id: schema.webauthnCredentials.id,
        name: schema.webauthnCredentials.name,
        backedUp: schema.webauthnCredentials.backedUp,
        createdAt: schema.webauthnCredentials.createdAt,
        lastUsedAt: schema.webauthnCredentials.lastUsedAt,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));
    return c.json({ passkeys: rows });
  });

  authed.patch("/v1/me/passkeys/:id", auth, validate("json", renamePasskeyInput), async (c) => {
    const { userId } = c.get("auth");
    const [row] = await db
      .update(schema.webauthnCredentials)
      .set({ name: c.req.valid("json").name })
      .where(
        and(
          eq(schema.webauthnCredentials.id, c.req.param("id")),
          eq(schema.webauthnCredentials.userId, userId),
        ),
      )
      .returning({ id: schema.webauthnCredentials.id, name: schema.webauthnCredentials.name });
    if (!row) throw notFound("Passkey");
    return c.json(row);
  });

  // 帳號必定有 Google／Apple 身分，所以刪除任何一把 Passkey 都不會讓帳號無法登入。
  authed.delete("/v1/me/passkeys/:id", auth, async (c) => {
    const { userId } = c.get("auth");
    const rows = await db
      .delete(schema.webauthnCredentials)
      .where(
        and(
          eq(schema.webauthnCredentials.id, c.req.param("id")),
          eq(schema.webauthnCredentials.userId, userId),
        ),
      )
      .returning({ id: schema.webauthnCredentials.id });
    if (rows.length === 0) throw notFound("Passkey");
    return c.body(null, 204);
  });

  app.route("/", authed);
  return app;
}
