import { ForbiddenError, requiredScopeForMcp } from "@travelog/domain";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Deps } from "../context.js";
import { unauthorized } from "./problem.js";

export const requireAuth = (deps: Deps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization");
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw unauthorized();
    const claims = await deps.tokens.verifyAccessToken(match[1]);
    if (claims.clientId === "mcp") {
      // MCP 只能呼叫行程相關 API，且要有對應的 scope（第二道檢查，第一道在 /mcp 工具）
      const needed = requiredScopeForMcp(c.req.method, c.req.path);
      if (needed === "forbidden" || (needed && !claims.scopes.includes(needed))) {
        throw new ForbiddenError(
          needed === "forbidden" ? "MCP 不能使用這個功能" : `需要 ${needed} 權限`,
        );
      }
    }
    c.set("auth", { ...claims, via: claims.clientId });
    await next();
  });
