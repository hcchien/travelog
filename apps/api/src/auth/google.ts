import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { unauthorized } from "../lib/problem.js";

export interface IdentityProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Google OIDC。介面化以便測試時替換。 */
export interface GoogleAuth {
  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string, opts: { nonce?: string | undefined }): Promise<IdentityProfile>;
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function createGoogleAuth(config: Config): GoogleAuth {
  const { clientId, clientSecret, audiences, redirectUri } = config.google;
  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier }) {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      });
      if (!res.ok) throw unauthorized("Google 登入失敗");
      const body = (await res.json()) as { id_token?: string };
      if (!body.id_token) throw unauthorized("Google 登入失敗");
      return { idToken: body.id_token };
    },

    async verifyIdToken(idToken, { nonce }) {
      try {
        const { payload } = await jwtVerify(idToken, JWKS, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: audiences,
        });
        if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce mismatch");
        if (typeof payload.sub !== "string") throw new Error("missing sub");
        return {
          sub: payload.sub,
          email: typeof payload.email === "string" ? payload.email : null,
          emailVerified: payload.email_verified === true,
          name: typeof payload.name === "string" ? payload.name : null,
          picture: typeof payload.picture === "string" ? payload.picture : null,
        };
      } catch {
        throw unauthorized("Google 登入驗證失敗");
      }
    },
  };
}
