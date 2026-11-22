import type { Database } from "@travelog/db";
import type { AccessChannel } from "@travelog/domain";
import type { Hono } from "hono";
import type { GoogleAuth } from "./auth/google.js";
import type { AccessClaims, TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { TripEvents } from "./lib/events.js";
import type { Mailer } from "./lib/mailer.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { FetchClientMetadata } from "./oauth/clients.js";
import type { PlacesProvider } from "./places/provider.js";

export interface Deps {
  db: Database;
  config: Config;
  tokens: TokenService;
  google: GoogleAuth;
  places: PlacesProvider;
  mailer: Mailer;
  /** 附件儲存；本機實作帶有自己的上傳／下載路由。 */
  storage: StorageAdapter & { routes?: Hono };
  events: TripEvents;
  /** 抓取 OAuth Client ID Metadata Document（測試替換）。 */
  fetchClientMetadata?: FetchClientMetadata;
  /** SSE 心跳間隔（測試可調短）。 */
  sseHeartbeatMs?: number;
  now: () => Date;
}

export interface Auth extends AccessClaims {
  via: AccessChannel;
}

export interface AppEnv {
  Variables: {
    auth: Auth;
  };
}
