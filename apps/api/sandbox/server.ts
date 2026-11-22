/**
 * 本機沙盒：不需要 PostgreSQL、Google 金鑰，就能把整個 Web 前端跑起來試用。
 * - 資料庫：PGlite（記憶體中，重啟即清空）
 * - Google 登入：假的登入頁，輸入名字即可登入
 * - 地點搜尋：內建京都、東京、台北的範例地點
 *
 * 只供本機開發與 E2E 測試；NODE_ENV=production 時拒絕啟動。
 *   pnpm --filter @travelog/api sandbox
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { postgis } from "@electric-sql/pglite-postgis";
import { serve } from "@hono/node-server";
import { type Database, migrationsFolder, schema } from "@travelog/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import type { GoogleAuth } from "../src/auth/google.js";
import { TokenService } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { consoleMailer } from "../src/lib/mailer.js";
import { unauthorized } from "../src/lib/problem.js";
import { createFakePlaces } from "../test/fake-places.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("沙盒伺服器不能在正式環境執行");
}

const PORT = Number(process.env.PORT ?? 8080);
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";
const API_ORIGIN = `http://localhost:${PORT}`;

const config = loadConfig({
  NODE_ENV: "development",
  DATABASE_URL: "pglite://memory",
  APP_ORIGIN,
  API_ORIGIN,
  WEBAUTHN_RP_ID: "localhost",
  GOOGLE_CLIENT_ID: "sandbox",
  GOOGLE_CLIENT_SECRET: "sandbox",
  COOKIE_SECRET: "sandbox-cookie-secret-not-for-production",
});

const pg = await PGlite.create({ extensions: { pgcrypto, pg_trgm, postgis } });
await migrate(drizzle(pg), { migrationsFolder });
const db = drizzle(pg, { schema }) as unknown as Database;
const now = () => new Date();
const tokens = await TokenService.create(db, config, now);

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

/** 假的 Google：導到沙盒自己的登入頁。id token 格式為 "sandbox|<sub>|<name>|<nonce>"。 */
const google: GoogleAuth = {
  authorizationUrl: ({ state, nonce }) =>
    `${API_ORIGIN}/__sandbox/google?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`,
  exchangeCode: async ({ code }) => ({ idToken: code }),
  async verifyIdToken(idToken, { nonce }) {
    const [tag, sub, name, tokenNonce] = idToken.split("|");
    if (tag !== "sandbox" || !sub || !name) throw unauthorized();
    if (nonce !== undefined && tokenNonce !== nonce) throw unauthorized();
    return { sub, email: `${sub}@sandbox.test`, emailVerified: true, name, picture: null };
  },
};

const app = new Hono();
app.get("/__sandbox/google", (c) => {
  const state = escapeHtml(c.req.query("state") ?? "");
  const nonce = escapeHtml(c.req.query("nonce") ?? "");
  return c.html(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<title>沙盒登入</title>
<body style="font-family:system-ui;max-width:360px;margin:80px auto">
<h1 style="font-size:20px">沙盒登入（取代 Google）</h1>
<p style="color:#5b6575;font-size:14px">輸入名字就能登入。同一個名字會回到同一個帳號。</p>
<form action="/__sandbox/google/submit" method="get">
<input type="hidden" name="state" value="${state}"><input type="hidden" name="nonce" value="${nonce}">
<label>名字<br><input name="name" required style="width:100%;height:40px;font-size:16px" autofocus></label>
<button style="margin-top:12px;height:40px;width:100%;font-size:16px">登入</button>
</form></body></html>`);
});
app.get("/__sandbox/google/submit", (c) => {
  const name = (c.req.query("name") ?? "").trim().slice(0, 40);
  const sub = `sandbox-${Buffer.from(name).toString("hex").slice(0, 40)}`;
  const code = encodeURIComponent(`sandbox|${sub}|${name}|${c.req.query("nonce") ?? ""}`);
  return c.redirect(
    `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(c.req.query("state") ?? "")}`,
  );
});
app.route(
  "/",
  createApp({
    db,
    config,
    tokens,
    google,
    places: createFakePlaces().provider,
    mailer: consoleMailer,
    now,
  }),
);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Travelog 沙盒 API：${API_ORIGIN}（前端 ${APP_ORIGIN}）`);
  console.log("資料只存在記憶體中，重新啟動就會清空。");
});
