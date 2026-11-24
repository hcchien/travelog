import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let owner: Awaited<ReturnType<TestApp["login"]>>;
let friend: Awaited<ReturnType<TestApp["login"]>>;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login("places-owner", "陳");
  friend = await t.login("places-friend", "小安");
});
afterAll(() => t.close());

async function createTrip(destinations = [{ cityKey: "jp-kyoto", name: "京都" }]) {
  const res = await t.request("POST", "/v1/trips", {
    token: owner.token,
    body: {
      title: "京都",
      startDate: "2026-12-03",
      endDate: "2026-12-05",
      primaryTz: "Asia/Taipei",
      destinations,
    },
  });
  return res.json;
}

describe("地點搜尋與解析", () => {
  it("自動完成需要登入", async () => {
    expect((await t.request("GET", "/v1/places/autocomplete?q=清水&session=abcdefgh")).status).toBe(
      401,
    );
    const res = await t.request("GET", "/v1/places/autocomplete?q=清水&session=abcdefgh", {
      token: owner.token,
    });
    expect(res.json.suggestions).toEqual([
      expect.objectContaining({ googlePlaceId: "kiyomizu", mainText: "清水寺" }),
    ]);
  });

  it("解析地點時算出城市與時區，並快取 30 天", async () => {
    const before = t.placeCalls.details;
    const a = await t.request("POST", "/v1/places/resolve", {
      token: owner.token,
      body: { googlePlaceId: "kiyomizu" },
    });
    expect(a.json).toMatchObject({
      name: "清水寺",
      cityKey: "jp-kyoto",
      cityName: "京都",
      tz: "Asia/Tokyo",
      category: "sight",
      lat: 34.9949,
      lng: 135.785,
    });
    await t.request("POST", "/v1/places/resolve", {
      token: owner.token,
      body: { googlePlaceId: "kiyomizu" },
    });
    expect(t.placeCalls.details - before).toBe(1);

    // 把快取時間往回調 31 天（不移動時鐘，避免讓登入過期）
    await t.db
      .update(schema.places)
      .set({ fetchedAt: new Date(Date.parse("2026-10-01T00:00:00Z")) })
      .where(eq(schema.places.googlePlaceId, "kiyomizu"));
    await t.request("POST", "/v1/places/resolve", {
      token: owner.token,
      body: { googlePlaceId: "kiyomizu" },
    });
    expect(t.placeCalls.details - before).toBe(2);
  });

  it("東京各區的地點都歸到東京", async () => {
    const res = await t.request("POST", "/v1/places/resolve", {
      token: owner.token,
      body: { googlePlaceId: "fuglen" },
    });
    expect(res.json).toMatchObject({ cityKey: "jp-tokyo", cityName: "東京", category: "cafe" });
  });

  it("找不到的地點回 404", async () => {
    const res = await t.request("POST", "/v1/places/resolve", {
      token: owner.token,
      body: { googlePlaceId: "nope" },
    });
    expect(res.status).toBe(404);
  });
});

describe("行程點的地點", () => {
  it("行程點帶地點時，時區預設為地點所在時區，回應附上地點", async () => {
    const trip = await createTrip();
    const res = await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: { dayId: trip.days[0].id, type: "sight", title: "清水寺", googlePlaceId: "kiyomizu" },
    });
    expect(res.status).toBe(201);
    expect(res.json.item.tz).toBe("Asia/Tokyo"); // 行程主要時區是 Asia/Taipei，但地點在日本
    expect(res.json.item.place).toMatchObject({ googlePlaceId: "kiyomizu", name: "清水寺" });

    const list = await t.request("GET", `/v1/trips/${trip.id}/items`, { token: owner.token });
    expect(list.json.items[0].place.name).toBe("清水寺");
  });

  it("可以更換或移除地點；已確定的行程點不能換地點", async () => {
    const trip = await createTrip();
    const item = (
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: owner.token,
        body: { dayId: trip.days[0].id, type: "food", title: "晚餐", googlePlaceId: "ponto" },
      })
    ).json.item;
    const path = `/v1/trips/${trip.id}/items/${item.id}`;
    const changed = await t.request("PATCH", path, {
      token: owner.token,
      body: { googlePlaceId: "ichiran" },
      headers: { "If-Match": '"v1"' },
    });
    expect(changed.json.item.place.name).toBe("一蘭 澀谷店");
    const removed = await t.request("PATCH", path, {
      token: owner.token,
      body: { googlePlaceId: null },
      headers: { "If-Match": '"v2"' },
    });
    expect(removed.json.item.place).toBeNull();

    const booked = (
      await t.request("POST", `/v1/trips/${trip.id}/items`, {
        token: owner.token,
        body: {
          dayId: trip.days[0].id,
          type: "food",
          title: "已訂位晚餐",
          googlePlaceId: "ponto",
          booking: { kind: "restaurant", status: "booked" },
        },
      })
    ).json.item;
    const locked = await t.request("PATCH", `/v1/trips/${trip.id}/items/${booked.id}`, {
      token: owner.token,
      body: { googlePlaceId: "ichiran" },
      headers: { "If-Match": '"v1"' },
    });
    expect(locked.status).toBe(423);
    expect(locked.json.lockedFields).toEqual(["placeId"]);
  });
});

describe("想去清單", () => {
  it("加入、不能重複、依票數排序，檢視者可以投票但不能新增", async () => {
    const trip = await createTrip();
    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "viewer" });
    const base = `/v1/trips/${trip.id}/wishlist`;

    const a = await t.request("POST", base, {
      token: owner.token,
      body: { googlePlaceId: "kiyomizu", note: "早上去" },
    });
    expect(a.status).toBe(201);
    const b = await t.request("POST", base, {
      token: owner.token,
      body: { googlePlaceId: "fushimi" },
    });
    expect(
      (await t.request("POST", base, { token: owner.token, body: { googlePlaceId: "fushimi" } }))
        .status,
    ).toBe(409);
    expect(
      (await t.request("POST", base, { token: friend.token, body: { googlePlaceId: "ponto" } }))
        .status,
    ).toBe(403);

    expect(
      (await t.request("POST", `${base}/${b.json.id}/vote`, { token: friend.token })).status,
    ).toBe(204);
    await t.request("POST", `${base}/${b.json.id}/vote`, { token: owner.token });
    await t.request("POST", `${base}/${b.json.id}/vote`, { token: owner.token }); // 重複投票不會加票

    const list = await t.request("GET", base, { token: friend.token });
    expect(list.json.items.map((i: { place: { name: string } }) => i.place.name)).toEqual([
      "伏見稻荷大社",
      "清水寺",
    ]);
    expect(list.json.items[0]).toMatchObject({ votes: 2, votedByMe: true });
    expect(list.json.items[1]).toMatchObject({
      votes: 0,
      votedByMe: false,
      note: "早上去",
      addedBy: { displayName: "陳" },
    });

    await t.request("DELETE", `${base}/${b.json.id}/vote`, { token: friend.token });
    const after = await t.request("GET", base, { token: friend.token });
    expect(after.json.items[0]).toMatchObject({ votes: 1, votedByMe: false });
  });

  it("排入某一天：建立行程點並從清單移除；可選擇保留", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}/wishlist`;
    const day = trip.days[1].id;
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: { dayId: day, type: "sight", title: "既有行程" },
    });
    const shrine = (
      await t.request("POST", base, {
        token: owner.token,
        body: { googlePlaceId: "fushimi", note: "人很多" },
      })
    ).json;
    const dinner = (
      await t.request("POST", base, { token: owner.token, body: { googlePlaceId: "ponto" } })
    ).json;

    const s1 = await t.request("POST", `${base}/${shrine.id}/schedule`, {
      token: owner.token,
      body: { dayId: day, index: 0 },
    });
    expect(s1.status).toBe(201);
    expect(s1.json.item).toMatchObject({
      title: "伏見稻荷大社",
      type: "sight",
      notes: "人很多",
      tz: "Asia/Tokyo",
    });
    const s2 = await t.request("POST", `${base}/${dinner.id}/schedule`, {
      token: owner.token,
      body: { dayId: day, keepInWishlist: true },
    });
    expect(s2.json.item.type).toBe("food");

    const items = await t.request("GET", `/v1/trips/${trip.id}/items?dayId=${day}`, {
      token: owner.token,
    });
    expect(items.json.items.map((i: { title: string }) => i.title)).toEqual([
      "伏見稻荷大社",
      "既有行程",
      "先斗町 川床料理",
    ]);
    const wishlist = await t.request("GET", base, { token: owner.token });
    expect(wishlist.json.items.map((i: { id: string }) => i.id)).toEqual([dinner.id]);
  });
});

describe("我的地點庫", () => {
  it("收藏時自動歸到城市並推測分類；不能重複收藏", async () => {
    const res = await t.request("POST", "/v1/me/saved-places", {
      token: owner.token,
      body: {
        googlePlaceId: "fuglen",
        tags: [" 早餐 ", "早餐", "必去"],
        privateNote: "週末要排隊",
      },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      cityKey: "jp-tokyo",
      cityName: "東京",
      category: "cafe",
      tags: ["早餐", "必去"],
    });
    const dup = await t.request("POST", "/v1/me/saved-places", {
      token: owner.token,
      body: { googlePlaceId: "fuglen" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.savedPlaceId).toBe(res.json.id);
  });

  it("依城市、分類、標籤篩選，並列出城市與數量", async () => {
    await t.request("POST", "/v1/me/saved-places", {
      token: owner.token,
      body: { googlePlaceId: "ichiran", tags: ["宵夜"] },
    });
    await t.request("POST", "/v1/me/saved-places", {
      token: owner.token,
      body: { googlePlaceId: "kiyomizu" },
    });

    const cities = await t.request("GET", "/v1/me/saved-places/cities", { token: owner.token });
    expect(cities.json.cities).toEqual([
      { cityKey: "jp-tokyo", cityName: "東京", count: 2 },
      { cityKey: "jp-kyoto", cityName: "京都", count: 1 },
    ]);
    const tokyo = await t.request("GET", "/v1/me/saved-places?city=jp-tokyo", {
      token: owner.token,
    });
    expect(tokyo.json.items).toHaveLength(2);
    const food = await t.request("GET", "/v1/me/saved-places?city=jp-tokyo&category=food", {
      token: owner.token,
    });
    expect(food.json.items.map((i: { place: { name: string } }) => i.place.name)).toEqual([
      "一蘭 澀谷店",
    ]);
    const tagged = await t.request("GET", `/v1/me/saved-places?tag=${encodeURIComponent("必去")}`, {
      token: owner.token,
    });
    expect(tagged.json.items.map((i: { place: { name: string } }) => i.place.name)).toEqual([
      "Fuglen Tokyo",
    ]);
  });

  it("依行程目的地篩選：東京行程只看到東京的地點", async () => {
    const trip = await createTrip([{ cityKey: "jp-tokyo", name: "東京" }]);
    const res = await t.request("GET", `/v1/me/saved-places?tripId=${trip.id}`, {
      token: owner.token,
    });
    expect(res.json.items.every((i: { cityKey: string }) => i.cityKey === "jp-tokyo")).toBe(true);
    expect(res.json.items).toHaveLength(2);
    // 不是成員就不能用別人的行程篩選
    expect(
      (await t.request("GET", `/v1/me/saved-places?tripId=${trip.id}`, { token: friend.token }))
        .status,
    ).toBe(404);
  });

  it("地點庫只屬於自己：別人看不到也改不到", async () => {
    const mine = (await t.request("GET", "/v1/me/saved-places", { token: owner.token })).json
      .items[0];
    expect(
      (await t.request("GET", "/v1/me/saved-places", { token: friend.token })).json.items,
    ).toEqual([]);
    expect(
      (
        await t.request("PATCH", `/v1/me/saved-places/${mine.id}`, {
          token: friend.token,
          body: { tags: ["x"] },
        })
      ).status,
    ).toBe(404);
    expect(
      (await t.request("DELETE", `/v1/me/saved-places/${mine.id}`, { token: friend.token })).status,
    ).toBe(404);
  });

  it("可以修改分類、標籤、備註與城市", async () => {
    const item = (
      await t.request("GET", "/v1/me/saved-places?city=jp-kyoto", { token: owner.token })
    ).json.items[0];
    const res = await t.request("PATCH", `/v1/me/saved-places/${item.id}`, {
      token: owner.token,
      body: {
        category: "sight",
        tags: ["紅葉"],
        privateNote: "11 月底最美",
        cityKey: "jp-kansai",
        cityName: "關西",
      },
    });
    expect(res.json).toMatchObject({
      category: "sight",
      tags: ["紅葉"],
      cityKey: "jp-kansai",
      cityName: "關西",
    });
    const bad = await t.request("PATCH", `/v1/me/saved-places/${item.id}`, {
      token: owner.token,
      body: { cityKey: "x" },
    });
    expect(bad.status).toBe(422);
  });

  it("從地點庫加入想去清單；私人備註預設不帶入", async () => {
    const trip = await createTrip([{ cityKey: "jp-tokyo", name: "東京" }]);
    await t.db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: friend.userId, role: "editor" });
    const saved = (
      await t.request("GET", `/v1/me/saved-places?tripId=${trip.id}`, { token: owner.token })
    ).json.items;
    const fuglen = saved.find((s: { place: { name: string } }) => s.place.name === "Fuglen Tokyo");
    const ichiran = saved.find((s: { place: { name: string } }) => s.place.name === "一蘭 澀谷店");
    const base = `/v1/trips/${trip.id}/wishlist`;

    const plain = await t.request("POST", base, {
      token: owner.token,
      body: { savedPlaceId: fuglen.id },
    });
    expect(plain.json.note).toBeNull();
    await t.request("DELETE", `${base}/${plain.json.id}`, { token: owner.token });
    const withNote = await t.request("POST", base, {
      token: owner.token,
      body: { savedPlaceId: fuglen.id, includePrivateNote: true },
    });
    expect(withNote.json.note).toBe("週末要排隊");

    // 不能用別人的地點庫項目
    expect(
      (await t.request("POST", base, { token: friend.token, body: { savedPlaceId: ichiran.id } }))
        .status,
    ).toBe(404);
    // googlePlaceId 與 savedPlaceId 必須擇一
    expect((await t.request("POST", base, { token: owner.token, body: {} })).status).toBe(422);
  });
});
