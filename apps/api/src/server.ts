import { serve } from "@hono/node-server";
import { createDb } from "@travelog/db";
import { createApp } from "./app.js";
import { createGoogleAuth } from "./auth/google.js";
import { TokenService } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { TRIP_EVENTS_CHANNEL, TripEvents } from "./lib/events.js";
import { createMailer } from "./lib/mailer.js";
import { maintenance } from "./lib/maintenance.js";
import { expoPush, startPushNotifier } from "./lib/push.js";
import { createGcsStorage, createLocalStorage } from "./lib/storage.js";
import { createGooglePlaces } from "./places/provider.js";

const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl);
const now = () => new Date();
const tokens = await TokenService.create(db, config, now);
if (!config.jwt.privateKeyPem) {
  console.warn("未設定 JWT_PRIVATE_KEY：使用暫時金鑰，重新啟動後所有 access token 都會失效。");
}

const storage =
  config.storage.driver === "gcs"
    ? await createGcsStorage(config.storage.bucket)
    : createLocalStorage({
        dir: config.storage.dir,
        apiOrigin: config.apiOrigin,
        secret: config.cookieSecret,
      });
if (!config.mail.resendApiKey) console.warn("未設定 RESEND_API_KEY：邀請信只會寫到 log。");

const events = new TripEvents();
// 即時同步：LISTEN activity_log 的 NOTIFY（postgres-js 會在斷線後自動重新 LISTEN）
await sql.listen(TRIP_EVENTS_CHANNEL, (payload) => events.dispatch(payload));

const app = createApp({
  db,
  config,
  tokens,
  google: createGoogleAuth(config),
  places: createGooglePlaces(config),
  mailer: createMailer(config.mail),
  storage,
  events,
  now,
});
// App 推播：多個執行個體都會收到事件，由 push_dispatches 去重
startPushNotifier({ db, events, sender: expoPush(), now });

let maintaining = false;
const maintain = async () => {
  if (maintaining) return;
  maintaining = true;
  try {
    await maintenance({ db, storage, now });
  } catch {
    console.error("maintenance failed; will retry");
  } finally {
    maintaining = false;
  }
};
void maintain();
const maintenanceTimer = setInterval(() => void maintain(), 60_000);
maintenanceTimer.unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Travelog API listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  clearInterval(maintenanceTimer);
  server.close();
  void sql.end({ timeout: 5 });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
