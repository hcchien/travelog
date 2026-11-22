/** OAuth scope（ARCHITECTURE §4.3）。 */
export const OAUTH_SCOPES = ["trips:read", "trips:write", "journal:write"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const SCOPE_LABELS: Record<OAuthScope, string> = {
  "trips:read": "讀取你的行程、想去清單、我的地點與筆記",
  "trips:write": "新增與修改行程點、想去清單、我的地點",
  "journal:write": "新增筆記",
};

/** 解析空白分隔的 scope；未知的 scope 會被丟掉，空的時候預設唯讀。 */
export function parseScopes(scope: string | null | undefined): OAuthScope[] {
  const wanted = (scope ?? "").split(/\s+/).filter(Boolean);
  const out = OAUTH_SCOPES.filter((s) => wanted.includes(s));
  return out.length > 0 ? out : ["trips:read"];
}

/**
 * MCP（channel=mcp）可以呼叫的 API 範圍與所需 scope。
 * 不在清單中的路徑（登入、Passkey、已連線的應用程式、帳號連結、OAuth 等）一律拒絕。
 */
export function requiredScopeForMcp(method: string, path: string): OAuthScope | null | "forbidden" {
  const allowed =
    path === "/v1/me" ||
    path.startsWith("/v1/trips") ||
    path.startsWith("/v1/places/") ||
    path.startsWith("/v1/me/saved-places");
  if (!allowed) return "forbidden";
  // 附件（下載網址）與公開分享只開放給第一方
  if (/^\/v1\/trips\/[^/]+\/(attachments|share-links)(\/|$)/.test(path)) return "forbidden";
  if (method === "GET" || method === "HEAD") return "trips:read";
  if (/^\/v1\/trips\/[^/]+\/(notes|journal)(\/|$)/.test(path)) return "journal:write";
  // 地點查詢不改變資料，但會寫入快取；以讀取權限即可
  if (path === "/v1/places/resolve") return "trips:read";
  return "trips:write";
}
