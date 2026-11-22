import type { Database } from "@travelog/db";
import type { AccessChannel } from "@travelog/domain";
import type { GoogleAuth } from "./auth/google.js";
import type { AccessClaims, TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Mailer } from "./lib/mailer.js";
import type { PlacesProvider } from "./places/provider.js";

export interface Deps {
  db: Database;
  config: Config;
  tokens: TokenService;
  google: GoogleAuth;
  places: PlacesProvider;
  mailer: Mailer;
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
