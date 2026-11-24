/** 我的地點庫的分類。 */
export const SAVED_PLACE_CATEGORIES = [
  "food",
  "cafe",
  "sight",
  "shopping",
  "stay",
  "other",
] as const;
export type SavedPlaceCategory = (typeof SAVED_PLACE_CATEGORIES)[number];

const CATEGORY_BY_TYPE: ReadonlyArray<[SavedPlaceCategory, readonly string[]]> = [
  ["cafe", ["cafe", "coffee_shop", "tea_house", "bakery", "dessert_shop"]],
  ["food", ["restaurant", "food", "meal_takeaway", "bar", "ramen_restaurant", "sushi_restaurant"]],
  ["stay", ["lodging", "hotel", "hostel", "ryokan", "guest_house"]],
  [
    "shopping",
    ["store", "shopping_mall", "department_store", "market", "clothing_store", "book_store"],
  ],
  [
    "sight",
    [
      "tourist_attraction",
      "museum",
      "park",
      "place_of_worship",
      "shrine",
      "temple",
      "hindu_temple",
      "church",
      "art_gallery",
      "zoo",
      "aquarium",
      "historical_landmark",
      "natural_feature",
    ],
  ],
];

/** 依 Google Places 的 types 推測分類；依 types 的順序，第一個認得的勝出。 */
export function categoryFromPlaceTypes(types: readonly string[]): SavedPlaceCategory {
  for (const type of types) {
    for (const [category, group] of CATEGORY_BY_TYPE) {
      if (group.includes(type)) return category;
    }
  }
  return "other";
}

/** 行程點類型的預設值。 */
export function itemTypeFromPlaceTypes(
  types: readonly string[],
): "sight" | "food" | "stay" | "activity" {
  const c = categoryFromPlaceTypes(types);
  if (c === "food" || c === "cafe") return "food";
  if (c === "stay") return "stay";
  if (c === "shopping") return "activity";
  return "sight";
}

/** 標籤正規化：去空白、去重、限制長度與數量。 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 20);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === 10) break;
  }
  return out;
}
