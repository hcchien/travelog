import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PushMessage, startPushNotifier } from "../src/lib/push.js";
import { createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["login"]>>;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

async function createTrip(
  user: User,
  title = "京都",
  dates = { startDate: "2026-12-03", endDate: "2026-12-05" },
) {
  return (
    await t.request("POST", "/v1/trips", {
      token: user.token,
      body: { title, ...dates, primaryTz: "Asia/Tokyo" },
    })
  ).json as { id: string; days: { id: string }[] };
}

async function join(tripId: string, inviter: User, user: User, role: "editor" | "viewer") {
  const inv = await t.request("POST", `/v1/trips/${tripId}/invitations`, {
    token: inviter.token,
    body: { role },
  });
  const token = new URL(inv.json.url).pathname.split("/").pop();
  expect(
    (await t.request("POST", `/v1/invitations/${token}/accept`, { token: user.token })).status,
  ).toBe(200);
}

/** App 登入（native flow 回傳的 token 帶 via=app）。 */
async function appLogin(sub: string, name: string) {
  return t.login(sub, name);
}

describe("快速筆記的 Idempotency-Key", () => {
  it("同一個 key 重送回傳同一則；格式不對拒絕", async () => {
    const owner = await t.login("idem-owner", "陳");
    const trip = await createTrip(owner);
    const send = (key: string) =>
      t.request("POST", `/v1/trips/${trip.id}/notes`, {
        token: owner.token,
        body: { body: "離線時記下的" },
        headers: { "Idempotency-Key": key },
      });
    const first = await send("offline-note-0001");
    expect(first.status).toBe(201);
    const again = await send("offline-note-0001");
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    expect((await send("bad key!")).status).toBe(400);
    const list = await t.request("GET", `/v1/trips/${trip.id}/notes`, { token: owner.token });
    expect(list.json.notes).toHaveLength(1);
  });
});

describe("刪除帳號", () => {
  it("有旅伴的行程轉給編輯者、沒有旅伴的行程刪除、個資清除，之後無法再登入", async () => {
    const leaver = await t.login("del-me", "要離開的人");
    const editor = await t.login("del-editor", "小安");
    const viewer = await t.login("del-viewer", "阿明");
    const shared = await createTrip(leaver, "共同行程");
    await join(shared.id, leaver, viewer, "viewer");
    await join(shared.id, leaver, editor, "editor");
    const solo = await createTrip(leaver, "自己的行程");
    const other = await createTrip(editor, "小安的行程");
    await join(other.id, editor, leaver, "editor");

    await t.request("POST", `/v1/trips/${shared.id}/items`, {
      token: leaver.token,
      body: { type: "sight", title: "伏見稻荷" },
    });
    await t.request("POST", `/v1/trips/${shared.id}/notes`, {
      token: leaver.token,
      body: { body: "我的私人筆記" },
    });
    await t.request("POST", `/v1/trips/${shared.id}/journal`, {
      token: leaver.token,
      body: { target: { scope: "trip" }, bodyText: "我的心得" },
    });

    // 一定要明確確認
    expect((await t.request("DELETE", "/v1/me", { token: leaver.token, body: {} })).status).toBe(
      422,
    );
    // MCP 不能刪帳號
    const mcp = await t.tokens.issueInternalToken(
      leaver.userId,
      ["trips:read", "trips:write"],
      "tlc_x",
    );
    expect(
      (await t.request("DELETE", "/v1/me", { token: mcp, body: { confirm: "DELETE" } })).status,
    ).toBe(403);

    expect(
      (await t.request("DELETE", "/v1/me", { token: leaver.token, body: { confirm: "DELETE" } }))
        .status,
    ).toBe(204);

    const sharedNow = await t.request("GET", `/v1/trips/${shared.id}`, { token: editor.token });
    expect(sharedNow.json.ownerId).toBe(editor.userId);
    expect(sharedNow.json.myRole).toBe("owner");
    expect(sharedNow.json.members.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
    // 行程點保留，但筆記、心得刪除
    const items = await t.request("GET", `/v1/trips/${shared.id}/items`, { token: editor.token });
    expect(JSON.stringify(items.json)).toContain("伏見稻荷");
    expect(
      (await t.request("GET", `/v1/trips/${shared.id}/notes`, { token: editor.token })).json.notes,
    ).toEqual([]);
    expect(
      (await t.request("GET", `/v1/trips/${shared.id}/journal`, { token: editor.token })).json
        .entries,
    ).toEqual([]);

    const [soloRow] = await t.db.select().from(schema.trips).where(eq(schema.trips.id, solo.id));
    expect(soloRow).toBeUndefined();
    const otherNow = await t.request("GET", `/v1/trips/${other.id}`, { token: editor.token });
    expect(otherNow.json.members).toHaveLength(1);

    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.id, leaver.userId));
    expect(user).toMatchObject({ displayName: "已刪除的使用者", primaryEmail: null });
    expect(user?.deletedAt).not.toBeNull();
    expect(
      await t.db
        .select()
        .from(schema.userIdentities)
        .where(eq(schema.userIdentities.userId, leaver.userId)),
    ).toEqual([]);

    // refresh token 已失效；同一個 Google 帳號再登入會是全新的帳號
    const refresh = await t.request("POST", "/v1/auth/refresh", {
      body: { refreshToken: leaver.refreshToken },
    });
    expect(refresh.status).toBe(401);
    const again = await t.login("del-me", "回來的人");
    expect(again.userId).not.toBe(leaver.userId);
  });
});

describe("推播", () => {
  it("App 註冊權杖；有人加入行程、行程進行中有人改行程時通知其他成員（節流、去重）", async () => {
    const owner = await appLogin("push-owner", "陳");
    const friend = await appLogin("push-friend", "小安");
    const reg = (u: User, token: string) =>
      t.request("POST", "/v1/me/push-tokens", { token: u.token, body: { token, platform: "ios" } });
    expect((await reg(owner, "not-a-token")).status).toBe(422);
    expect((await reg(owner, "ExponentPushToken[owner-device]")).status).toBe(204);
    expect((await reg(friend, "ExponentPushToken[friend-device]")).status).toBe(204);

    const sent: PushMessage[] = [];
    const sender = {
      async send(m: PushMessage[]) {
        sent.push(...m);
        return { invalidTokens: m.filter((x) => x.to.includes("gone")).map((x) => x.to) };
      },
    };
    // 兩個「執行個體」同時收到事件：只能送一次
    const stop1 = startPushNotifier({
      db: t.db,
      events: t.events,
      sender,
      now: () => new Date("2026-12-04T03:00:00Z"),
    });
    const stop2 = startPushNotifier({
      db: t.db,
      events: t.events,
      sender,
      now: () => new Date("2026-12-04T03:00:00Z"),
    });
    const settle = () => new Promise((r) => setTimeout(r, 300));

    const trip = await createTrip(owner, "京都（進行中）");
    await join(trip.id, owner, friend, "editor");
    await settle();
    expect(sent).toEqual([
      expect.objectContaining({
        to: "ExponentPushToken[owner-device]",
        title: "京都（進行中）",
        body: "小安 加入了行程",
      }),
    ]);

    sent.length = 0;
    for (const title of ["錦市場", "金閣寺"]) {
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: friend.token,
        body: { type: "sight", title },
      });
    }
    await settle();
    // 15 分鐘內只送一則，不送給改的人自己
    expect(sent.map((m) => m.to)).toEqual(["ExponentPushToken[owner-device]"]);
    expect(sent[0]?.data).toMatchObject({ tripId: trip.id, path: `/trips/${trip.id}/today` });

    // 不在行程期間：不通知
    sent.length = 0;
    const later = await createTrip(owner, "明年", {
      startDate: "2027-05-01",
      endDate: "2027-05-03",
    });
    await join(later.id, owner, friend, "editor");
    await settle();
    sent.length = 0;
    await t.request("POST", `/v1/trips/${later.id}/items`, {
      token: friend.token,
      body: { type: "sight", title: "x" },
    });
    await settle();
    expect(sent).toEqual([]);

    // 失效的權杖會被刪除
    await reg(owner, "ExponentPushToken[gone-device]");
    const third = await appLogin("push-third", "阿明");
    await join(later.id, owner, third, "viewer");
    await settle();
    const tokens = await t.db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.userId, owner.userId));
    expect(tokens.map((x) => x.token)).toEqual(["ExponentPushToken[owner-device]"]);

    stop1();
    stop2();
  });

  it("網頁登入不能註冊推播", async () => {
    // test helper 的 login 走 native（app）；網頁 token 用 tokens 直接簽
    const u = await t.login("push-web", "網頁");
    const webToken = await t.tokens.issueAccessToken(u.userId, "web");
    const res = await t.request("POST", "/v1/me/push-tokens", {
      token: webToken,
      body: { token: "ExponentPushToken[web]", platform: "ios" },
    });
    expect(res.status).toBe(403);
  });
});
