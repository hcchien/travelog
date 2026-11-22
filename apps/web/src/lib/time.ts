/**
 * 時區工具：行程點的時間以「事件所在地時區」顯示與輸入（ARCHITECTURE §5.3）。
 */

function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** 某個時間點在 tz 的 UTC 位移（毫秒）。 */
function offsetMs(date: Date, tz: string) {
  const p = parts(date, tz);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(date.getTime() / 1000) * 1000
  );
}

/** "2026-12-03" + "08:50" 在 Asia/Tokyo → ISO 字串（含 Z）。 */
export function zonedToIso(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - offsetMs(new Date(wall), tz);
  guess = wall - offsetMs(new Date(guess), tz); // 處理日光節約時間交界
  return new Date(guess).toISOString();
}

/** ISO → 在 tz 的 { date: "YYYY-MM-DD", time: "HH:MM" }。 */
export function isoToZoned(iso: string, tz: string) {
  const p = parts(new Date(iso), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

export const formatTime = (iso: string | null, tz: string) => (iso ? isoToZoned(iso, tz).time : "");

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function formatDay(date: string, style: "short" | "long" = "short") {
  const d = new Date(`${date}T00:00:00Z`);
  const w = WEEKDAYS[d.getUTCDay()];
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return style === "short" ? `${m}/${day}（${w}）` : `${m} 月 ${day} 日（${w}）`;
}

export function formatRange(start: string, end: string) {
  return `${start.replaceAll("-", "/")} – ${end.slice(5).replace("-", "/")}`;
}

export function daysBetween(start: string, end: string) {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** 今天（使用者所在地）的 YYYY-MM-DD。 */
export function today() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 時差說明，例如「比台灣快 1 小時」。 */
export function offsetFromTaipei(tz: string) {
  const now = new Date();
  const diff = Math.round((offsetMs(now, tz) - offsetMs(now, "Asia/Taipei")) / 3_600_000);
  if (diff === 0) return "與台灣相同";
  return diff > 0 ? `比台灣快 ${diff} 小時` : `比台灣慢 ${-diff} 小時`;
}

export const COMMON_TIME_ZONES = [
  ["Asia/Taipei", "台灣"],
  ["Asia/Tokyo", "日本"],
  ["Asia/Seoul", "韓國"],
  ["Asia/Hong_Kong", "香港"],
  ["Asia/Shanghai", "中國"],
  ["Asia/Bangkok", "泰國"],
  ["Asia/Singapore", "新加坡"],
  ["Europe/London", "英國"],
  ["Europe/Paris", "法國／中歐"],
  ["America/New_York", "美東"],
  ["America/Los_Angeles", "美西"],
  ["Australia/Sydney", "雪梨"],
] as const;
