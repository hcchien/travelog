import { z } from "zod";

export const firstPartyClient = z.enum(["web", "app"]);

export const googleNativeLoginInput = z.object({
  idToken: z.string().min(1),
  nonce: z.string().min(1).optional(),
});

export const refreshInput = z.object({
  /** App 以 body 傳 refresh token；Web 用 HttpOnly cookie，body 可省略。 */
  refreshToken: z.string().min(1).optional(),
});

export const passkeyLoginVerifyInput = z.object({
  challengeId: z.uuid(),
  client: firstPartyClient,
  // WebAuthn 的 AuthenticationResponseJSON，由 @simplewebauthn/server 驗證結構
  response: z.record(z.string(), z.unknown()),
});

export const passkeyRegisterVerifyInput = z.object({
  challengeId: z.uuid(),
  name: z.string().trim().min(1).max(60).optional(),
  response: z.record(z.string(), z.unknown()),
});

export const renamePasskeyInput = z.object({
  name: z.string().trim().min(1).max(60),
});
