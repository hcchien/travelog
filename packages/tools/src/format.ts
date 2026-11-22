import { timeInTimeZone } from "@travelog/domain";
import { ToolInputError } from "./context.js";
import type { Item, TripDetail } from "./types.js";

export const TYPE_LABEL: Record<string, string> = {
  sight: "景點",
  food: "餐廳",
  stay: "住宿",
  transport: "交通",
  activity: "活動",
  note: "筆記",
};

export function formatItem(it: Item, n?: number): string {
  const start = it.startAt ? timeInTimeZone(new Date(it.startAt), it.tz) : "";
  const end = it.endAt ? timeInTimeZone(new Date(it.endAt), it.tz) : "";
  const time = start ? `${start}${end ? `–${end}` : ""} ` : "";
  const parts = [
    `${n !== undefined ? `${n}. ` : ""}${time}${it.title}［${TYPE_LABEL[it.type] ?? it.type}］`,
    it.place && it.place.name !== it.title ? `地點：${it.place.name}` : null,
    it.confirmed ? "【已確定：不能修改時間、地點、順序】" : null,
    it.booking
      ? `訂位：${it.booking.status}${it.booking.confirmationCode ? ` ${it.booking.confirmationCode}` : ""}`
      : null,
    it.notes ? `備註：${it.notes}` : null,
    `id=${it.id}`,
  ];
  return parts.filter(Boolean).join("｜");
}

/** 依「第幾天」或「日期」找出行程中的某一天。 */
export function resolveDay(
  trip: TripDetail,
  sel: { day?: number | undefined; date?: string | undefined },
) {
  if (sel.date) {
    const d = trip.days.find((x) => x.date === sel.date);
    if (!d)
      throw new ToolInputError(
        `${sel.date} 不在行程日期內（${trip.startDate} 到 ${trip.endDate}）`,
      );
    return { ...d, number: trip.days.indexOf(d) + 1 };
  }
  if (sel.day !== undefined) {
    const d = trip.days[sel.day - 1];
    if (!d) throw new ToolInputError(`這趟行程只有 ${trip.days.length} 天`);
    return { ...d, number: sel.day };
  }
  throw new ToolInputError("請指定 day（第幾天，從 1 開始）或 date（YYYY-MM-DD）");
}

export const dayLabel = (trip: TripDetail, dayId: string | null) => {
  if (!dayId) return "未排入";
  const i = trip.days.findIndex((d) => d.id === dayId);
  return i < 0 ? "未知" : `Day ${i + 1}（${trip.days[i]?.date}）`;
};
