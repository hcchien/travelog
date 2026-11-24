import { z } from "zod";

/** YYYY-MM-DD，且必須是存在的日期。 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "不存在的日期");

/** IANA 時區，例如 Asia/Tokyo。 */
export const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "不是有效的 IANA 時區");

/** ISO 8601 時間點（含時區位移），轉成 Date。 */
export const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const uuid = z.uuid();
