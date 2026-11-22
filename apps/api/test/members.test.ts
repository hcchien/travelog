import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["login"]>>;
let owner: User;
let alice: User;
let bob: User;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login("m-owner", "陳");
  alice = await t.login("m-alice", "小安");
  bob = await t.login("m-bob", "阿明");
});
afterAll(() => t.close());

async function createTrip() {
  return (
    await t.request("POST", "/v1/trips", {
      token: owner.token,
      body: {
        title: "京都・大阪 秋楓之旅",
        startDate: "2026-12-03",
        endDate: "2026-12-05",
        primaryTz: "Asia/Tokyo",
      },
    })
  ).json;
}

const tokenOf = (url: string) => url.split("/invite/")[1] as string;

async function invite(tripId: string, body: object, token = owner.token) {
  return t.request("POST", `/v1/trips/${tripId}/invitations`, { token, body });
}

async function join(tripId: string, user: User, role: "editor" | "viewer" = "editor") {
  const inv = await invite(tripId, { role });
  const res = await t.request("POST", `/v1/invitations/${tokenOf(inv.json.url)}/accept`, {
    token: user.token,
  });
  expect(res.status).toBe(200);
}

describe("邀請連結", () => {
  it("建立連結、預覽（不需登入）、接受後成為成員", async () => {
    const trip = await createTrip();
    const inv = await invite(trip.id, { role: "editor" });
    expect(inv.status).toBe(201);
    expect(inv.json.url.startsWith(`${APP_ORIGIN}/invite/`)).toBe(true);
    expect(inv.json.status).toBe("valid");

    const preview = await t.request("GET", `/v1/invitations/${tokenOf(inv.json.url)}`);
    expect(preview.json).toMatchObject({
      trip: { id: trip.id, title: "京都・大阪 秋楓之旅" },
      role: "editor",
      invitedBy: "陳",
      status: "valid",
      email: null,
    });

    const accepted = await t.request("POST", `/v1/invitations/${tokenOf(inv.json.url)}/accept`, {
      token: alice.token,
    });
    expect(accepted.json).toEqual({ tripId: trip.id, role: "editor", alreadyMember: false });
    // 連結可以給多人使用
    const second = await t.request("POST", `/v1/invitations/${tokenOf(inv.json.url)}/accept`, {
      token: bob.token,
    });
    expect(second.json.alreadyMember).toBe(false);

    const members = await t.request("GET", `/v1/trips/${trip.id}/members`, { token: alice.token });
    expect(
      members.json.members
        .map((m: { displayName: string; role: string }) => [m.displayName, m.role])
        .sort(),
    ).toEqual([
      ["小安", "editor"],
      ["阿明", "editor"],
      ["陳", "owner"],
    ]);
  });

  it("接受邀請需要登入；已經是成員時不改變角色", async () => {
    const trip = await createTrip();
    const inv = await invite(trip.id, { role: "viewer" });
    const token = tokenOf(inv.json.url);
    expect((await t.request("POST", `/v1/invitations/${token}/accept`)).status).toBe(401);
    const res = await t.request("POST", `/v1/invitations/${token}/accept`, { token: owner.token });
    expect(res.json).toMatchObject({ role: "owner", alreadyMember: true });
  });

  it("撤回、過期的邀請不能使用", async () => {
    const trip = await createTrip();
    const revoked = await invite(trip.id, { role: "viewer" });
    expect(
      (
        await t.request("DELETE", `/v1/trips/${trip.id}/invitations/${revoked.json.id}`, {
          token: owner.token,
        })
      ).status,
    ).toBe(204);
    const r1 = await t.request("POST", `/v1/invitations/${tokenOf(revoked.json.url)}/accept`, {
      token: alice.token,
    });
    expect(r1.status).toBe(410);
    expect(r1.json.type).toBe("/problems/invitation-revoked");

    const short = await invite(trip.id, { role: "viewer", expiresInDays: 1 });
    t.advance(2 * 86_400_000);
    const relogged = await t.login("m-alice", "小安");
    const r2 = await t.request("POST", `/v1/invitations/${tokenOf(short.json.url)}/accept`, {
      token: relogged.token,
    });
    expect(r2.json.type).toBe("/problems/invitation-expired");
    alice = relogged;
    owner = await t.login("m-owner", "陳");
    bob = await t.login("m-bob", "阿明");
  });

  it("不存在的邀請回 404", async () => {
    expect((await t.request("GET", "/v1/invitations/nope")).status).toBe(404);
  });

  it("列出有效的邀請，不含 token", async () => {
    const trip = await createTrip();
    await invite(trip.id, { role: "editor" });
    const gone = await invite(trip.id, { role: "viewer" });
    await t.request("DELETE", `/v1/trips/${trip.id}/invitations/${gone.json.id}`, {
      token: owner.token,
    });
    const list = await t.request("GET", `/v1/trips/${trip.id}/invitations`, { token: owner.token });
    expect(list.json.invitations).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain("/invite/");
  });
});

describe("Email 邀請", () => {
  it("寄出邀請信；只有 email 相符的帳號能接受，且只能用一次", async () => {
    const trip = await createTrip();
    const inv = await invite(trip.id, { role: "viewer", email: "M-Alice@example.com" });
    expect(inv.json.email).toBe("m-alice@example.com");
    expect(t.sentMail.at(-1)).toMatchObject({
      to: "m-alice@example.com",
      tripTitle: "京都・大阪 秋楓之旅",
      inviterName: "陳",
    });

    const token = tokenOf(inv.json.url);
    expect((await t.request("GET", `/v1/invitations/${token}`)).json.email).toBe(
      "m******@example.com",
    );

    const wrong = await t.request("POST", `/v1/invitations/${token}/accept`, { token: bob.token });
    expect(wrong.status).toBe(403);
    expect(wrong.json.type).toBe("/problems/invitation-email-mismatch");

    expect(
      (await t.request("POST", `/v1/invitations/${token}/accept`, { token: alice.token })).status,
    ).toBe(200);
    // 已被使用（換別人也不行；同一個人再用一次則因已是成員而直接成功）
    const reuse = await t.request("POST", `/v1/invitations/${token}/accept`, { token: bob.token });
    expect(reuse.json.type).toBe("/problems/invitation-used");
  });
});

describe("邀請權限", () => {
  it("編輯者可邀請編輯者與檢視者；檢視者不能邀請；任何人都不能邀請擁有者", async () => {
    const trip = await createTrip();
    await join(trip.id, alice, "editor");
    await join(trip.id, bob, "viewer");
    expect((await invite(trip.id, { role: "viewer" }, alice.token)).status).toBe(201);
    expect((await invite(trip.id, { role: "viewer" }, bob.token)).status).toBe(403);
    expect((await invite(trip.id, { role: "owner" })).status).toBe(422);
  });
});

describe("成員管理", () => {
  it("擁有者可以改角色、移除成員；不能改擁有者自己的角色", async () => {
    const trip = await createTrip();
    await join(trip.id, alice);
    const base = `/v1/trips/${trip.id}/members`;
    const changed = await t.request("PATCH", `${base}/${alice.userId}`, {
      token: owner.token,
      body: { role: "viewer" },
    });
    expect(changed.json).toEqual({ userId: alice.userId, role: "viewer" });
    expect(
      (
        await t.request("PATCH", `${base}/${owner.userId}`, {
          token: owner.token,
          body: { role: "viewer" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await t.request("PATCH", `${base}/${owner.userId}`, {
          token: alice.token,
          body: { role: "viewer" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.request("DELETE", `${base}/${alice.userId}`, { token: owner.token })).status,
    ).toBe(204);
    expect((await t.request("GET", `/v1/trips/${trip.id}`, { token: alice.token })).status).toBe(
      404,
    );
  });

  it("成員可以自己離開；擁有者要先轉移擁有權", async () => {
    const trip = await createTrip();
    await join(trip.id, alice);
    await join(trip.id, bob);
    const base = `/v1/trips/${trip.id}/members`;
    expect((await t.request("DELETE", `${base}/${bob.userId}`, { token: bob.token })).status).toBe(
      204,
    );
    expect(
      (await t.request("DELETE", `${base}/${alice.userId}`, { token: bob.token })).status,
    ).toBe(404); // 已離開
    expect(
      (await t.request("DELETE", `${base}/${owner.userId}`, { token: owner.token })).status,
    ).toBe(409);
    // 編輯者不能移除別人
    await join(trip.id, bob);
    expect(
      (await t.request("DELETE", `${base}/${bob.userId}`, { token: alice.token })).status,
    ).toBe(403);
  });

  it("轉移擁有權：新擁有者取得權限，原擁有者變成編輯者", async () => {
    const trip = await createTrip();
    await join(trip.id, alice);
    const res = await t.request("POST", `/v1/trips/${trip.id}/transfer-ownership`, {
      token: owner.token,
      body: { userId: alice.userId },
    });
    expect(res.json).toEqual({ ownerId: alice.userId });
    const detail = await t.request("GET", `/v1/trips/${trip.id}`, { token: owner.token });
    expect(detail.json.myRole).toBe("editor");
    expect(detail.json.ownerId).toBe(alice.userId);
    expect((await t.request("DELETE", `/v1/trips/${trip.id}`, { token: owner.token })).status).toBe(
      403,
    );
    // 原擁有者現在可以離開
    expect(
      (
        await t.request("DELETE", `/v1/trips/${trip.id}/members/${owner.userId}`, {
          token: owner.token,
        })
      ).status,
    ).toBe(204);
  });

  it("活動紀錄記下誰在什麼時候做了什麼", async () => {
    const trip = await createTrip();
    await join(trip.id, alice);
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: alice.token,
      body: { type: "sight", title: "清水寺" },
    });
    const res = await t.request("GET", `/v1/trips/${trip.id}/activity`, { token: owner.token });
    const actions = res.json.activity.map(
      (a: { action: string; actorName: string }) => `${a.actorName}:${a.action}`,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "小安:item.created",
        "小安:member.joined",
        "陳:invitation.created",
        "陳:trip.created",
      ]),
    );
  });
});
