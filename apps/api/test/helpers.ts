import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { postgis } from "@electric-sql/pglite-postgis";
import { type Database, migrationsFolder, schema } from "@travelog/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.js";
import type { GoogleAuth, IdentityProfile } from "../src/auth/google.js";
import { TokenService } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { TRIP_EVENTS_CHANNEL, TripEvents } from "../src/lib/events.js";
import type { Mailer } from "../src/lib/mailer.js";
import { unauthorized } from "../src/lib/problem.js";
import { createLocalStorage } from "../src/lib/storage.js";
import { createFakePlaces } from "./fake-places.js";

export const APP_ORIGIN = "http://localhost:3000";
export const API_ORIGIN = "http://localhost:8080";

export const testConfig = () =>
  loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://memory",
    APP_ORIGIN,
    API_ORIGIN,
    WEBAUTHN_RP_ID: "localhost",
    GOOGLE_CLIENT_ID: "web-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "secret",
    COOKIE_SECRET: "test-cookie-secret-that-is-long-enough!!",
  });

/**
 * 假的 Google：id token 格式為 "google|<sub>|<email>|<name>|<nonce>"。
 */
export const fakeGoogle: GoogleAuth = {
  authorizationUrl: ({ state, nonce }) =>
    `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`,
  exchangeCode: async ({ code }) => ({ idToken: code }),
  async verifyIdToken(idToken, { nonce }): Promise<IdentityProfile> {
    const [tag, sub, email, name, tokenNonce] = idToken.split("|");
    if (tag !== "google" || !sub) throw unauthorized("bad token");
    if (nonce !== undefined && tokenNonce !== nonce) throw unauthorized("nonce mismatch");
    return { sub, email: email || null, emailVerified: true, name: name || null, picture: null };
  },
};

async function freshPglite() {
  const pg = await PGlite.create({ extensions: { pgcrypto, pg_trgm, postgis } });
  await migrate(drizzle(pg), { migrationsFolder });
  return pg;
}

export async function createTestApp(opts: { clientMetadata?: Record<string, unknown> } = {}) {
  // 每個測試檔各自一個記憶體資料庫
  const pg = await freshPglite();
  const db = drizzle(pg, { schema }) as unknown as Database;
  const config = testConfig();
  let clock = new Date("2026-11-22T00:00:00Z");
  const now = () => clock;
  const tokens = await TokenService.create(db, config, now);
  const places = createFakePlaces();
  const sentMail: Parameters<Mailer["sendInvitation"]>[0][] = [];
  const mailer: Mailer = {
    async sendInvitation(m) {
      sentMail.push(m);
    },
  };
  const storageDir = await mkdtemp(join(tmpdir(), "travelog-test-"));
  const storage = createLocalStorage({
    dir: storageDir,
    apiOrigin: config.apiOrigin,
    secret: config.cookieSecret,
    now: () => clock,
  });
  const events = new TripEvents();
  await pg.listen(TRIP_EVENTS_CHANNEL, (payload) => events.dispatch(payload));
  const app = createApp({
    db,
    config,
    tokens,
    events,
    sseHeartbeatMs: 200,
    fetchClientMetadata: async (url: string) => {
      const doc = opts.clientMetadata?.[url];
      if (!doc) throw new Error(`no metadata for ${url}`);
      return doc;
    },
    google: fakeGoogle,
    places: places.provider,
    mailer,
    storage,
    now,
  });

  async function request(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await app.request(path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: 測試中直接讀取回應 JSON
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** 以假 Google（原生 App）登入，回傳 access token 與 userId。 */
  async function login(sub: string, name = sub) {
    const res = await request("POST", "/v1/auth/google/native", {
      body: { idToken: `google|${sub}|${sub}@example.com|${name}|` },
    });
    if (res.status !== 200)
      throw new Error(`login failed: ${res.status} ${JSON.stringify(res.json)}`);
    const me = await request("GET", "/v1/me", { token: res.json.accessToken });
    return {
      token: res.json.accessToken as string,
      refreshToken: res.json.refreshToken as string,
      userId: me.json.id as string,
    };
  }

  return {
    app,
    db,
    pg,
    config,
    placeCalls: places.calls,
    tokens,
    events,
    sentMail,
    storage,
    storageDir,
    request,
    login,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    close: () => pg.close(),
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
