import {
  appendDoc,
  dateInTimeZone,
  ITEM_TYPES,
  type JournalDoc,
  type OAuthScope,
  SAVED_PLACE_CATEGORIES,
  textToDoc,
  zonedDateTimeToInstant,
} from "@travelog/domain";
import { z } from "zod";
import { type ToolContext, ToolInputError } from "./context.js";
import { dayLabel, formatItem, resolveDay, TYPE_LABEL } from "./format.js";

type JournalEntry = {
  id: string;
  scope: "trip" | "day" | "item";
  dayId: string | null;
  title: string | null;
  body: JournalDoc;
  bodyText: string;
  visibility: "members" | "public";
  version: number;
  author: { userId: string; displayName: string | null };
};

import type { Item, Place, Trip, TripDetail } from "./types.js";

export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: OAuthScope;
  readOnly: boolean;
  input: z.ZodRawShape;
  // biome-ignore lint/suspicious/noExplicitAny: 各工具的參數型別不同，由 zod 驗證
  run(ctx: ToolContext, args: any): Promise<ToolResult>;
}

const define = <S extends z.ZodRawShape>(
  def: Omit<ToolDef, "input" | "run"> & {
    input: S;
    run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
  },
): ToolDef => def as ToolDef;

// ---- 共用參數
const tripId = z.string().uuid().describe("行程 ID（用 list_trips 取得）");
const day = z.number().int().min(1).optional().describe("第幾天（從 1 開始）。與 date 擇一");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("日期 YYYY-MM-DD。與 day 擇一");
const time = (what: string) =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .describe(`${what}（HH:MM，當地時間）`);
const itemType = z
  .enum(ITEM_TYPES)
  .describe(`類型：${ITEM_TYPES.map((t) => `${t}=${TYPE_LABEL[t]}`).join("、")}`);

const getTrip = (ctx: ToolContext, id: string) => ctx.call<TripDetail>("GET", `/v1/trips/${id}`);
const dayItems = async (ctx: ToolContext, trip: string, dayId: string) =>
  (await ctx.call<{ items: Item[] }>("GET", `/v1/trips/${trip}/items?dayId=${dayId}`)).items;

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** 依日期與當地時間算出開始／結束時間；結束早於開始時視為隔天。 */
function instants(dateStr: string, tz: string, start?: string, end?: string) {
  const startAt = start ? zonedDateTimeToInstant(dateStr, start, tz) : null;
  let endAt = end ? zonedDateTimeToInstant(dateStr, end, tz) : null;
  if (startAt && endAt && endAt < startAt)
    endAt = zonedDateTimeToInstant(addDays(dateStr, 1), end as string, tz);
  return { startAt: startAt?.toISOString() ?? null, endAt: endAt?.toISOString() ?? null };
}

const warningsText = (trip: TripDetail, items: Item[], warnings: { itemId: string }[]) =>
  warnings.length === 0
    ? ""
    : `\n注意：時間和已確定的行程點重疊：${warnings
        .map((w) => items.find((i) => i.id === w.itemId)?.title ?? w.itemId)
        .join("、")}（${trip.title}）`;

export const TOOLS: ToolDef[] = [
  define({
    name: "list_trips",
    title: "列出行程",
    description: "列出使用者參與的所有行程（ID、名稱、日期、目的地、使用者的角色）。",
    scope: "trips:read",
    readOnly: true,
    input: {},
    async run(ctx) {
      const { trips } = await ctx.call<{ trips: Trip[] }>("GET", "/v1/trips");
      if (trips.length === 0) return { text: "目前沒有任何行程。", data: { trips } };
      const text = trips
        .map(
          (t) =>
            `- ${t.title}｜${t.startDate} 到 ${t.endDate}｜${t.destinations.map((d) => d.name).join("、") || "未設定目的地"}｜角色：${t.myRole}｜id=${t.id}`,
        )
        .join("\n");
      return { text, data: { trips } };
    },
  }),

  define({
    name: "get_trip",
    title: "行程概要",
    description: "取得一趟行程的概要：每一天的日期與行程點數量、目的地、時區、成員。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId },
    async run(ctx, { tripId }) {
      const trip = await getTrip(ctx, tripId);
      const { items } = await ctx.call<{ items: Item[] }>("GET", `/v1/trips/${tripId}/items`);
      const lines = trip.days.map((d, i) => {
        const n = items.filter((it) => it.dayId === d.id).length;
        return `Day ${i + 1}（${d.date}${d.title ? `，${d.title}` : ""}）：${n} 個行程點`;
      });
      const unscheduled = items.filter((it) => !it.dayId).length;
      const text = [
        `${trip.title}｜${trip.startDate} 到 ${trip.endDate}｜時區 ${trip.primaryTz}｜你的角色：${trip.myRole}`,
        `目的地：${trip.destinations.map((d) => d.name).join("、") || "未設定"}`,
        `成員：${trip.members.map((m) => `${m.displayName}（${m.role}）`).join("、")}`,
        ...lines,
        unscheduled ? `未排入：${unscheduled} 個` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data: { trip, itemCount: items.length } };
    },
  }),

  define({
    name: "get_day_plan",
    title: "某天的行程",
    description:
      "取得某一天的行程點（依順序，時間為當地時間）。標示【已確定】的行程點是已訂位或已購票，不能修改或移動，安排時要當成固定時段。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId, day, date },
    async run(ctx, { tripId, day, date }) {
      const trip = await getTrip(ctx, tripId);
      const d = resolveDay(trip, { day, date });
      const items = await dayItems(ctx, tripId, d.id);
      const head = `${trip.title} Day ${d.number}（${d.date}）`;
      const text =
        items.length === 0
          ? `${head}：還沒有安排。`
          : `${head}\n${items.map((it, i) => formatItem(it, i + 1)).join("\n")}`;
      return { text, data: { day: { ...d }, items } };
    },
  }),

  define({
    name: "get_today",
    title: "今天的行程",
    description: "找出正在進行中的行程，列出今天（依行程當地時區）的行程點與下一站。",
    scope: "trips:read",
    readOnly: true,
    input: {},
    async run(ctx) {
      const { trips } = await ctx.call<{ trips: Trip[] }>("GET", "/v1/trips");
      const now = ctx.now();
      const ongoing = trips.filter((t) => {
        const today = dateInTimeZone(now, t.primaryTz);
        return t.startDate <= today && today <= t.endDate;
      });
      if (ongoing.length === 0) return { text: "今天沒有進行中的行程。", data: { trips: [] } };
      const out: string[] = [];
      const data: Record<string, unknown>[] = [];
      for (const t of ongoing) {
        const trip = await getTrip(ctx, t.id);
        const today = dateInTimeZone(now, t.primaryTz);
        const d = resolveDay(trip, { date: today });
        const items = await dayItems(ctx, t.id, d.id);
        const next = items.find((it) => it.startAt && new Date(it.startAt) > now);
        out.push(
          `${trip.title} Day ${d.number}（${d.date}）`,
          ...items.map((it, i) => formatItem(it, i + 1)),
          next ? `下一站：${next.title}` : "今天剩下的行程都已開始或沒有時間。",
        );
        data.push({ tripId: t.id, day: d, items, nextItemId: next?.id ?? null });
      }
      return { text: out.join("\n"), data: { trips: data } };
    },
  }),

  define({
    name: "search_trip",
    title: "搜尋行程內容",
    description: "在一趟行程中搜尋行程點、地點名稱、訂位代號、快速筆記與想去清單。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId, query: z.string().min(1).max(100).describe("關鍵字") },
    async run(ctx, { tripId, query }) {
      const trip = await getTrip(ctx, tripId);
      const r = await ctx.call<{
        items: { id: string; title: string; dayId: string | null; confirmed: boolean }[];
        notes: { id: string; body: string; dayId: string | null }[];
        wishlist: { id: string; note: string | null; place: Place }[];
      }>("GET", `/v1/trips/${tripId}/search?q=${encodeURIComponent(query)}`);
      const lines = [
        ...r.items.map(
          (i) =>
            `行程點：${i.title}（${dayLabel(trip, i.dayId)}）${i.confirmed ? "【已確定】" : ""} id=${i.id}`,
        ),
        ...r.notes.map((n) => `筆記：${n.body}（${dayLabel(trip, n.dayId)}）`),
        ...r.wishlist.map((w) => `想去清單：${w.place.name}${w.note ? `（${w.note}）` : ""}`),
      ];
      return { text: lines.length ? lines.join("\n") : `找不到「${query}」。`, data: r };
    },
  }),

  define({
    name: "get_bookings",
    title: "訂位資訊",
    description: "列出行程中所有帶訂位資料的行程點（航班、住宿、餐廳、票券），含狀態與訂位代號。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId },
    async run(ctx, { tripId }) {
      const trip = await getTrip(ctx, tripId);
      const { items } = await ctx.call<{ items: Item[] }>("GET", `/v1/trips/${tripId}/items`);
      const booked = items.filter((i) => i.booking);
      const text = booked.length
        ? booked.map((i) => `${dayLabel(trip, i.dayId)}｜${formatItem(i)}`).join("\n")
        : "這趟行程還沒有訂位資料。";
      return { text, data: { items: booked } };
    },
  }),

  define({
    name: "search_places",
    title: "搜尋地點",
    description:
      "用 Google 地點搜尋找地點，回傳 googlePlaceId，可用在 add_itinerary_item、add_to_wishlist、save_place。可帶座標讓結果偏向附近。",
    scope: "trips:read",
    readOnly: true,
    input: {
      query: z.string().min(1).max(100).describe("地點名稱或關鍵字，例如「京都 湯豆腐」"),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    },
    async run(ctx, { query, lat, lng }) {
      const session = crypto.randomUUID();
      const near = lat !== undefined && lng !== undefined ? `&lat=${lat}&lng=${lng}` : "";
      const { suggestions } = await ctx.call<{
        suggestions: { googlePlaceId: string; mainText: string; secondaryText: string }[];
      }>("GET", `/v1/places/autocomplete?q=${encodeURIComponent(query)}&session=${session}${near}`);
      const text = suggestions.length
        ? suggestions
            .map((s) => `- ${s.mainText}（${s.secondaryText}）googlePlaceId=${s.googlePlaceId}`)
            .join("\n")
        : `找不到「${query}」。`;
      return { text, data: { suggestions } };
    },
  }),

  define({
    name: "add_itinerary_item",
    title: "新增行程點",
    description:
      "在某一天新增行程點（加在當天最後）。時間為地點所在地的當地時間；結束時間早於開始時間會視為隔天。不能用這個工具建立已訂位的行程點。",
    scope: "trips:write",
    readOnly: false,
    input: {
      tripId,
      day,
      date,
      unscheduled: z.boolean().optional().describe("true 表示先放到「未排入」，不指定哪一天"),
      title: z.string().min(1).max(200),
      type: itemType,
      startTime: time("開始時間"),
      endTime: time("結束時間"),
      googlePlaceId: z.string().optional().describe("用 search_places 取得"),
      notes: z.string().max(2000).optional(),
    },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const d = a.unscheduled ? null : resolveDay(trip, { day: a.day, date: a.date });
      let tz = trip.primaryTz;
      if (a.googlePlaceId) {
        const place = await ctx.call<Place>("POST", "/v1/places/resolve", {
          body: { googlePlaceId: a.googlePlaceId },
        });
        tz = place.tz ?? tz;
      }
      if (!d && (a.startTime || a.endTime))
        throw new ToolInputError("未排入的行程點不能設定時間，請指定 day 或 date");
      const t = d ? instants(d.date, tz, a.startTime, a.endTime) : { startAt: null, endAt: null };
      const res = await ctx.call<{ item: Item; warnings: { itemId: string }[] }>(
        "POST",
        `/v1/trips/${a.tripId}/items`,
        {
          body: {
            dayId: d?.id ?? null,
            type: a.type,
            title: a.title,
            notes: a.notes ?? null,
            tz,
            ...t,
            ...(a.googlePlaceId ? { googlePlaceId: a.googlePlaceId } : {}),
          },
        },
      );
      const others = d ? await dayItems(ctx, a.tripId, d.id) : [];
      return {
        text: `已新增到${d ? `Day ${d.number}` : "未排入"}：${formatItem(res.item)}${warningsText(trip, others, res.warnings)}`,
        data: res,
      };
    },
  }),

  define({
    name: "update_itinerary_item",
    title: "修改行程點",
    description:
      "修改行程點的名稱、類型、時間、地點或備註。已確定（已訂位／已購票）的行程點只能改名稱與備註。",
    scope: "trips:write",
    readOnly: false,
    input: {
      tripId,
      itemId: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      type: itemType.optional(),
      startTime: time("開始時間"),
      endTime: time("結束時間"),
      googlePlaceId: z.string().nullable().optional().describe("新的地點；null 表示移除地點"),
      notes: z.string().max(2000).nullable().optional(),
    },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const item = await ctx.call<Item>("GET", `/v1/trips/${a.tripId}/items/${a.itemId}`);
      const patch: Record<string, unknown> = {};
      if (a.title !== undefined) patch.title = a.title;
      if (a.type !== undefined) patch.type = a.type;
      if (a.notes !== undefined) patch.notes = a.notes;
      if (a.googlePlaceId !== undefined) patch.googlePlaceId = a.googlePlaceId;
      if (a.startTime !== undefined || a.endTime !== undefined) {
        const d = trip.days.find((x) => x.id === item.dayId);
        if (!d)
          throw new ToolInputError(
            "這個行程點還沒排到某一天，請先用 move_itinerary_item 排入再設定時間",
          );
        const keep = (iso: string | null) =>
          iso
            ? new Intl.DateTimeFormat("en-GB", {
                timeZone: item.tz,
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              }).format(new Date(iso))
            : undefined;
        Object.assign(
          patch,
          instants(
            d.date,
            item.tz,
            a.startTime ?? keep(item.startAt),
            a.endTime ?? keep(item.endAt),
          ),
        );
      }
      if (Object.keys(patch).length === 0) throw new ToolInputError("沒有要修改的欄位");
      const res = await ctx.call<{ item: Item; warnings: { itemId: string }[] }>(
        "PATCH",
        `/v1/trips/${a.tripId}/items/${a.itemId}`,
        { body: patch, ifMatch: item.version },
      );
      const others = res.item.dayId ? await dayItems(ctx, a.tripId, res.item.dayId) : [];
      return {
        text: `已修改：${formatItem(res.item)}${warningsText(trip, others, res.warnings)}`,
        data: res,
      };
    },
  }),

  define({
    name: "move_itinerary_item",
    title: "移動行程點",
    description: "把行程點移到另一天或調整順序。已確定（已訂位／已購票）的行程點不能移動。",
    scope: "trips:write",
    readOnly: false,
    input: {
      tripId,
      itemId: z.string().uuid(),
      day,
      date,
      unscheduled: z.boolean().optional().describe("true 表示移到「未排入」"),
      position: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("在當天的第幾個（從 1 開始）；省略時放到最後"),
    },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const d = a.unscheduled ? null : resolveDay(trip, { day: a.day, date: a.date });
      const res = await ctx.call<{ item: Item; warnings: { itemId: string }[] }>(
        "POST",
        `/v1/trips/${a.tripId}/items/${a.itemId}/move`,
        { body: { dayId: d?.id ?? null, index: a.position ? a.position - 1 : 10_000 } },
      );
      return {
        text: `已移到${d ? `Day ${d.number}（${d.date}）` : "未排入"}：${res.item.title}`,
        data: res,
      };
    },
  }),

  define({
    name: "add_to_wishlist",
    title: "加入想去清單",
    description: "把地點加入行程的想去清單（旅伴可以投票，之後再排進某一天）。",
    scope: "trips:write",
    readOnly: false,
    input: {
      tripId,
      googlePlaceId: z.string().describe("用 search_places 取得"),
      note: z.string().max(1000).optional(),
    },
    async run(ctx, a) {
      const res = await ctx.call<{ id: string; place: Place }>(
        "POST",
        `/v1/trips/${a.tripId}/wishlist`,
        {
          body: { googlePlaceId: a.googlePlaceId, note: a.note ?? null },
        },
      );
      return {
        text: `已加入想去清單：${res.place.name}`,
        data: res as unknown as Record<string, unknown>,
      };
    },
  }),

  define({
    name: "list_saved_places",
    title: "我的地點庫",
    description:
      "查詢使用者收藏的常去地點（依城市分類，例如東京常去的餐廳）。可依城市 key（例如 jp-tokyo）、分類，或行程（只列出該行程目的地的地點）篩選。",
    scope: "trips:read",
    readOnly: true,
    input: {
      city: z.string().optional().describe("城市 key，例如 jp-tokyo、jp-kyoto、tw-taipei"),
      category: z.enum(SAVED_PLACE_CATEGORIES).optional(),
      tripId: tripId.optional(),
    },
    async run(ctx, a) {
      const qs = new URLSearchParams();
      if (a.city) qs.set("city", a.city);
      if (a.category) qs.set("category", a.category);
      if (a.tripId) qs.set("tripId", a.tripId);
      const { items } = await ctx.call<{
        items: {
          cityName: string;
          category: string;
          tags: string[];
          privateNote: string | null;
          place: Place;
        }[];
      }>("GET", `/v1/me/saved-places?${qs}`);
      const text = items.length
        ? items
            .map(
              (s) =>
                `- ${s.place.name}（${s.cityName}，${s.category}${s.tags.length ? `，${s.tags.join("、")}` : ""}）${s.privateNote ? `備註：${s.privateNote}` : ""} googlePlaceId=${s.place.googlePlaceId}`,
            )
            .join("\n")
        : "地點庫裡沒有符合的地點。";
      return { text, data: { items } };
    },
  }),

  define({
    name: "save_place",
    title: "收藏地點",
    description: "把地點收藏到使用者的地點庫（跨行程保存，會自動依城市分類）。",
    scope: "trips:write",
    readOnly: false,
    input: {
      googlePlaceId: z.string(),
      category: z.enum(SAVED_PLACE_CATEGORIES).optional(),
      tags: z.array(z.string().max(20)).max(10).optional(),
      note: z.string().max(2000).optional().describe("只有使用者自己看得到的備註"),
    },
    async run(ctx, a) {
      const res = await ctx.call<{ cityName: string; place: Place }>(
        "POST",
        "/v1/me/saved-places",
        {
          body: {
            googlePlaceId: a.googlePlaceId,
            category: a.category,
            tags: a.tags ?? [],
            privateNote: a.note ?? null,
          },
        },
      );
      return {
        text: `已收藏到「${res.cityName}」：${res.place.name}`,
        data: res as unknown as Record<string, unknown>,
      };
    },
  }),

  define({
    name: "get_notes",
    title: "讀取快速筆記",
    description: "讀取行程中的快速筆記（旅途中隨手記下的），可指定某一天。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId, day, date },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const d =
        a.day !== undefined || a.date ? resolveDay(trip, { day: a.day, date: a.date }) : null;
      const { notes } = await ctx.call<{
        notes: {
          body: string;
          takenAt: string;
          dayId: string | null;
          author: { displayName: string | null };
        }[];
      }>("GET", `/v1/trips/${a.tripId}/notes${d ? `?dayId=${d.id}` : ""}`);
      const text = notes.length
        ? notes
            .map(
              (n) =>
                `- ${dayLabel(trip, n.dayId)} ${new Intl.DateTimeFormat("en-GB", { timeZone: trip.primaryTz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(n.takenAt))} ${n.author.displayName ?? ""}：${n.body}`,
            )
            .join("\n")
        : "沒有筆記。";
      return { text, data: { notes } };
    },
  }),

  define({
    name: "add_note",
    title: "新增快速筆記",
    description: "在行程中新增一則快速筆記（會依現在的時間歸到行程的某一天）。",
    scope: "journal:write",
    readOnly: false,
    input: { tripId, body: z.string().min(1).max(2000) },
    async run(ctx, a) {
      const res = await ctx.call<{ id: string; body: string }>(
        "POST",
        `/v1/trips/${a.tripId}/notes`,
        { body: { body: a.body } },
      );
      return { text: `已新增筆記：${res.body}`, data: res };
    },
  }),

  define({
    name: "get_journal",
    title: "讀取心得",
    description: "讀取行程的心得（旅伴寫的遊記文字）。可指定某一天；不指定時回傳整趟與每天的心得。",
    scope: "trips:read",
    readOnly: true,
    input: { tripId, day, date },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const d =
        a.day !== undefined || a.date ? resolveDay(trip, { day: a.day, date: a.date }) : null;
      const { entries } = await ctx.call<{ entries: JournalEntry[] }>(
        "GET",
        `/v1/trips/${a.tripId}/journal`,
      );
      const picked = d ? entries.filter((e) => e.dayId === d.id) : entries;
      const text = picked.length
        ? picked
            .map(
              (e) =>
                `## ${e.scope === "trip" ? "整趟" : e.dayId ? dayLabel(trip, e.dayId) : "行程點"}・${e.author.displayName ?? ""}${e.title ? `「${e.title}」` : ""}${e.visibility === "public" ? "（公開）" : ""}\n${e.bodyText}`,
            )
            .join("\n\n")
        : "還沒有心得。";
      return { text, data: { entries: picked } };
    },
  }),

  define({
    name: "write_journal",
    title: "寫心得",
    description:
      "以使用者的身分寫心得（純文字，每一行一段）。指定 day／date 寫某一天，都不指定則寫整趟的心得。" +
      "使用者在該範圍已有心得時，預設接在最後（mode=append）；mode=replace 會整篇取代，請先確認使用者同意。不會改變公開設定。",
    scope: "journal:write",
    readOnly: false,
    input: {
      tripId,
      day,
      date,
      text: z.string().min(1).max(20_000),
      title: z.string().max(200).optional(),
      mode: z.enum(["append", "replace"]).default("append"),
    },
    async run(ctx, a) {
      const trip = await getTrip(ctx, a.tripId);
      const d =
        a.day !== undefined || a.date ? resolveDay(trip, { day: a.day, date: a.date }) : null;
      const [me, { entries }] = await Promise.all([
        ctx.call<{ id: string }>("GET", "/v1/me"),
        ctx.call<{ entries: JournalEntry[] }>("GET", `/v1/trips/${a.tripId}/journal`),
      ]);
      const mine = entries.find(
        (e) =>
          e.author.userId === me.id &&
          (d ? e.scope === "day" && e.dayId === d.id : e.scope === "trip"),
      );
      const where = d ? dayLabel(trip, d.id) : "整趟";
      if (!mine) {
        const res = await ctx.call<JournalEntry>("POST", `/v1/trips/${a.tripId}/journal`, {
          body: {
            target: d ? { scope: "day", dayId: d.id } : { scope: "trip" },
            bodyText: a.text,
            ...(a.title ? { title: a.title } : {}),
          },
        });
        return { text: `已新增${where}的心得。`, data: res };
      }
      const body =
        a.mode === "replace" ? textToDoc(a.text) : appendDoc(mine.body, textToDoc(a.text));
      const res = await ctx.call<JournalEntry>(
        "PATCH",
        `/v1/trips/${a.tripId}/journal/${mine.id}`,
        {
          body: { version: mine.version, body, ...(a.title ? { title: a.title } : {}) },
        },
      );
      return {
        text: a.mode === "replace" ? `已取代${where}的心得。` : `已接在${where}心得的最後。`,
        data: res,
      };
    },
  }),
];

export const toolsForScopes = (scopes: readonly OAuthScope[]) =>
  TOOLS.filter((t) => scopes.includes(t.scope));
