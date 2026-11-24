import { describe, expect, it } from "vitest";
import { categoryFromPlaceTypes, itemTypeFromPlaceTypes, normalizeTags } from "../src/places.js";

describe("categoryFromPlaceTypes", () => {
  it.each([
    [["cafe", "food", "point_of_interest"], "cafe"],
    [["ramen_restaurant", "restaurant", "food"], "food"],
    [["lodging", "point_of_interest"], "stay"],
    [["department_store", "store"], "shopping"],
    [["place_of_worship", "tourist_attraction"], "sight"],
    [["point_of_interest", "establishment"], "other"],
  ])("%j → %s", (types, expected) => {
    expect(categoryFromPlaceTypes(types)).toBe(expected);
  });
});

describe("itemTypeFromPlaceTypes", () => {
  it("咖啡廳與餐廳都是餐飲；購物歸為活動；其他為景點", () => {
    expect(itemTypeFromPlaceTypes(["cafe"])).toBe("food");
    expect(itemTypeFromPlaceTypes(["hotel"])).toBe("stay");
    expect(itemTypeFromPlaceTypes(["store"])).toBe("activity");
    expect(itemTypeFromPlaceTypes(["establishment"])).toBe("sight");
  });
});

describe("normalizeTags", () => {
  it("去空白、去重、限制數量", () => {
    expect(normalizeTags([" 必去 ", "必去", "", "雨天  備案"])).toEqual(["必去", "雨天 備案"]);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});
