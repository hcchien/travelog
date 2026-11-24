import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { accountRoutes } from "./auth/account.js";
import { passkeyRoutes } from "./auth/passkey.js";
import { authRoutes } from "./auth/routes.js";
import type { AppEnv, Deps } from "./context.js";
import { anonymousLimits, inputLimits } from "./lib/limits.js";
import { handleError, notFound } from "./lib/problem.js";
import { mcpRoutes } from "./mcp/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { placeRoutes } from "./places/routes.js";
import { savedPlaceRoutes } from "./places/saved.js";
import { attachmentRoutes } from "./trips/attachments.js";
import { itemRoutes } from "./trips/items.js";
import { journalRoutes } from "./trips/journal.js";
import { liveRoutes } from "./trips/live.js";
import { memberRoutes } from "./trips/members.js";
import { tripRoutes } from "./trips/routes.js";
import { shareRoutes } from "./trips/share.js";
import { undoRoutes } from "./trips/undo.js";
import { wishlistRoutes } from "./trips/wishlist.js";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  // OAuth、MCP 與 metadata 端點由第三方（AI client）呼叫：允許任何來源，但不帶 cookie
  for (const path of ["/oauth/*", "/.well-known/*", "/mcp"]) {
    app.use(
      path,
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"],
        exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
      }),
    );
  }
  app.use(
    "*",
    cors({
      origin: (origin) => (deps.config.allowedOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "If-Match", "Idempotency-Key"],
      exposeHeaders: ["ETag"],
      maxAge: 600,
    }),
  );

  app.use("*", anonymousLimits(deps));
  app.use("*", inputLimits());

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/", authRoutes(deps));
  app.route("/", oauthRoutes(deps));
  app.route(
    "/",
    mcpRoutes(deps, () => app),
  );
  app.route("/", passkeyRoutes(deps));
  app.route("/", placeRoutes(deps));
  app.route("/", tripRoutes(deps));
  app.route("/", itemRoutes(deps));
  app.route("/", wishlistRoutes(deps));
  app.route("/", memberRoutes(deps));
  app.route("/", liveRoutes(deps));
  app.route("/", undoRoutes(deps));
  app.route("/", savedPlaceRoutes(deps));
  app.route("/", accountRoutes(deps));
  app.route("/", attachmentRoutes(deps));
  app.route("/", journalRoutes(deps));
  app.route("/", shareRoutes(deps));
  if (deps.storage.routes) app.route("/", deps.storage.routes);

  app.notFound((c) => handleError(notFound("路徑"), c));
  app.onError(handleError);
  return app;
}
