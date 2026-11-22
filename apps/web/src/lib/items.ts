import type { BookingKind, BookingStatus, ItemType, SavedCategory } from "./types";

export const ITEM_TYPES: { value: ItemType; label: string; chip: string }[] = [
  { value: "sight", label: "景點", chip: "bg-brand-soft text-brand" },
  { value: "food", label: "餐廳", chip: "bg-[#fdebdd] text-[#8a3a06]" },
  { value: "stay", label: "住宿", chip: "bg-[#efe9f7] text-[#5b3a8c]" },
  { value: "transport", label: "交通", chip: "bg-[#e5efe8] text-[#2f6447]" },
  { value: "activity", label: "活動", chip: "bg-[#e6f0f3] text-[#245a6b]" },
  { value: "note", label: "筆記", chip: "bg-canvas text-ink-soft" },
];
const FALLBACK_TYPE = { value: "note" as ItemType, label: "其他", chip: "bg-canvas text-ink-soft" };
export const itemTypeMeta = (t: ItemType) => ITEM_TYPES.find((x) => x.value === t) ?? FALLBACK_TYPE;

export const BOOKING_KINDS: { value: BookingKind; label: string }[] = [
  { value: "flight", label: "航班" },
  { value: "lodging", label: "住宿" },
  { value: "rail", label: "鐵路" },
  { value: "bus", label: "巴士" },
  { value: "car", label: "租車" },
  { value: "ticket", label: "票券" },
  { value: "restaurant", label: "餐廳" },
  { value: "other", label: "其他" },
];

export const BOOKING_STATUSES: { value: BookingStatus; label: string }[] = [
  { value: "planned", label: "規劃中" },
  { value: "booked", label: "已訂位／已購票" },
  { value: "cancelled", label: "已取消" },
];

/** 釘選標籤：依訂位種類顯示「已購票／已訂房／已訂位」。 */
export function confirmedLabel(kind: BookingKind | undefined, source: "booking" | "manual" | null) {
  if (source === "manual" || !kind) return "已確定";
  if (kind === "lodging") return "已訂房";
  if (kind === "restaurant") return "已訂位";
  return "已購票";
}

export const CATEGORIES: { value: SavedCategory; label: string }[] = [
  { value: "food", label: "餐廳" },
  { value: "cafe", label: "咖啡" },
  { value: "sight", label: "景點" },
  { value: "shopping", label: "購物" },
  { value: "stay", label: "住宿" },
  { value: "other", label: "其他" },
];
export const categoryLabel = (c: SavedCategory) =>
  CATEGORIES.find((x) => x.value === c)?.label ?? c;
