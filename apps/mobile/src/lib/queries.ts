import { useQuery } from "@tanstack/react-query";
import { api, OfflineError } from "./api";
import { readJson, writeJson } from "./storage";
import type { JournalEntry, Snapshot, Trip } from "./types";

/** 先打 API，成功就更新快取；離線時改讀快取並標示 offline。 */
async function cached<T>(
  key: string,
  load: () => Promise<T>,
): Promise<{ data: T; offline: boolean; at?: string }> {
  try {
    const data = await load();
    await writeJson(key, { data, at: new Date().toISOString() });
    return { data, offline: false };
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    const hit = await readJson<{ data: T; at: string }>(key);
    if (!hit) throw e;
    return { data: hit.data, offline: true, at: hit.at };
  }
}

export const useTrips = () =>
  useQuery({
    queryKey: ["trips"],
    queryFn: () =>
      cached("trips", async () => (await api<{ trips: Trip[] }>("GET", "/v1/trips")).trips),
  });

/** 一次取得行程、日期、成員、行程點與筆記（離線用）。 */
export const useSnapshot = (tripId: string) =>
  useQuery({
    queryKey: ["snapshot", tripId],
    queryFn: () =>
      cached(`snapshot:${tripId}`, () => api<Snapshot>("GET", `/v1/trips/${tripId}/snapshot`)),
  });

export const useJournal = (tripId: string) =>
  useQuery({
    queryKey: ["journal", tripId],
    queryFn: () =>
      cached(
        `journal:${tripId}`,
        async () =>
          (await api<{ entries: JournalEntry[] }>("GET", `/v1/trips/${tripId}/journal`)).entries,
      ),
  });

/** 背景預先下載進行中與即將出發（7 天內）行程的離線資料。 */
export async function prefetchUpcoming(trips: Trip[]) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  for (const t of trips.filter((x) => x.endDate >= today && x.startDate <= soon)) {
    try {
      await writeJson(`snapshot:${t.id}`, {
        data: await api<Snapshot>("GET", `/v1/trips/${t.id}/snapshot`),
        at: new Date().toISOString(),
      });
    } catch {
      // 下次再試
    }
  }
}
