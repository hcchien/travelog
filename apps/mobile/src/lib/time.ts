/** 某個時間點在指定時區的日期（YYYY-MM-DD）與時間（HH:mm）。 */
export function zoned(iso: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof iso === "string" ? new Date(iso) : iso);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

export const formatTime = (iso: string | null, tz: string) => (iso ? zoned(iso, tz).time : "");

const WEEK = "日一二三四五六";
export function formatDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`;
}

export const todayIn = (tz: string) => zoned(new Date(), tz).date;
