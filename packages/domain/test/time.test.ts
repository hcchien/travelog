import { describe, expect, it } from "vitest";
import { dateInTimeZone } from "../src/time.js";

describe("dateInTimeZone", () => {
  it("同一個時間點在不同時區可能是不同日期", () => {
    const at = new Date("2026-12-03T16:30:00Z"); // 台灣 12/4 00:30、東京 12/4 01:30、倫敦 12/3
    expect(dateInTimeZone(at, "Asia/Taipei")).toBe("2026-12-04");
    expect(dateInTimeZone(at, "Asia/Tokyo")).toBe("2026-12-04");
    expect(dateInTimeZone(at, "Europe/London")).toBe("2026-12-03");
  });
});
