import { describe, expect, it } from "vitest";
import { InvalidTransitionError, ItemConfirmedError } from "../src/errors.js";
import {
  assertBookingDetailsMutable,
  assertItemMutable,
  findOverlapsWithConfirmed,
  type ItineraryItemState,
  lockedFieldsChanged,
  planBookingStatusChange,
} from "../src/itinerary-lock.js";

const t = (iso: string) => new Date(iso);

function item(overrides: Partial<ItineraryItemState> = {}): ItineraryItemState {
  return {
    id: "item-1",
    dayId: "day-1",
    startAt: t("2026-12-03T00:50:00Z"),
    endAt: t("2026-12-03T03:25:00Z"),
    tz: "Asia/Tokyo",
    placeId: "place-kix",
    type: "transport",
    sortKey: "a0",
    confirmedAt: null,
    confirmedBy: null,
    confirmSource: null,
    ...overrides,
  };
}

const confirmed = (overrides: Partial<ItineraryItemState> = {}) =>
  item({
    confirmedAt: t("2026-11-20T10:00:00Z"),
    confirmedBy: "user-1",
    confirmSource: "booking",
    ...overrides,
  });

describe("assertItemMutable：未確定的行程點", () => {
  it("任何變更都允許", () => {
    const it0 = item();
    expect(() =>
      assertItemMutable(it0, { kind: "update", patch: { startAt: t("2026-12-03T05:00:00Z") } }),
    ).not.toThrow();
    expect(() => assertItemMutable(it0, { kind: "move" })).not.toThrow();
    expect(() => assertItemMutable(it0, { kind: "delete" })).not.toThrow();
  });
});

describe("assertItemMutable：已確定的行程點", () => {
  it("可以改標題與備註", () => {
    expect(() =>
      assertItemMutable(confirmed(), {
        kind: "update",
        patch: { title: "新標題", notes: "記得帶護照" },
      }),
    ).not.toThrow();
  });

  it("鎖定欄位送出相同的值不算修改（例如表單整筆送回）", () => {
    const c = confirmed();
    expect(() =>
      assertItemMutable(c, {
        kind: "update",
        patch: { startAt: new Date(c.startAt?.getTime() ?? 0), tz: "Asia/Tokyo", title: "x" },
      }),
    ).not.toThrow();
  });

  it.each([
    ["startAt", { startAt: t("2026-12-03T02:00:00Z") }],
    ["endAt", { endAt: null }],
    ["dayId", { dayId: "day-2" }],
    ["tz", { tz: "Asia/Taipei" }],
    ["placeId", { placeId: "place-other" }],
    ["type", { type: "sight" as const }],
    ["sortKey", { sortKey: "b0" }],
  ])("修改 %s 會被拒絕（423）", (field, patch) => {
    try {
      assertItemMutable(confirmed(), { kind: "update", patch });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ItemConfirmedError);
      const err = e as ItemConfirmedError;
      expect(err.status).toBe(423);
      expect(err.problemType).toBe("/problems/item-confirmed");
      expect(err.lockedFields).toEqual([field]);
      expect(err.confirmedBy).toBe("user-1");
    }
  });

  it("一次改多個鎖定欄位時全部列出", () => {
    const c = confirmed();
    expect(lockedFieldsChanged(c, { dayId: "day-9", sortKey: "z", title: "ok" })).toEqual([
      "dayId",
      "sortKey",
    ]);
  });

  it("移動與刪除都會被拒絕", () => {
    expect(() => assertItemMutable(confirmed(), { kind: "move" })).toThrow(ItemConfirmedError);
    expect(() => assertItemMutable(confirmed(), { kind: "delete" })).toThrow(ItemConfirmedError);
  });

  it("手動確定的行程點規則相同", () => {
    expect(() =>
      assertItemMutable(confirmed({ confirmSource: "manual" }), { kind: "move" }),
    ).toThrow(ItemConfirmedError);
  });
});

describe("assertBookingDetailsMutable", () => {
  const details = { departAt: "2026-12-03T00:50:00Z", arriveTz: "Asia/Tokyo", seat: "32A" };

  it("已確定時不能改出發／抵達資訊", () => {
    expect(() =>
      assertBookingDetailsMutable(confirmed(), details, { departAt: "2026-12-03T01:50:00Z" }),
    ).toThrow(ItemConfirmedError);
  });

  it("已確定時仍可改座位等其他明細", () => {
    expect(() => assertBookingDetailsMutable(confirmed(), details, { seat: "33B" })).not.toThrow();
  });

  it("未確定時都可以改", () => {
    expect(() =>
      assertBookingDetailsMutable(item(), details, { departAt: "2026-12-03T01:50:00Z" }),
    ).not.toThrow();
  });
});

describe("planBookingStatusChange", () => {
  it("改為已訂位時自動確定", () => {
    expect(planBookingStatusChange(item(), "planned", "booked")).toEqual({
      confirmation: "confirm",
      requiresAction: "item.confirm",
    });
  });

  it("已手動確定的行程點改為已訂位時不重複確定", () => {
    expect(
      planBookingStatusChange(confirmed({ confirmSource: "manual" }), "planned", "booked"),
    ).toEqual({
      confirmation: "none",
      requiresAction: null,
    });
  });

  it("取消因訂位而確定的行程點時解除確定", () => {
    expect(planBookingStatusChange(confirmed(), "booked", "cancelled")).toEqual({
      confirmation: "unconfirm",
      requiresAction: "item.unconfirm",
    });
  });

  it("取消訂位不會解除手動確定", () => {
    expect(
      planBookingStatusChange(confirmed({ confirmSource: "manual" }), "booked", "cancelled"),
    ).toEqual({
      confirmation: "none",
      requiresAction: null,
    });
  });

  it("已確定的訂位不能直接改回規劃中", () => {
    expect(() => planBookingStatusChange(confirmed(), "booked", "planned")).toThrow(
      InvalidTransitionError,
    );
  });

  it("狀態不變時沒有影響", () => {
    expect(planBookingStatusChange(confirmed(), "booked", "booked").confirmation).toBe("none");
  });
});

describe("findOverlapsWithConfirmed", () => {
  const dinner = {
    id: "dinner",
    startAt: t("2026-12-04T09:30:00Z"),
    endAt: t("2026-12-04T11:00:00Z"),
    confirmedAt: t("2026-11-20T00:00:00Z"),
  };
  const unconfirmedSight = { ...dinner, id: "sight", confirmedAt: null };

  it("與已確定行程點重疊時回報", () => {
    const candidate = {
      id: "c",
      startAt: t("2026-12-04T10:00:00Z"),
      endAt: t("2026-12-04T12:00:00Z"),
      confirmedAt: null,
    };
    expect(findOverlapsWithConfirmed(candidate, [dinner, unconfirmedSight])).toEqual(["dinner"]);
  });

  it("首尾相接不算重疊", () => {
    const candidate = {
      id: "c",
      startAt: t("2026-12-04T08:00:00Z"),
      endAt: t("2026-12-04T09:30:00Z"),
      confirmedAt: null,
    };
    expect(findOverlapsWithConfirmed(candidate, [dinner])).toEqual([]);
  });

  it("只有開始時間的行程點落在區間內算重疊", () => {
    const candidate = {
      id: "c",
      startAt: t("2026-12-04T10:00:00Z"),
      endAt: null,
      confirmedAt: null,
    };
    expect(findOverlapsWithConfirmed(candidate, [dinner])).toEqual(["dinner"]);
  });

  it("沒有時間的行程點不檢查", () => {
    const candidate = { id: "c", startAt: null, endAt: null, confirmedAt: null };
    expect(findOverlapsWithConfirmed(candidate, [dinner])).toEqual([]);
  });

  it("不和自己比較", () => {
    expect(findOverlapsWithConfirmed(dinner, [dinner])).toEqual([]);
  });
});
