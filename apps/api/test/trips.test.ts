import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let owner: Awaited<ReturnType<TestApp["login"]>>;
let stranger: Awaited<ReturnType<TestApp["login"]>>;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login("owner-sub", "陳");
  stranger = await t.login("stranger-sub", "路人");
});
afterAll(() => t.close());
beforeEach(async () => {
  // Independent scenarios must not consume each other's per-user request budgets.
  await t.db.delete(schema.rateLimits);
});

const kyoto = {
  title: "京都・大阪 秋楓之旅",
  startDate: "2026-12-03",
  endDate: "2026-12-08",
  primaryTz: "Asia/Tokyo",
  destinations: [{ cityKey: "jp-kyoto", name: "京都" }],
};

async function createTrip(token = owner.token, body: object = kyoto) {
  const res = await t.request("POST", "/v1/trips", { token, body });
  expect(res.status).toBe(201);
  return res.json;
}

async function addMember(tripId: string, userId: string, role: "editor" | "viewer") {
  await t.db.insert(schema.tripMembers).values({ tripId, userId, role });
}

async function createItem(tripId: string, body: object, token = owner.token) {
  return t.request("POST", `/v1/trips/${tripId}/items`, { token, body });
}

const flight = (dayId: string) => ({
  dayId,
  type: "transport",
  title: "台北桃園 → 關西機場",
  startAt: "2026-12-03T08:50:00+08:00",
  endAt: "2026-12-03T12:25:00+09:00",
  booking: { kind: "flight", status: "booked", confirmationCode: "ABC123" },
});

describe("行程", () => {
  it("建立行程時，擁有者自動成為成員，並依日期產生每一天", async () => {
    const trip = await createTrip();
    expect(trip.myRole).toBe("owner");
    expect(trip.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
      "2026-12-07",
      "2026-12-08",
    ]);

    const list = await t.request("GET", "/v1/trips", { token: owner.token });
    expect(list.json.trips.map((x: { id: string }) => x.id)).toContain(trip.id);

    const detail = await t.request("GET", `/v1/trips/${trip.id}`, { token: owner.token });
    expect(detail.headers.get("etag")).toBe('"v1"');
    expect(detail.json.members).toEqual([
      expect.objectContaining({ userId: owner.userId, role: "owner", displayName: "陳" }),
    ]);
  });

  it("驗證輸入：日期反了、無效時區都回 422", async () => {
    const bad = await t.request("POST", "/v1/trips", {
      token: owner.token,
      body: { ...kyoto, startDate: "2026-12-08", endDate: "2026-12-03", primaryTz: "Mars/Base" },
    });
    expect(bad.status).toBe(422);
    const paths = bad.json.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain("primaryTz");
  });

  it("不是成員的人看不到行程（404，不透露行程存在）", async () => {
    const trip = await createTrip();
    const res = await t.request("GET", `/v1/trips/${trip.id}`, { token: stranger.token });
    expect(res.status).toBe(404);
    expect((await t.request("GET", "/v1/trips", { token: stranger.token })).json.trips).toEqual([]);
  });

  it("修改需要 If-Match；版本不符回 412；成功後版本 +1", async () => {
    const trip = await createTrip();
    const path = `/v1/trips/${trip.id}`;
    expect(
      (await t.request("PATCH", path, { token: owner.token, body: { title: "新名字" } })).status,
    ).toBe(428);
    expect(
      (
        await t.request("PATCH", path, {
          token: owner.token,
          body: { title: "x" },
          headers: { "If-Match": '"v9"' },
        })
      ).status,
    ).toBe(412);
    const ok = await t.request("PATCH", path, {
      token: owner.token,
      body: { title: "京都賞楓" },
      headers: { "If-Match": '"v1"' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.title).toBe("京都賞楓");
    expect(ok.headers.get("etag")).toBe('"v2"');
  });

  it("縮短日期會移除空的日子；被移除的日子還有行程點時回 409", async () => {
    const trip = await createTrip();
    const lastDay = trip.days.at(-1);
    await createItem(trip.id, { dayId: lastDay.id, type: "sight", title: "大阪城" });

    const blocked = await t.request("PATCH", `/v1/trips/${trip.id}`, {
      token: owner.token,
      body: { endDate: "2026-12-06" },
      headers: { "If-Match": '"v1"' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.dates).toEqual(["2026-12-08"]);

    const extended = await t.request("PATCH", `/v1/trips/${trip.id}`, {
      token: owner.token,
      body: { startDate: "2026-12-04", endDate: "2026-12-09" },
      headers: { "If-Match": '"v1"' },
    });
    expect(extended.status).toBe(200);
    const detail = await t.request("GET", `/v1/trips/${trip.id}`, { token: owner.token });
    expect(detail.json.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
      "2026-12-07",
      "2026-12-08",
      "2026-12-09",
    ]);
  });

  it("只有擁有者能刪除行程；已確定的行程點會一起刪除", async () => {
    const trip = await createTrip();
    await addMember(trip.id, stranger.userId, "editor");
    await createItem(trip.id, flight(trip.days[0].id));
    expect(
      (await t.request("DELETE", `/v1/trips/${trip.id}`, { token: stranger.token })).status,
    ).toBe(403);
    expect((await t.request("DELETE", `/v1/trips/${trip.id}`, { token: owner.token })).status).toBe(
      204,
    );
    expect((await t.request("GET", `/v1/trips/${trip.id}`, { token: owner.token })).status).toBe(
      404,
    );
  });
});

describe("行程點", () => {
  it("新增時預設用行程時區，並依序排在當天最後", async () => {
    const trip = await createTrip();
    const day = trip.days[1].id;
    const a = await createItem(trip.id, { dayId: day, type: "sight", title: "清水寺" });
    const b = await createItem(trip.id, { dayId: day, type: "sight", title: "二年坂" });
    expect(a.status).toBe(201);
    expect(a.json.item.tz).toBe("Asia/Tokyo");
    expect(a.json.item.sortKey < b.json.item.sortKey).toBe(true);

    const list = await t.request("GET", `/v1/trips/${trip.id}/items?dayId=${day}`, {
      token: owner.token,
    });
    expect(list.json.items.map((i: { title: string }) => i.title)).toEqual(["清水寺", "二年坂"]);
  });

  it("移動：插到當天最前面、移到其他天、移到未排入", async () => {
    const trip = await createTrip();
    const [d1, d2] = [trip.days[0].id, trip.days[1].id];
    const a = (await createItem(trip.id, { dayId: d1, type: "sight", title: "A" })).json.item;
    await createItem(trip.id, { dayId: d1, type: "sight", title: "B" });
    const c = (await createItem(trip.id, { dayId: d1, type: "sight", title: "C" })).json.item;

    const move = (id: string, body: object) =>
      t.request("POST", `/v1/trips/${trip.id}/items/${id}/move`, { token: owner.token, body });
    const titles = async (dayId: string) =>
      (
        await t.request("GET", `/v1/trips/${trip.id}/items?dayId=${dayId}`, { token: owner.token })
      ).json.items.map((i: { title: string }) => i.title);

    expect((await move(c.id, { dayId: d1, index: 0 })).status).toBe(200);
    expect(await titles(d1)).toEqual(["C", "A", "B"]);
    await move(c.id, { dayId: d1, index: 2 });
    expect(await titles(d1)).toEqual(["A", "B", "C"]);
    await move(a.id, { dayId: d2, index: 99 });
    expect(await titles(d1)).toEqual(["B", "C"]);
    expect(await titles(d2)).toEqual(["A"]);
    await move(a.id, { dayId: null, index: 0 });
    expect(await titles("none")).toEqual(["A"]);
  });

  it("不能把行程點放進別的行程的日子", async () => {
    const trip = await createTrip();
    const other = await createTrip();
    const res = await createItem(trip.id, { dayId: other.days[0].id, type: "sight", title: "x" });
    expect(res.status).toBe(404);
  });

  it("修改行程點需要 If-Match", async () => {
    const trip = await createTrip();
    const item = (await createItem(trip.id, { dayId: trip.days[0].id, type: "sight", title: "x" }))
      .json.item;
    const path = `/v1/trips/${trip.id}/items/${item.id}`;
    expect(
      (await t.request("PATCH", path, { token: owner.token, body: { title: "y" } })).status,
    ).toBe(428);
    const ok = await t.request("PATCH", path, {
      token: owner.token,
      body: { title: "y" },
      headers: { "If-Match": '"v1"' },
    });
    expect(ok.json.item.title).toBe("y");
    expect(ok.json.item.version).toBe(2);
  });
});

describe("確定（釘選）行程點", () => {
  it("訂位狀態為已訂位時自動確定", async () => {
    const trip = await createTrip();
    const res = await createItem(trip.id, flight(trip.days[0].id));
    expect(res.status).toBe(201);
    expect(res.json.item).toMatchObject({
      confirmed: true,
      confirmSource: "booking",
      confirmedBy: owner.userId,
    });
    expect(res.json.item.booking).toMatchObject({
      kind: "flight",
      status: "booked",
      confirmationCode: "ABC123",
    });
  });

  it("已確定的行程點：能改備註，不能改時間、移動或刪除（423）", async () => {
    const trip = await createTrip();
    const item = (await createItem(trip.id, flight(trip.days[0].id))).json.item;
    const base = `/v1/trips/${trip.id}/items/${item.id}`;

    const notes = await t.request("PATCH", base, {
      token: owner.token,
      body: { notes: "記得帶護照" },
      headers: { "If-Match": '"v1"' },
    });
    expect(notes.status).toBe(200);

    const time = await t.request("PATCH", base, {
      token: owner.token,
      body: { startAt: "2026-12-03T10:00:00+08:00" },
      headers: { "If-Match": '"v2"' },
    });
    expect(time.status).toBe(423);
    expect(time.json).toMatchObject({
      type: "/problems/item-confirmed",
      lockedFields: ["startAt"],
    });

    const move = await t.request("POST", `${base}/move`, {
      token: owner.token,
      body: { dayId: trip.days[1].id, index: 0 },
    });
    expect(move.status).toBe(423);
    expect((await t.request("DELETE", base, { token: owner.token })).status).toBe(423);
  });

  it("訂位的出發／抵達資訊鎖定，座位等其他明細可以改", async () => {
    const trip = await createTrip();
    const item = (
      await createItem(trip.id, {
        ...flight(trip.days[0].id),
        booking: { kind: "flight", status: "booked", details: { departAt: "08:50", seat: "32A" } },
      })
    ).json.item;
    const path = `/v1/trips/${trip.id}/items/${item.id}/booking`;
    expect(
      (
        await t.request("PATCH", path, {
          token: owner.token,
          body: { details: { departAt: "09:50" } },
        })
      ).status,
    ).toBe(423);
    const seat = await t.request("PATCH", path, {
      token: owner.token,
      body: { details: { seat: "33B" } },
    });
    expect(seat.status).toBe(200);
    expect(seat.json.booking.details).toEqual({ departAt: "08:50", seat: "33B" });
  });

  it("解除確定（取消）後，訂位變成已取消，行程點可以移動與刪除", async () => {
    const trip = await createTrip();
    const item = (await createItem(trip.id, flight(trip.days[0].id))).json.item;
    const base = `/v1/trips/${trip.id}/items/${item.id}`;

    const res = await t.request("POST", `${base}/unconfirm`, {
      token: owner.token,
      body: { reason: "cancel" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ confirmed: false, booking: { status: "cancelled" } });
    expect(
      (
        await t.request("POST", `${base}/move`, {
          token: owner.token,
          body: { dayId: null, index: 0 },
        })
      ).status,
    ).toBe(200);
    expect((await t.request("DELETE", base, { token: owner.token })).status).toBe(204);

    const log = await t.db
      .select({ action: schema.activityLog.action, diff: schema.activityLog.diff })
      .from(schema.activityLog)
      .where(eq(schema.activityLog.targetId, item.id));
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(["item.created", "item.unconfirmed", "item.moved", "item.deleted"]),
    );
    expect(log.find((l) => l.action === "item.unconfirmed")?.diff).toMatchObject({
      reason: "cancel",
    });
  });

  it("改期解除時訂位回到規劃中；已確定的訂位不能直接改回規劃中", async () => {
    const trip = await createTrip();
    const item = (await createItem(trip.id, flight(trip.days[0].id))).json.item;
    const base = `/v1/trips/${trip.id}/items/${item.id}`;
    const direct = await t.request("PATCH", `${base}/booking`, {
      token: owner.token,
      body: { status: "planned" },
    });
    expect(direct.status).toBe(409);

    const res = await t.request("POST", `${base}/unconfirm`, {
      token: owner.token,
      body: { reason: "reschedule" },
    });
    expect(res.json.booking.status).toBe("planned");
  });

  it("訂位狀態改為已訂位會確定；取消訂位會解除", async () => {
    const trip = await createTrip();
    const item = (
      await createItem(trip.id, {
        dayId: trip.days[1].id,
        type: "food",
        title: "先斗町 川床料理",
        booking: { kind: "restaurant", status: "planned" },
      })
    ).json.item;
    expect(item.confirmed).toBe(false);
    const path = `/v1/trips/${trip.id}/items/${item.id}/booking`;
    const booked = await t.request("PATCH", path, {
      token: owner.token,
      body: { status: "booked" },
    });
    expect(booked.json).toMatchObject({ confirmed: true, confirmSource: "booking" });
    const cancelled = await t.request("PATCH", path, {
      token: owner.token,
      body: { status: "cancelled" },
    });
    expect(cancelled.json).toMatchObject({ confirmed: false, booking: { status: "cancelled" } });
  });

  it("手動確定與重複操作", async () => {
    const trip = await createTrip();
    const item = (
      await createItem(trip.id, {
        dayId: trip.days[2].id,
        type: "note",
        title: "09:00 飯店大廳集合",
      })
    ).json.item;
    const base = `/v1/trips/${trip.id}/items/${item.id}`;
    const confirmed = await t.request("POST", `${base}/confirm`, { token: owner.token });
    expect(confirmed.json).toMatchObject({ confirmed: true, confirmSource: "manual" });
    expect((await t.request("POST", `${base}/confirm`, { token: owner.token })).status).toBe(409);
    await t.request("POST", `${base}/unconfirm`, { token: owner.token, body: { reason: "other" } });
    expect(
      (
        await t.request("POST", `${base}/unconfirm`, {
          token: owner.token,
          body: { reason: "other" },
        })
      ).status,
    ).toBe(409);
  });

  it("與已確定行程點時間重疊時回傳警告（不阻擋）", async () => {
    const trip = await createTrip();
    const day = trip.days[1].id;
    const dinner = (
      await createItem(trip.id, {
        dayId: day,
        type: "food",
        title: "晚餐",
        startAt: "2026-12-04T18:30:00+09:00",
        endAt: "2026-12-04T20:00:00+09:00",
        booking: { kind: "restaurant", status: "booked" },
      })
    ).json.item;
    const res = await createItem(trip.id, {
      dayId: day,
      type: "sight",
      title: "祇園散步",
      startAt: "2026-12-04T18:00:00+09:00",
      endAt: "2026-12-04T19:00:00+09:00",
    });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toEqual([{ type: "overlaps-confirmed", itemId: dinner.id }]);
  });

  it("即使繞過 API 直接改資料庫，資料庫 trigger 也會擋下", async () => {
    const trip = await createTrip();
    const item = (await createItem(trip.id, flight(trip.days[0].id))).json.item;
    await expect(
      t.db
        .update(schema.itineraryItems)
        .set({ startAt: new Date("2026-12-03T03:00:00Z") })
        .where(eq(schema.itineraryItems.id, item.id)),
    ).rejects.toThrow();
  });
});

describe("權限", () => {
  it("檢視者可以看，但不能新增、修改、確定", async () => {
    const trip = await createTrip();
    await addMember(trip.id, stranger.userId, "viewer");
    const item = (await createItem(trip.id, { dayId: trip.days[0].id, type: "sight", title: "x" }))
      .json.item;
    const base = `/v1/trips/${trip.id}/items/${item.id}`;

    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/items`, { token: stranger.token })).status,
    ).toBe(200);
    expect((await createItem(trip.id, { type: "sight", title: "y" }, stranger.token)).status).toBe(
      403,
    );
    expect(
      (
        await t.request("PATCH", base, {
          token: stranger.token,
          body: { title: "z" },
          headers: { "If-Match": '"v1"' },
        })
      ).status,
    ).toBe(403);
    expect((await t.request("POST", `${base}/confirm`, { token: stranger.token })).status).toBe(
      403,
    );
    expect((await t.request("DELETE", base, { token: stranger.token })).status).toBe(403);
  });

  it("編輯者可以編輯、確定與解除確定，但不能刪除行程或改擁有者設定", async () => {
    const trip = await createTrip();
    await addMember(trip.id, stranger.userId, "editor");
    const res = await createItem(trip.id, flight(trip.days[0].id), stranger.token);
    expect(res.status).toBe(201);
    const base = `/v1/trips/${trip.id}/items/${res.json.item.id}`;
    expect(
      (
        await t.request("POST", `${base}/unconfirm`, {
          token: stranger.token,
          body: { reason: "reschedule" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await t.request("DELETE", `/v1/trips/${trip.id}`, { token: stranger.token })).status,
    ).toBe(403);
  });

  it("不能透過別的行程的網址存取行程點", async () => {
    const mine = await createTrip();
    const theirs = await createTrip(stranger.token);
    const item = (await createItem(theirs.id, { type: "sight", title: "x" }, stranger.token)).json
      .item;
    const res = await t.request("GET", `/v1/trips/${mine.id}/items/${item.id}`, {
      token: owner.token,
    });
    expect(res.status).toBe(404);
  });
});
