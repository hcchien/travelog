import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { schema } from "@travelog/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ORIGIN, APP_ORIGIN, createTestApp, type TestApp } from "./helpers.js";

const CIMD_ID = "https://claude.example/oauth/client.json";
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["login"]>>;
let owner: User;
let friend: User;

beforeAll(async () => {
  t = await createTestApp({
    clientMetadata: {
      [CIMD_ID]: { client_id: CIMD_ID, client_name: "Claude", redirect_uris: [REDIRECT] },
      "https://evil.example/client.json": {
        client_id: "https://other.example/x.json",
        redirect_uris: [REDIRECT],
      },
    },
  });
  owner = await t.login("mcp-owner", "陳");
  friend = await t.login("mcp-friend", "小安");
});
afterAll(() => t.close());

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});

async function register(redirect = REDIRECT) {
  const res = await t.app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "測試 MCP client", redirect_uris: [redirect] }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { client_id: string } & Record<string, string>,
  };
}

/** 走完整個授權碼流程，回傳 MCP access／refresh token。 */
async function authorize(user: User, clientId: string, scope: string, choose?: string[]) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${API_ORIGIN}/mcp`,
  });
  const res = await t.app.request(`/oauth/authorize?${qs}`);
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get("location") ?? "");
  expect(consent.origin + consent.pathname).toBe(`${APP_ORIGIN}/oauth/consent`);
  const requestId = consent.searchParams.get("request") as string;

  const decision = await t.request("POST", `/v1/oauth/requests/${requestId}/decision`, {
    token: user.token,
    body: { approve: true, ...(choose ? { scopes: choose } : {}) },
  });
  const back = new URL(decision.json.redirectTo);
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe(API_ORIGIN);
  const code = back.searchParams.get("code") as string;
  const token = await t.app.request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  );
  expect(token.status).toBe(200);
  const tok = (await token.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  return { ...tok, code, verifier };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${API_ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: async (url, init) => t.app.request(String(url), init as RequestInit),
  });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;

async function createTrip(token = owner.token) {
  return (
    await t.request("POST", "/v1/trips", {
      token,
      body: {
        title: "京都秋楓之旅",
        startDate: "2026-12-03",
        endDate: "2026-12-05",
        primaryTz: "Asia/Tokyo",
        destinations: [{ cityKey: "jp-kyoto", name: "京都" }],
      },
    })
  ).json;
}

describe("探索與未授權", () => {
  it("提供授權伺服器與受保護資源的 metadata", async () => {
    const as = await t.request("GET", "/.well-known/oauth-authorization-server");
    expect(as.json).toMatchObject({
      issuer: API_ORIGIN,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    const pr = await t.request("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(pr.json).toMatchObject({
      resource: `${API_ORIGIN}/mcp`,
      authorization_servers: [API_ORIGIN],
    });
  });

  it("沒有權杖時回 401 並指向 resource metadata", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${API_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("第一方的 access token 不能拿來呼叫 /mcp", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("OAuth 授權", () => {
  it("動態註冊只接受 https 或本機的 redirect_uri", async () => {
    expect((await register("http://evil.example/cb")).status).toBe(400);
    const ok = await register();
    expect(ok.status).toBe(201);
    expect(ok.body.client_id).toMatch(/^tlc_/);
    expect(ok.body.token_endpoint_auth_method).toBe("none");
    expect((await register("http://localhost:33418/callback")).status).toBe(201);
  });

  it("未知 client 或 redirect_uri 不符時不導回（避免 open redirect）", async () => {
    const res = await t.app.request(
      "/oauth/authorize?client_id=nope&redirect_uri=https://x.example/cb&response_type=code",
    );
    expect(res.status).toBe(400);
    const { body } = await register();
    const bad = await t.app.request(
      `/oauth/authorize?client_id=${body.client_id}&redirect_uri=https://attacker.example/cb&response_type=code`,
    );
    expect(bad.status).toBe(400);
  });

  it("沒有 PKCE 時以錯誤導回 client", async () => {
    const { body } = await register();
    const res = await t.app.request(
      `/oauth/authorize?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s1`,
    );
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("s1");
  });

  it("同意頁顯示 client 名稱與要求的權限；拒絕時導回 access_denied", async () => {
    const { body } = await register();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: body.client_id,
      redirect_uri: REDIRECT,
      scope: "trips:read trips:write",
      code_challenge: "abc",
      code_challenge_method: "S256",
    });
    const res = await t.app.request(`/oauth/authorize?${qs}`);
    const id = new URL(res.headers.get("location") ?? "").searchParams.get("request");
    const info = await t.request("GET", `/v1/oauth/requests/${id}`, { token: owner.token });
    expect(info.json.client.name).toBe("測試 MCP client");
    expect(info.json.redirectHost).toBe("claude.example");
    expect(info.json.scopes.map((s: { scope: string }) => s.scope)).toEqual([
      "trips:read",
      "trips:write",
    ]);
    const deny = await t.request("POST", `/v1/oauth/requests/${id}/decision`, {
      token: owner.token,
      body: { approve: false },
    });
    expect(new URL(deny.json.redirectTo).searchParams.get("error")).toBe("access_denied");
    // 同一個請求不能再決定一次
    expect(
      (
        await t.request("POST", `/v1/oauth/requests/${id}/decision`, {
          token: owner.token,
          body: { approve: true },
        })
      ).status,
    ).toBe(410);
  });

  it("授權碼：PKCE 不符拒絕、只能用一次", async () => {
    const { body } = await register();
    const verifier = randomBytes(32).toString("base64url");
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: body.client_id,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const id = new URL(
      (await t.app.request(`/oauth/authorize?${qs}`)).headers.get("location") ?? "",
    ).searchParams.get("request");
    const d = await t.request("POST", `/v1/oauth/requests/${id}/decision`, {
      token: owner.token,
      body: { approve: true },
    });
    const code = new URL(d.json.redirectTo).searchParams.get("code") as string;
    const base = {
      grant_type: "authorization_code",
      code,
      client_id: body.client_id,
      redirect_uri: REDIRECT,
    };
    const wrong = await t.app.request(
      "/oauth/token",
      form({ ...base, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier" }),
    );
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    const ok = await t.app.request("/oauth/token", form({ ...base, code_verifier: verifier }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const again = await t.app.request("/oauth/token", form({ ...base, code_verifier: verifier }));
    expect(again.status).toBe(400);
  });

  it("支援 Client ID Metadata Document；文件內容不符時拒絕", async () => {
    const tokens = await authorize(owner, CIMD_ID, "trips:read");
    expect(tokens.access_token).toBeTruthy();
    const bad = await t.app.request(
      `/oauth/authorize?client_id=${encodeURIComponent("https://evil.example/client.json")}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
    );
    expect(bad.status).toBe(400);
  });

  it("refresh token 輪替；送錯端點不會把 token 用掉", async () => {
    const { body } = await register();
    const first = await authorize(owner, body.client_id, "trips:read");
    // 拿去第一方的 refresh 端點：拒絕，但 token 仍可用
    expect(
      (await t.request("POST", "/v1/auth/refresh", { body: { refreshToken: first.refresh_token } }))
        .status,
    ).toBe(401);
    const r = await t.app.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: body.client_id,
      }),
    );
    expect(r.status).toBe(200);
    const next = (await r.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(next.scope).toBe("trips:read");
    // 別的 client 不能用
    const other = await register();
    const stolen = await t.app.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        refresh_token: next.refresh_token as string,
        client_id: other.body.client_id,
      }),
    );
    expect(stolen.status).toBe(400);
  });
});

describe("MCP 工具", () => {
  it("寫心得：沒有就新增，有就接在最後或取代；讀心得", async () => {
    const trip = await createTrip();
    const { body } = await register();
    const tokens = await authorize(owner, body.client_id, "trips:read journal:write");
    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["get_journal", "write_journal", "add_note"]));
    expect(names).not.toContain("add_itinerary_item");

    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: "write_journal", arguments: { tripId: trip.id, ...args } });
    expect(text(await call({ day: 1, text: "早上去伏見稻荷" }))).toContain("已新增Day 1");
    expect(text(await call({ day: 1, text: "下午清水寺" }))).toContain("接在");
    let read = await client.callTool({
      name: "get_journal",
      arguments: { tripId: trip.id, day: 1 },
    });
    expect(text(read)).toContain("早上去伏見稻荷\n下午清水寺");
    await call({ day: 1, text: "重寫", mode: "replace" });
    await call({ text: "整趟很棒" });
    read = await client.callTool({ name: "get_journal", arguments: { tripId: trip.id } });
    expect(text(read)).toContain("重寫");
    expect(text(read)).not.toContain("下午清水寺");
    expect(text(read)).toContain("整趟很棒");
    await client.close();
  });

  it("唯讀授權只看得到讀取工具，可以查詢行程", async () => {
    const trip = await createTrip();
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: {
        dayId: trip.days[0].id,
        type: "sight",
        title: "清水寺",
        startAt: "2026-12-03T00:00:00Z",
      },
    });
    const { body } = await register();
    const tokens = await authorize(owner, body.client_id, "trips:read trips:write", ["trips:read"]);
    const client = await mcpClient(tokens.access_token as string);
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("get_day_plan");
    expect(names).not.toContain("add_itinerary_item");

    const list = await client.callTool({ name: "list_trips", arguments: {} });
    expect(text(list)).toContain("京都秋楓之旅");
    const plan = await client.callTool({
      name: "get_day_plan",
      arguments: { tripId: trip.id, day: 1 },
    });
    expect(text(plan)).toContain("09:00 清水寺［景點］"); // 東京時間
    await client.close();
  });

  it("可寫入授權：新增、修改、移動行程點，活動紀錄標示 MCP", async () => {
    const trip = await createTrip();
    const { body } = await register();
    const tokens = await authorize(owner, body.client_id, "trips:read trips:write journal:write");
    const client = await mcpClient(tokens.access_token as string);

    const places = await client.callTool({ name: "search_places", arguments: { query: "伏見" } });
    expect(text(places)).toContain("googlePlaceId=fushimi");
    const added = await client.callTool({
      name: "add_itinerary_item",
      arguments: {
        tripId: trip.id,
        day: 2,
        title: "伏見稻荷大社",
        type: "sight",
        startTime: "08:00",
        endTime: "10:00",
        googlePlaceId: "fushimi",
      },
    });
    expect(added.isError).toBeFalsy();
    const itemId = (
      added.structuredContent as { item: { id: string; startAt: string; tz: string } }
    ).item.id;
    const created = (added.structuredContent as { item: { startAt: string; tz: string } }).item;
    expect(created.tz).toBe("Asia/Tokyo");
    expect(created.startAt).toBe("2026-12-03T23:00:00.000Z"); // 12/4 08:00 JST

    const updated = await client.callTool({
      name: "update_itinerary_item",
      arguments: { tripId: trip.id, itemId, startTime: "07:30", notes: "早點去避開人潮" },
    });
    expect(text(updated)).toContain("07:30–10:00 伏見稻荷大社");
    const moved = await client.callTool({
      name: "move_itinerary_item",
      arguments: { tripId: trip.id, itemId, day: 3 },
    });
    expect(text(moved)).toContain("Day 3");
    const note = await client.callTool({
      name: "add_note",
      arguments: { tripId: trip.id, body: "記得買御守" },
    });
    expect(note.isError).toBeFalsy();

    const activity = await t.request("GET", `/v1/trips/${trip.id}/activity`, {
      token: owner.token,
    });
    const mcp = activity.json.activity
      .filter((a: { via: string }) => a.via === "mcp")
      .map((a: { action: string }) => a.action);
    expect(mcp).toEqual(
      expect.arrayContaining(["item.created", "item.updated", "item.moved", "note.created"]),
    );
    await client.close();
  });

  it("已確定的行程點：MCP 修改會被拒絕，並告訴 AI 不要重試", async () => {
    const trip = await createTrip();
    const flight = (
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: owner.token,
        body: {
          dayId: trip.days[0].id,
          type: "transport",
          title: "航班",
          booking: { kind: "flight", status: "booked" },
        },
      })
    ).json.item;
    const { body } = await register();
    const client = await mcpClient(
      (await authorize(owner, body.client_id, "trips:read trips:write")).access_token as string,
    );
    const plan = await client.callTool({
      name: "get_day_plan",
      arguments: { tripId: trip.id, day: 1 },
    });
    expect(text(plan)).toContain("【已確定");
    const res = await client.callTool({
      name: "move_itinerary_item",
      arguments: { tripId: trip.id, itemId: flight.id, day: 2 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("解除確定");
    expect(text(res)).toContain("不要重試");
    await client.close();
  });

  it("行程中的檢視者，即使授權了寫入，MCP 也不能修改", async () => {
    const trip = await createTrip();
    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "viewer" });
    const { body } = await register();
    const client = await mcpClient(
      (await authorize(friend, body.client_id, "trips:read trips:write")).access_token as string,
    );
    const res = await client.callTool({
      name: "add_itinerary_item",
      arguments: { tripId: trip.id, day: 1, title: "x", type: "sight" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("沒有權限");
    await client.close();
  });

  it("內部權杖只能呼叫行程相關 API，且受 scope 限制", async () => {
    const readOnly = await t.tokens.issueInternalToken(owner.userId, ["trips:read"], "tlc_x");
    expect((await t.request("GET", "/v1/trips", { token: readOnly })).status).toBe(200);
    expect((await t.request("GET", "/v1/me/passkeys", { token: readOnly })).status).toBe(403);
    expect((await t.request("GET", "/v1/me/connections", { token: readOnly })).status).toBe(403);
    expect((await t.request("POST", "/v1/trips", { token: readOnly, body: {} })).status).toBe(403);
    // 有寫入權限也不能確定行程點（domain 規則：只限第一方）
    const writer = await t.tokens.issueInternalToken(
      owner.userId,
      ["trips:read", "trips:write"],
      "tlc_x",
    );
    const trip = await createTrip();
    const item = (
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: writer,
        body: { type: "sight", title: "x" },
      })
    ).json.item;
    expect(
      (await t.request("POST", `/v1/trips/${trip.id}/items/${item.id}/confirm`, { token: writer }))
        .status,
    ).toBe(403);
  });
});

describe("已連線的應用程式", () => {
  it("列出並撤銷；撤銷後 MCP 立即失效", async () => {
    const tokens = await authorize(owner, CIMD_ID, "trips:read");
    const list = await t.request("GET", "/v1/me/connections", { token: owner.token });
    const claude = list.json.connections.find((c: { clientId: string }) => c.clientId === CIMD_ID);
    expect(claude).toMatchObject({
      name: "Claude",
      verifiedDomain: "claude.example",
      scopes: ["trips:read"],
    });

    const client = await mcpClient(tokens.access_token as string);
    await client.close();
    const del = await t.request("DELETE", `/v1/me/connections/${encodeURIComponent(CIMD_ID)}`, {
      token: owner.token,
    });
    expect(del.status).toBe(204);
    const res = await t.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("復原 MCP 的修改", () => {
  async function setup() {
    const trip = await createTrip();
    const { body } = await register();
    const client = await mcpClient(
      (await authorize(owner, body.client_id, "trips:read trips:write")).access_token as string,
    );
    const activity = async () =>
      (await t.request("GET", `/v1/trips/${trip.id}/activity`, { token: owner.token })).json
        .activity;
    const undo = (id: string, token = owner.token) =>
      t.request("POST", `/v1/trips/${trip.id}/activity/${id}/undo`, { token });
    return { trip, client, activity, undo };
  }

  it("復原新增：行程點被刪除；同一筆不能復原兩次", async () => {
    const { trip, client, activity, undo } = await setup();
    await client.callTool({
      name: "add_itinerary_item",
      arguments: { tripId: trip.id, day: 1, title: "金閣寺", type: "sight" },
    });
    const entry = (await activity()).find((a: { action: string }) => a.action === "item.created");
    expect(entry).toMatchObject({ via: "mcp", undoable: true });
    expect((await undo(entry.id)).status).toBe(204);
    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/items`, { token: owner.token })).json.items,
    ).toEqual([]);
    const after = (await activity()).find((a: { id: string }) => a.id === entry.id);
    expect(after).toMatchObject({ undone: true, undoable: false });
    expect((await undo(entry.id)).status).toBe(409);
    await client.close();
  });

  it("復原修改與移動：回到原本的值與位置", async () => {
    const { trip, client, activity, undo } = await setup();
    const a = (
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: owner.token,
        body: { dayId: trip.days[0].id, type: "sight", title: "A", notes: "原本的備註" },
      })
    ).json.item;
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: { dayId: trip.days[0].id, type: "sight", title: "B" },
    });
    await client.callTool({
      name: "update_itinerary_item",
      arguments: { tripId: trip.id, itemId: a.id, title: "A2", notes: "AI 改的" },
    });
    let entry = (await activity()).find((x: { action: string }) => x.action === "item.updated");
    expect((await undo(entry.id)).status).toBe(204);
    let item = (
      await t.request("GET", `/v1/trips/${trip.id}/items/${a.id}`, { token: owner.token })
    ).json;
    expect(item).toMatchObject({ title: "A", notes: "原本的備註" });

    await client.callTool({
      name: "move_itinerary_item",
      arguments: { tripId: trip.id, itemId: a.id, day: 2 },
    });
    entry = (await activity()).find(
      (x: { action: string; undoable: boolean }) => x.action === "item.moved" && x.undoable,
    );
    expect((await undo(entry.id)).status).toBe(204);
    const day1 = (
      await t.request("GET", `/v1/trips/${trip.id}/items?dayId=${trip.days[0].id}`, {
        token: owner.token,
      })
    ).json.items;
    expect(day1.map((i: { title: string }) => i.title)).toEqual(["A", "B"]);
    item = (await t.request("GET", `/v1/trips/${trip.id}/items/${a.id}`, { token: owner.token }))
      .json;
    expect(item.dayId).toBe(trip.days[0].id);
    await client.close();
  });

  it("之後被其他人改過就不能復原；不是 MCP 的修改、檢視者都不能復原", async () => {
    const { trip, client, activity, undo } = await setup();
    const added = await client.callTool({
      name: "add_itinerary_item",
      arguments: { tripId: trip.id, day: 1, title: "X", type: "sight" },
    });
    const id = (added.structuredContent as { item: { id: string } }).item.id;
    await t.request("PATCH", `/v1/trips/${trip.id}/items/${id}`, {
      token: owner.token,
      body: { notes: "我補充的" },
      headers: { "If-Match": '"v1"' },
    });
    const entries = await activity();
    const created = entries.find(
      (a: { action: string; via: string }) => a.action === "item.created" && a.via === "mcp",
    );
    expect((await undo(created.id)).status).toBe(409);
    const manual = entries.find(
      (a: { action: string; via: string }) => a.action === "item.updated" && a.via !== "mcp",
    );
    expect((await undo(manual.id)).status).toBe(422);

    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "viewer" });
    expect((await undo(created.id, friend.token)).status).toBe(403);
    await client.close();
  });

  it("復原加入想去清單", async () => {
    const { trip, client, activity, undo } = await setup();
    await client.callTool({
      name: "add_to_wishlist",
      arguments: { tripId: trip.id, googlePlaceId: "kinkaku" },
    });
    const entry = (await activity()).find((a: { action: string }) => a.action === "wishlist.added");
    expect((await undo(entry.id)).status).toBe(204);
    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/wishlist`, { token: owner.token })).json.items,
    ).toEqual([]);
    await client.close();
  });
});

describe("帳號連結", () => {
  async function linkGoogle(user: User, idTokenFor: (nonce: string) => string) {
    const session = await t.tokens.issue(user.userId, "web");
    const start = await t.request("POST", "/v1/me/identities/link/google", {
      token: session.accessToken,
      headers: { Origin: APP_ORIGIN, Cookie: `tl_rt=${session.refreshToken}` },
    });
    expect(start.status).toBe(200);
    const google = new URL(start.json.url);
    const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const code = encodeURIComponent(idTokenFor(google.searchParams.get("nonce") ?? ""));
    const cb = await t.app.request(
      `/v1/auth/google/callback?code=${code}&state=${google.searchParams.get("state")}`,
      {
        headers: { Cookie: `${cookie}; tl_rt=${session.refreshToken}` },
      },
    );
    return new URL(cb.headers.get("location") ?? "");
  }

  it("把第二個 Google 帳號連結到同一個使用者，並可移除（至少保留一個）", async () => {
    const back = await linkGoogle(
      owner,
      (n) => `google|owner-second|second@example.com|第二帳號|${n}`,
    );
    expect(back.pathname).toBe("/settings");
    expect(back.searchParams.get("link")).toBe("linked");
    const me = await t.request("GET", "/v1/me", { token: owner.token });
    expect(me.json.identities).toHaveLength(2);
    // 用第二個帳號登入會回到同一個使用者
    const viaSecond = await t.request("POST", "/v1/auth/google/native", {
      body: { idToken: "google|owner-second|second@example.com|x|" },
    });
    expect((await t.request("GET", "/v1/me", { token: viaSecond.json.accessToken })).json.id).toBe(
      owner.userId,
    );

    const [first, second] = me.json.identities;
    expect(
      (await t.request("DELETE", `/v1/me/identities/${second.id}`, { token: owner.token })).status,
    ).toBe(204);
    expect(
      (await t.request("DELETE", `/v1/me/identities/${first.id}`, { token: owner.token })).status,
    ).toBe(409);
  });

  it("已屬於其他使用者的 Google 帳號不能連結", async () => {
    const back = await linkGoogle(
      owner,
      (n) => `google|mcp-friend|mcp-friend@example.com|小安|${n}`,
    );
    expect(back.searchParams.get("link")).toBe("conflict");
  });
});
