import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { passkeyRoutes } from "./auth/passkey.js";
import { authRoutes } from "./auth/routes.js";
import type { AppEnv, Deps } from "./context.js";
import { handleError, notFound } from "./lib/problem.js";
import { placeRoutes } from "./places/routes.js";
import { savedPlaceRoutes } from "./places/saved.js";
import { itemRoutes } from "./trips/items.js";
import { memberRoutes } from "./trips/members.js";
import { tripRoutes } from "./trips/routes.js";
import { wishlistRoutes } from "./trips/wishlist.js";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => (deps.config.allowedOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "If-Match", "Idempotency-Key"],
      exposeHeaders: ["ETag"],
      maxAge: 600,
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/", authRoutes(deps));
  app.route("/", passkeyRoutes(deps));
  app.route("/", placeRoutes(deps));
  app.route("/", tripRoutes(deps));
  app.route("/", itemRoutes(deps));
  app.route("/", wishlistRoutes(deps));
  app.route("/", memberRoutes(deps));
  app.route("/", savedPlaceRoutes(deps));

  app.notFound((c) => handleError(notFound("路徑"), c));
  app.onError(handleError);
  return app;
}
