import { BOOKING_STATUSES, ITEM_TYPES } from "@travelog/domain";
import { z } from "zod";
import { instant, timeZone, uuid } from "./common.js";

export const bookingKind = z.enum([
  "flight",
  "lodging",
  "rail",
  "bus",
  "car",
  "ticket",
  "restaurant",
  "other",
]);
export const bookingStatus = z.enum(BOOKING_STATUSES);

const details = z.record(z.string(), z.unknown());

export const bookingInput = z.object({
  kind: bookingKind,
  status: bookingStatus.default("planned"),
  confirmationCode: z.string().max(80).nullable().default(null),
  provider: z.string().max(120).nullable().default(null),
  details: details.default({}),
});

const timeOrder = (v: { startAt?: Date | null | undefined; endAt?: Date | null | undefined }) =>
  !v.startAt || !v.endAt || v.endAt >= v.startAt;
const timeOrderMessage = { message: "結束時間不能早於開始時間", path: ["endAt"] };

export const createItemInput = z
  .object({
    dayId: uuid.nullable().default(null),
    type: z.enum(ITEM_TYPES),
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(5000).nullable().default(null),
    startAt: instant.nullable().default(null),
    endAt: instant.nullable().default(null),
    /** 省略時使用行程的主要時區。 */
    tz: timeZone.optional(),
    /** Google 地點；省略時沒有地點。時區省略時以地點所在時區為準。 */
    googlePlaceId: z.string().min(1).max(300).optional(),
    sessionToken: z.string().max(100).optional(),
    details: details.default({}),
    booking: bookingInput.optional(),
  })
  .refine(timeOrder, timeOrderMessage);
export type CreateItemInput = z.infer<typeof createItemInput>;

export const updateItemInput = z
  .object({
    type: z.enum(ITEM_TYPES),
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(5000).nullable(),
    startAt: instant.nullable(),
    endAt: instant.nullable(),
    tz: timeZone,
    /** null 表示移除地點。 */
    googlePlaceId: z.string().min(1).max(300).nullable(),
    details,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "至少要修改一個欄位")
  .refine(timeOrder, timeOrderMessage);
export type UpdateItemInput = z.infer<typeof updateItemInput>;

export const moveItemInput = z.object({
  /** 目標日；null 表示移到「未排入」。 */
  dayId: uuid.nullable(),
  /** 在目標日的位置（0 起算）；超過長度時放到最後。 */
  index: z.number().int().min(0),
});
export type MoveItemInput = z.infer<typeof moveItemInput>;

export const updateBookingInput = z
  .object({
    status: bookingStatus,
    confirmationCode: z.string().max(80).nullable(),
    provider: z.string().max(120).nullable(),
    details,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "至少要修改一個欄位");
export type UpdateBookingInput = z.infer<typeof updateBookingInput>;

export const unconfirmItemInput = z.object({
  reason: z.enum(["reschedule", "cancel", "other"]),
  note: z.string().max(500).optional(),
});
export type UnconfirmItemInput = z.infer<typeof unconfirmItemInput>;
