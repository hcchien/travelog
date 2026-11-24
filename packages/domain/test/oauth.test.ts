import { describe, expect, it } from "vitest";
import { parseScopes, requiredScopeForMcp } from "../src/oauth.js";
import { timeInTimeZone, zonedDateTimeToInstant } from "../src/time.js";

describe("parseScopes", () => {
  it("只保留認得的 scope，空的時候預設唯讀", () => {
    expect(parseScopes("trips:write admin trips:read")).toEqual(["trips:read", "trips:write"]);
    expect(parseScopes("")).toEqual(["trips:read"]);
    expect(parseScopes(undefined)).toEqual(["trips:read"]);
  });
});

describe("requiredScopeForMcp", () => {
  it.each([
    ["GET", "/v1/trips", "trips:read"],
    ["GET", "/v1/trips/x/items", "trips:read"],
    ["POST", "/v1/trips/x/items", "trips:write"],
    ["PATCH", "/v1/trips/x/items/y", "trips:write"],
    ["POST", "/v1/trips/x/notes", "journal:write"],
    ["POST", "/v1/trips/x/journal", "journal:write"],
    ["PATCH", "/v1/trips/x/journal/y", "journal:write"],
    ["GET", "/v1/trips/x/journal", "trips:read"],
    ["POST", "/v1/places/resolve", "trips:read"],
    ["POST", "/v1/me/saved-places", "trips:write"],
    ["GET", "/v1/me", "trips:read"],
  ])("%s %s → %s", (method, path, scope) => {
    expect(requiredScopeForMcp(method, path)).toBe(scope);
  });

  it.each([
    ["POST", "/v1/auth/refresh"],
    ["GET", "/v1/me/passkeys"],
    ["GET", "/v1/me/connections"],
    ["POST", "/v1/me/identities/link/google"],
    ["GET", "/v1/trips/x/attachments"],
    ["POST", "/v1/trips/x/attachments/uploads"],
    ["POST", "/v1/trips/x/share-links"],
    ["GET", "/v1/public/abc"],
    ["POST", "/v1/oauth/requests/x/decision"],
  ])("%s %s 一律拒絕", (method, path) => {
    expect(requiredScopeForMcp(method, path)).toBe("forbidden");
  });
});

describe("zonedDateTimeToInstant", () => {
  it("東京 08:50 = UTC 前一天 23:50", () => {
    expect(zonedDateTimeToInstant("2026-12-03", "08:50", "Asia/Tokyo").toISOString()).toBe(
      "2026-12-02T23:50:00.000Z",
    );
  });
  it("處理日光節約時間（紐約 3 月）", () => {
    expect(zonedDateTimeToInstant("2026-03-09", "09:00", "America/New_York").toISOString()).toBe(
      "2026-03-09T13:00:00.000Z",
    );
    expect(zonedDateTimeToInstant("2026-03-06", "09:00", "America/New_York").toISOString()).toBe(
      "2026-03-06T14:00:00.000Z",
    );
  });
  it("timeInTimeZone 反向轉換", () => {
    expect(timeInTimeZone(new Date("2026-12-02T23:50:00Z"), "Asia/Tokyo")).toBe("08:50");
  });
});
