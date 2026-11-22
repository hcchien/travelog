/**
 * 離線快照（ARCHITECTURE §6.4）：行中模式需要的資料存在 localStorage，
 * 沒有網路時「今日」頁面仍能顯示行程、住宿、訂位代號與筆記。
 */
import { api } from "./api";
import type { Snapshot, Trip } from "./types";

const key = (tripId: string) => `travelog:snapshot:${tripId}`;

export function saveSnapshot(s: Snapshot) {
  try {
    localStorage.setItem(key(s.trip.id), JSON.stringify(s));
  } catch {
    // 空間不足或無痕模式：離線功能失效，但不影響線上使用
  }
}

export function loadSnapshot(tripId: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(key(tripId));
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

export async function refreshSnapshot(tripId: string): Promise<Snapshot> {
  const s = await api<Snapshot>("GET", `/v1/trips/${tripId}/snapshot`);
  saveSnapshot(s);
  return s;
}

/** 進行中或 2 天內出發的行程，自動在背景下載離線資料。 */
export function prefetchUpcomingSnapshots(trips: Trip[], today: string) {
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 2);
  const limit = soon.toISOString().slice(0, 10);
  for (const t of trips) {
    if (t.startDate <= limit && t.endDate >= today) void refreshSnapshot(t.id).catch(() => {});
  }
}
