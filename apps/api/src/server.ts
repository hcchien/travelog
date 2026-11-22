import { serve } from "@hono/node-server";
import { createDb } from "@travelog/db";
import { createApp } from "./app.js";
import { createGoogleAuth } from "./auth/google.js";
import { TokenService } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { consoleMailer } from "./lib/mailer.js";
import { createGooglePlaces } from "./places/provider.js";

const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl);
const now = () => new Date();
const tokens = await TokenService.create(db, config, now);
if (!config.jwt.privateKeyPem) {
  console.warn("未設定 JWT_PRIVATE_KEY：使用暫時金鑰，重新啟動後所有 access token 都會失效。");
}

const app = createApp({
  db,
  config,
  tokens,
  google: createGoogleAuth(config),
  places: createGooglePlaces(config),
  mailer: consoleMailer,
  now,
});
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Travelog API listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void sql.end({ timeout: 5 });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
