import { z } from "zod";
import { isoDate, timeZone } from "./common.js";

export const MAX_TRIP_DAYS = 60;

export const tripDestination = z.object({
  cityKey: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
});

const tripFields = {
  title: z.string().trim().min(1).max(120),
  startDate: isoDate,
  endDate: isoDate,
  primaryTz: timeZone,
  destinations: z.array(tripDestination).max(20),
  cover: z.string().max(80).nullable(),
};

function dayCount(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
}

const validRange = (v: { startDate?: string | undefined; endDate?: string | undefined }) =>
  v.startDate === undefined ||
  v.endDate === undefined ||
  (v.endDate >= v.startDate && dayCount(v.startDate, v.endDate) <= MAX_TRIP_DAYS);

const rangeMessage = {
  message: `結束日期必須在開始日期之後，且最多 ${MAX_TRIP_DAYS} 天`,
  path: ["endDate"],
};

export const createTripInput = z
  .object({
    ...tripFields,
    destinations: tripFields.destinations.default([]),
    cover: tripFields.cover.default(null),
  })
  .refine(validRange, rangeMessage);
export type CreateTripInput = z.infer<typeof createTripInput>;

export const updateTripInput = z
  .object({
    ...tripFields,
    /** 檢視者能否寫自己的心得（只有擁有者能改）。 */
    viewerCanWriteJournal: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "至少要修改一個欄位")
  .refine(validRange, rangeMessage);
export type UpdateTripInput = z.infer<typeof updateTripInput>;
