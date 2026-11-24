import { autocompleteQuery, resolvePlaceInput } from "@travelog/schema";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.js";
import { requireAuth } from "../lib/middleware.js";
import { validate } from "../lib/validate.js";
import { resolvePlace, serializePlace } from "./resolve.js";

export function placeRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  // 需登入，避免被當成免費的 Google Places 代理
  app.get("/v1/places/autocomplete", auth, validate("query", autocompleteQuery), async (c) => {
    const { q, session, lat, lng } = c.req.valid("query");
    const suggestions = await deps.places.autocomplete({
      input: q,
      sessionToken: session,
      near: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
    });
    return c.json({ suggestions });
  });

  app.post("/v1/places/resolve", auth, validate("json", resolvePlaceInput), async (c) => {
    const { googlePlaceId, sessionToken } = c.req.valid("json");
    const place = await resolvePlace(deps.db, deps.places, googlePlaceId, {
      sessionToken,
      now: deps.now,
    });
    return c.json(serializePlace(place));
  });

  return app;
}
