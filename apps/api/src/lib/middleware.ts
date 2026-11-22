import { createMiddleware } from "hono/factory";
import type { AppEnv, Deps } from "../context.js";
import { unauthorized } from "./problem.js";

export const requireAuth = (deps: Deps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization");
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw unauthorized();
    const claims = await deps.tokens.verifyAccessToken(match[1]);
    c.set("auth", { ...claims, via: claims.clientId });
    await next();
  });
