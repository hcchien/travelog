import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budget } from "../src/lib/limits.js";
import { drainStorageDeletions, maintenance } from "../src/lib/maintenance.js";
import { APP_ORIGIN, createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t?.close(); });

async function newTrip(token: string) {
  const r = await t.request("POST", "/v1/trips", { token, body: {
    title: "Security regression", startDate: "2026-01-01", endDate: "2026-01-02", primaryTz: "Asia/Taipei",
  } });
  expect(r.status).toBe(201);
  return r.json;
}

async function linkedFlow(userId: string) {
  const session = await t.tokens.issue(userId, "web");
  const start = await t.request("POST", "/v1/me/identities/link/google", {
    token: session.accessToken, headers: { Origin: APP_ORIGIN, Cookie: `tl_rt=${session.refreshToken}` },
  });
  expect(start.status).toBe(200);
  const url = new URL(start.json.url);
  const code = encodeURIComponent(`google|linked-${userId}|new@example.com|New|${url.searchParams.get("nonce")}`);
  return { session, cookie: start.headers.getSetCookie()[0]?.split(";")[0] ?? "",
    callback: `/v1/auth/google/callback?code=${code}&state=${url.searchParams.get("state")}` };
}

describe("security review regressions", () => {
  it("SEC-02: link URL cannot be transferred to another browser or replayed", async () => {
    const user = await t.login("security-link");
    const flow = await linkedFlow(user.userId);
    const noCookie = await t.app.request(flow.callback);
    expect(noCookie.headers.get("location")).toContain("error=state");
    const ok = await t.app.request(flow.callback, { headers: { Cookie: `${flow.cookie}; tl_rt=${flow.session.refreshToken}` } });
    expect(ok.headers.get("location")).toContain("settings?link=linked");
    const replay = await t.app.request(flow.callback, { headers: { Cookie: `${flow.cookie}; tl_rt=${flow.session.refreshToken}` } });
    expect(replay.headers.get("location")).toContain("error=state");
    expect((await t.request("GET", "/v1/auth/google?link=legacy-token")).status).toBe(401);
  });

  it("SEC-02: logout invalidates an unfinished link transaction", async () => {
    const user = await t.login("security-link-logout");
    const flow = await linkedFlow(user.userId);
    await t.tokens.revoke(flow.session.refreshToken, cid => cid === "web");
    const callback = await t.app.request(flow.callback, { headers: { Cookie: `${flow.cookie}; tl_rt=${flow.session.refreshToken}` } });
    expect(callback.headers.get("location")).toContain("error=google");
    const rows = await t.db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, user.userId));
    expect(rows).toHaveLength(1);
  });

  it("SEC-04: single-field PATCH enforces the inclusive day limit before creating rows", async () => {
    const user = await t.login("security-dates");
    const trip = await newTrip(user.token);
    const change = (body: unknown, version: number) => t.request("PATCH", `/v1/trips/${trip.id}`, {
      token: user.token, body, headers: { "If-Match": `"v${version}"` },
    });
    const valid = await change({ endDate: "2026-03-01" }, trip.version);
    expect(valid.status).toBe(200);
    for (const body of [{ endDate: "2026-03-02" }, { endDate: "9999-12-31" }, { startDate: "2025-12-31" }])
      expect((await change(body, valid.json.version)).status).toBe(400);
    expect(await t.db.select().from(schema.tripDays).where(eq(schema.tripDays.tripId, trip.id))).toHaveLength(60);
  });

  it("SEC-05: shared atomic budgets reject overflow and reset after the window", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const deps = { db: t.db, now: () => clock };
    await budget(deps, "regression", "test", 2, 60);
    await budget(deps, "regression", "test", 2, 60);
    await expect(budget(deps, "regression", "test", 2, 60)).rejects.toMatchObject({ status: 429 });
    clock = new Date(clock.getTime() + 60_000);
    await expect(budget(deps, "regression", "test", 2, 60)).resolves.toBeUndefined();
  });

  it("SEC-06: deleted account cannot write, refresh, link, or issue new grants", async () => {
    const user = await t.login("security-deleted");
    const mcp = await t.tokens.issueOAuth(user.userId, "security-client", ["trips:read", "trips:write"]);
    expect((await t.request("DELETE", "/v1/me", { token: user.token, body: { confirm: "DELETE" } })).status).toBe(204);
    for (const path of ["/v1/trips", "/v1/me/identities/link/google", "/v1/me/saved-places", "/v1/oauth/requests/invalid/decision"])
      expect((await t.request("POST", path, { token: user.token, body: {} })).status).toBe(401);
    expect((await t.request("POST", "/v1/auth/refresh", { body: { refreshToken: user.refreshToken } })).status).toBe(401);
    await expect(t.tokens.issueOAuth(user.userId, "security-client", ["trips:read"])).rejects.toMatchObject({ status: 401 });
    await expect(t.tokens.verifyMcpToken(mcp.accessToken)).rejects.toMatchObject({ status: 401 });
  });

  it("SEC-07: reauthorization and other families never revive revoked tokens", async () => {
    const user = await t.login("security-grant");
    const old = await t.tokens.issueOAuth(user.userId, "same-client", ["trips:read", "trips:write"]);
    const other = await t.tokens.issueOAuth(user.userId, "same-client", ["trips:read"]);
    await t.tokens.revoke(old.refreshToken, cid => cid === "same-client");
    await expect(t.tokens.verifyMcpToken(old.accessToken)).rejects.toMatchObject({ status: 401 });
    expect((await t.tokens.verifyMcpToken(other.accessToken)).scopes).toEqual(["trips:read"]);
    const newer = await t.tokens.issueOAuth(user.userId, "same-client", ["trips:read"]);
    await expect(t.tokens.verifyMcpToken(old.accessToken)).rejects.toMatchObject({ status: 401 });
    const rotated = await t.tokens.rotate(newer.refreshToken, cid => cid === "same-client");
    expect((await t.tokens.verifyMcpToken(rotated.accessToken)).familyId).toBe((await t.tokens.verifyMcpToken(newer.accessToken)).familyId);
  });

  it("SEC-10/11: signed upload cannot overwrite; trip deletion queues retryable cleanup", async () => {
    const user = await t.login("security-upload");
    const trip = await newTrip(user.token);
    const created = await t.request("POST", `/v1/trips/${trip.id}/attachments/uploads`, { token: user.token,
      body: { filename: "ticket.pdf", mime: "application/pdf", sizeBytes: 3 } });
    expect(created.status).toBe(201);
    const { attachment, upload } = created.json;
    const put = (body: string) => t.app.request(upload.url, { method: "PUT", headers: upload.headers, body });
    expect((await put("one")).status).toBe(200);
    const done = await t.request("POST", `/v1/trips/${trip.id}/attachments/${attachment.id}/complete`, { token: user.token });
    expect(done.status).toBe(200);
    expect((await put("two")).status).toBe(412);
    const download = await t.request("GET", `/v1/trips/${trip.id}/attachments/${attachment.id}/download`, { token: user.token });
    expect(await (await t.app.request(download.json.url)).text()).toBe("one");
    expect((await t.request("DELETE", `/v1/trips/${trip.id}`, { token: user.token })).status).toBe(204);
    const [job] = await t.db.select().from(schema.storageDeletions);
    expect(job).toBeDefined();
    if (!job) throw new Error("missing cleanup job");
    const now = () => new Date(job.availableAt.getTime() + 3600_000);
    await drainStorageDeletions({ db: t.db, now, storage: { ...t.storage, remove: async () => { throw new Error("temporary"); } } });
    const [retry] = await t.db.select().from(schema.storageDeletions);
    expect(retry?.attempts).toBe(1);
    const later = () => new Date(now().getTime() + 3600_000);
    await drainStorageDeletions({ db: t.db, now: later, storage: t.storage });
    await drainStorageDeletions({ db: t.db, now: later, storage: t.storage });
    expect(await t.storage.stat(job.storageKey)).toBeNull();
    expect(await t.db.select().from(schema.storageDeletions)).toHaveLength(0);
  });

  it("SEC-11: pending uploads expire and enter durable cleanup", async () => {
    const user = await t.login("security-pending");
    const trip = await newTrip(user.token);
    const pending = await t.request("POST", `/v1/trips/${trip.id}/attachments/uploads`, { token: user.token,
      body: { filename: "never-uploaded.pdf", mime: "application/pdf", sizeBytes: 3 } });
    await t.db.update(schema.attachments).set({ createdAt: new Date(0) }).where(eq(schema.attachments.id, pending.json.attachment.id));
    await maintenance({ db: t.db, storage: t.storage, now: () => new Date() });
    expect(await t.db.select().from(schema.attachments).where(eq(schema.attachments.id, pending.json.attachment.id))).toHaveLength(0);
  });
});
