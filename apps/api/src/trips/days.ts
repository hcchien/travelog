import { MAX_TRIP_DAYS } from "@travelog/schema";
import { ApiError } from "../lib/problem.js";

/** 產生 [start, end] 之間的每個日期（YYYY-MM-DD）。 */
export function datesBetween(start: string, end: string): string[] {
  const count = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRIP_DAYS)
    throw new ApiError(400, "/problems/date-range", `行程必須介於 1 到 ${MAX_TRIP_DAYS} 天`);
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
