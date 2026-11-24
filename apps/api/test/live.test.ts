import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["login"]>>;
let owner: User;
let friend: User;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login("live-owner", "陳");
  friend = await t.login("live-friend", "小安");
});
afterAll(() => t.close());

async function createTrip(token = owner.token) {
  return (
    await t.request("POST", "/v1/trips", {
      token,
      body: {
        title: "京都",
        startDate: "2026-12-03",
        endDate: "2026-12-05",
        primaryTz: "Asia/Tokyo",
      },
    })
  ).json;
}

describe("快速筆記", () => {
  it("依行程時區的日期歸到對應的那一天；行程外的日期不歸到任何一天", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}/notes`;
    // 2026-12-03T16:30Z = 東京 12/4 01:30
    const late = await t.request("POST", base, {
      token: owner.token,
      body: { body: "鴨川邊散步", takenAt: "2026-12-03T16:30:00Z", lat: 35.0045, lng: 135.7712 },
    });
    expect(late.status).toBe(201);
    expect(late.json).toMatchObject({
      dayId: trip.days[1].id,
      lat: 35.0045,
      lng: 135.7712,
      author: { displayName: "陳" },
    });
    const outside = await t.request("POST", base, {
      token: owner.token,
      body: { body: "出發前一天", takenAt: "2026-12-01T03:00:00Z" },
    });
    expect(outside.json.dayId).toBeNull();

    // 指定 dayId 時以指定的為準；別趟行程的 dayId 不接受
    const pinned = await t.request("POST", base, {
      token: owner.token,
      body: { body: "記在第三天", takenAt: "2026-12-01T03:00:00Z", dayId: trip.days[2].id },
    });
    expect(pinned.json.dayId).toBe(trip.days[2].id);
    const other = await createTrip();
    const foreign = await t.request("POST", base, {
      token: owner.token,
      body: { body: "亂指定", dayId: other.days[0].id },
    });
    expect(foreign.status).toBe(404);

    const day2 = await t.request("GET", `${base}?dayId=${trip.days[1].id}`, { token: owner.token });
    expect(day2.json.notes.map((n: { body: string }) => n.body)).toEqual(["鴨川邊散步"]);
  });

  it("檢視者預設可以寫筆記；只能刪自己的，擁有者可以刪任何人的", async () => {
    const trip = await createTrip();
    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "viewer" });
    const base = `/v1/trips/${trip.id}/notes`;
    const mine = await t.request("POST", base, { token: owner.token, body: { body: "陳的筆記" } });
    const theirs = await t.request("POST", base, {
      token: friend.token,
      body: { body: "小安的筆記" },
    });
    expect(theirs.status).toBe(201);
    expect(
      (await t.request("DELETE", `${base}/${mine.json.id}`, { token: friend.token })).status,
    ).toBe(403);
    expect(
      (await t.request("DELETE", `${base}/${theirs.json.id}`, { token: owner.token })).status,
    ).toBe(204);

    await t.db
      .update(schema.trips)
      .set({ viewerCanWriteJournal: false })
      .where(eq(schema.trips.id, trip.id));
    expect(
      (await t.request("POST", base, { token: friend.token, body: { body: "x" } })).status,
    ).toBe(403);
  });

  it("可以掛在行程點上，但不能掛在別的行程的行程點", async () => {
    const trip = await createTrip();
    const other = await createTrip();
    const item = (
      await t.request("POST", `/v1/trips/${other.id}/items`, {
        token: owner.token,
        body: { type: "sight", title: "x" },
      })
    ).json.item;
    const res = await t.request("POST", `/v1/trips/${trip.id}/notes`, {
      token: owner.token,
      body: { body: "y", itemId: item.id },
    });
    expect(res.status).toBe(404);
  });
});

describe("離線快照", () => {
  it("一次取得行程、日期、成員、行程點與筆記", async () => {
    const trip = await createTrip();
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: {
        dayId: trip.days[0].id,
        type: "stay",
        title: "飯店",
        booking: { kind: "lodging", status: "booked" },
      },
    });
    await t.request("POST", `/v1/trips/${trip.id}/notes`, {
      token: owner.token,
      body: { body: "Wi-Fi 密碼在櫃檯" },
    });
    const res = await t.request("GET", `/v1/trips/${trip.id}/snapshot`, { token: owner.token });
    expect(res.json.trip).toMatchObject({ id: trip.id, myRole: "owner" });
    expect(res.json.trip.days).toHaveLength(3);
    expect(res.json.trip.members).toHaveLength(1);
    expect(res.json.items[0]).toMatchObject({
      title: "飯店",
      confirmed: true,
      booking: { status: "booked" },
    });
    expect(res.json.notes[0].body).toBe("Wi-Fi 密碼在櫃檯");
    expect(typeof res.json.generatedAt).toBe("string");
    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/snapshot`, { token: friend.token })).status,
    ).toBe(404);
  });
});

describe("行程內搜尋", () => {
  it("搜尋行程點名稱、地點、訂位代號、筆記與想去清單", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}`;
    await t.request("POST", `${base}/items`, {
      token: owner.token,
      body: {
        type: "food",
        title: "晚餐",
        googlePlaceId: "ponto",
        booking: { kind: "restaurant", confirmationCode: "PT-0312" },
      },
    });
    await t.request("POST", `${base}/items`, {
      token: owner.token,
      body: { type: "transport", title: "JR Pass 兌換" },
    });
    await t.request("POST", `${base}/notes`, {
      token: owner.token,
      body: { body: "JR 綠色窗口在 2 樓" },
    });
    await t.request("POST", `${base}/wishlist`, {
      token: owner.token,
      body: { googlePlaceId: "fushimi" },
    });

    const q = async (s: string) =>
      (await t.request("GET", `${base}/search?q=${encodeURIComponent(s)}`, { token: owner.token }))
        .json;
    expect((await q("先斗町")).items.map((i: { title: string }) => i.title)).toEqual(["晚餐"]); // 地點名稱
    expect((await q("pt-0312")).items.map((i: { title: string }) => i.title)).toEqual(["晚餐"]); // 訂位代號，不分大小寫
    const jr = await q("JR");
    expect(jr.items.map((i: { title: string }) => i.title)).toEqual(["JR Pass 兌換"]);
    expect(jr.notes).toHaveLength(1);
    expect((await q("伏見")).wishlist[0].place.name).toBe("伏見稻荷大社");
    // % 與 _ 視為一般字元
    expect((await q("%")).items).toEqual([]);
  });
});

describe("即時同步（SSE）", () => {
  async function openStream(tripId: string, token: string) {
    const res = await t.app.request(`/v1/trips/${tripId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      async waitFor(predicate: (text: string) => boolean, ms = 3000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (predicate(buffer)) return buffer;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
          ]);
          if (chunk === null || chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        if (predicate(buffer)) return buffer;
        throw new Error(`timeout; received: ${buffer}`);
      },
      close: () => reader.cancel(),
    };
  }

  it("其他成員修改行程時，訂閱者馬上收到事件；也會收到心跳", async () => {
    const trip = await createTrip();
    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "editor" });
    const stream = await openStream(trip.id, owner.token);
    await stream.waitFor((b) => b.includes("event: ready"));

    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: friend.token,
      body: { type: "sight", title: "金閣寺" },
    });
    const text = await stream.waitFor((b) => b.includes("item.created"));
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.includes("item.created"))
      .map((l) => JSON.parse(l.slice(6)))[0];
    expect(data).toMatchObject({
      tripId: trip.id,
      action: "item.created",
      actorId: friend.userId,
      via: "app",
    });

    await stream.waitFor((b) => b.includes("event: ping"));
    await stream.close();
  });

  it("只收到自己訂閱的行程的事件", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const stream = await openStream(a.id, owner.token);
    await stream.waitFor((x) => x.includes("event: ready"));
    await t.request("POST", `/v1/trips/${b.id}/items`, {
      token: owner.token,
      body: { type: "sight", title: "別的行程" },
    });
    await t.request("POST", `/v1/trips/${a.id}/items`, {
      token: owner.token,
      body: { type: "sight", title: "這個行程" },
    });
    const text = await stream.waitFor((x) => x.includes("item.created"));
    expect(text).toContain(a.id);
    expect(text).not.toContain(b.id);
    await stream.close();
  });

  it("不是成員不能訂閱；斷線後不再保留訂閱", async () => {
    const trip = await createTrip();
    const res = await t.app.request(`/v1/trips/${trip.id}/events`, {
      headers: { Authorization: `Bearer ${friend.token}` },
    });
    expect(res.status).toBe(404);
    const before = t.events.subscriberCount;
    const stream = await openStream(trip.id, owner.token);
    await stream.waitFor((b) => b.includes("event: ready"));
    expect(t.events.subscriberCount).toBe(before + 1);
    await stream.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(t.events.subscriberCount).toBe(before);
  });
});
