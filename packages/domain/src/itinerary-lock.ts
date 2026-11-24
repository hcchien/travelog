import { InvalidTransitionError, ItemConfirmedError } from "./errors.js";

/**
 * 確定（釘選）行程點規則。PRD §3.4.3、ARCHITECTURE §5.5。
 * 所有入口（Web、App、MCP、AI 提案套用）都必須經過 assertItemMutable。
 */

export const ITEM_TYPES = ["sight", "food", "stay", "transport", "activity", "note"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const CONFIRM_SOURCES = ["booking", "manual"] as const;
export type ConfirmSource = (typeof CONFIRM_SOURCES)[number];

export const BOOKING_STATUSES = ["planned", "booked", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** 已確定後不可更改的行程點欄位。 */
export const LOCKED_ITEM_FIELDS = [
  "dayId",
  "startAt",
  "endAt",
  "tz",
  "placeId",
  "type",
  "sortKey",
] as const;
export type LockedItemField = (typeof LOCKED_ITEM_FIELDS)[number];

/** 已確定後不可更改的訂位明細欄位（bookings.details 內）。 */
export const LOCKED_BOOKING_DETAIL_FIELDS = [
  "departAt",
  "departTz",
  "departPlaceId",
  "arriveAt",
  "arriveTz",
  "arrivePlaceId",
] as const;
export type LockedBookingDetailField = (typeof LOCKED_BOOKING_DETAIL_FIELDS)[number];

export interface ItineraryItemState {
  id: string;
  dayId: string | null;
  startAt: Date | null;
  endAt: Date | null;
  tz: string;
  placeId: string | null;
  type: ItemType;
  sortKey: string;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  confirmSource: ConfirmSource | null;
}

export type ItemPatch = Partial<
  Pick<ItineraryItemState, LockedItemField> & {
    title: string;
    notes: string | null;
  }
>;

export type ItemChange =
  | { kind: "update"; patch: ItemPatch }
  | { kind: "move" }
  | { kind: "delete" };

export function isConfirmed(item: Pick<ItineraryItemState, "confirmedAt">): boolean {
  return item.confirmedAt !== null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** 回傳 patch 中「實際會改變值」的鎖定欄位。 */
export function lockedFieldsChanged(item: ItineraryItemState, patch: ItemPatch): LockedItemField[] {
  return LOCKED_ITEM_FIELDS.filter(
    (field) => field in patch && !sameValue(patch[field], item[field]),
  );
}

/**
 * 已確定的行程點：
 * - update 只能改非鎖定欄位（標題、備註等）
 * - move、delete 一律拒絕
 * 未確定的行程點不受限制（權限另由 roles 檢查）。
 */
export function assertItemMutable(item: ItineraryItemState, change: ItemChange): void {
  if (item.confirmedAt === null) return;

  if (change.kind === "update") {
    const touched = lockedFieldsChanged(item, change.patch);
    if (touched.length === 0) return;
    throw new ItemConfirmedError(item.id, item.confirmedAt, item.confirmedBy, touched);
  }
  throw new ItemConfirmedError(item.id, item.confirmedAt, item.confirmedBy);
}

export function assertBookingDetailsMutable(
  item: ItineraryItemState,
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): void {
  if (item.confirmedAt === null) return;
  const touched = LOCKED_BOOKING_DETAIL_FIELDS.filter(
    (field) => field in patch && !sameValue(patch[field], current[field]),
  );
  if (touched.length > 0) {
    throw new ItemConfirmedError(item.id, item.confirmedAt, item.confirmedBy, touched);
  }
}

export type BookingStatusEffect =
  | { confirmation: "confirm"; requiresAction: "item.confirm" }
  | { confirmation: "unconfirm"; requiresAction: "item.unconfirm" }
  | { confirmation: "none"; requiresAction: null };

/**
 * 訂位狀態變更對行程點確定狀態的影響。
 * - → booked：自動確定（若尚未確定）
 * - → cancelled：若因訂位而確定，解除確定
 * - booked → planned：不允許直接改，必須走「解除確定」流程
 */
export function planBookingStatusChange(
  item: ItineraryItemState,
  from: BookingStatus,
  to: BookingStatus,
): BookingStatusEffect {
  if (from === to) return { confirmation: "none", requiresAction: null };

  if (to === "booked") {
    return item.confirmedAt === null
      ? { confirmation: "confirm", requiresAction: "item.confirm" }
      : { confirmation: "none", requiresAction: null };
  }

  if (to === "cancelled") {
    return item.confirmedAt !== null && item.confirmSource === "booking"
      ? { confirmation: "unconfirm", requiresAction: "item.unconfirm" }
      : { confirmation: "none", requiresAction: null };
  }

  // to === "planned"
  if (from === "booked" && item.confirmedAt !== null) {
    throw new InvalidTransitionError("已確定的訂位不能直接改回規劃中，請使用「解除確定」。");
  }
  return { confirmation: "none", requiresAction: null };
}

export interface TimedItem {
  id: string;
  startAt: Date | null;
  endAt: Date | null;
  confirmedAt: Date | null;
}

function overlaps(a: TimedItem, b: TimedItem): boolean {
  if (a.startAt === null || b.startAt === null) return false;
  const aStart = a.startAt.getTime();
  const bStart = b.startAt.getTime();
  const aEnd = (a.endAt ?? a.startAt).getTime();
  const bEnd = (b.endAt ?? b.startAt).getTime();

  const aPoint = aStart === aEnd;
  const bPoint = bStart === bEnd;
  if (aPoint && bPoint) return aStart === bStart;
  if (aPoint) return bStart <= aStart && aStart < bEnd;
  if (bPoint) return aStart <= bStart && bStart < aEnd;
  return aStart < bEnd && bStart < aEnd;
}

/** 候選行程點與已確定行程點的時間重疊（只警告，不阻擋）。 */
export function findOverlapsWithConfirmed(
  candidate: TimedItem,
  others: readonly TimedItem[],
): string[] {
  return others
    .filter((o) => o.id !== candidate.id && o.confirmedAt !== null && overlaps(candidate, o))
    .map((o) => o.id);
}
