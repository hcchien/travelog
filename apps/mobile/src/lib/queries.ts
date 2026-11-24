import { useQuery } from "@tanstack/react-query";
import { ApiError, api, OfflineError } from "./api";
import { useAuth } from "./auth";
import { assertSession, sessionScope } from "./session";
import { readJson, removeKey, writeJson } from "./storage";
import type { JournalEntry, Snapshot, Trip } from "./types";

/** 先打 API，成功就更新快取；離線時改讀快取並標示 offline。 */
async function cached<T>(
  key: string,
  load: () => Promise<T>,
): Promise<{ data: T; offline: boolean; at?: string }> {
  const scope = sessionScope();
  try {
    const data = await load();
    assertSession(scope);
    await writeJson(key, { data, at: new Date().toISOString() }, scope);
    return { data, offline: false };
  } catch (e) {
    assertSession(scope);
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) await removeKey(key, scope);
    if (!(e instanceof OfflineError)) throw e;
    const hit = await readJson<{ data: T; at: string }>(key, scope);
    if (!hit) throw e;
    return { data: hit.data, offline: true, at: hit.at };
  }
}

export const useTrips = () => {
  const { me } = useAuth();
  return useQuery({
    queryKey: ["trips", me?.id],
    enabled: !!me,
    queryFn: () =>
      cached("trips", async () => (await api<{ trips: Trip[] }>("GET", "/v1/trips")).trips),
  });
};

/** 一次取得行程、日期、成員、行程點與筆記（離線用）。 */
export const useSnapshot = (tripId: string) => {
  const { me } = useAuth();
  return useQuery({
    queryKey: ["snapshot", tripId, me?.id],
    enabled: !!me,
    queryFn: () =>
      cached(`snapshot:${tripId}`, () => api<Snapshot>("GET", `/v1/trips/${tripId}/snapshot`)),
  });
};

export const useJournal = (tripId: string) => {
  const { me } = useAuth();
  return useQuery({
    queryKey: ["journal", tripId, me?.id],
    enabled: !!me,
    queryFn: () =>
      cached(
        `journal:${tripId}`,
        async () =>
          (await api<{ entries: JournalEntry[] }>("GET", `/v1/trips/${tripId}/journal`)).entries,
      ),
  });
};

/** 背景預先下載進行中與即將出發（7 天內）行程的離線資料。 */
export async function prefetchUpcoming(trips: Trip[]) {
  const scope = sessionScope();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  for (const t of trips.filter((x) => x.endDate >= today && x.startDate <= soon)) {
    try {
      assertSession(scope);
      const data = await api<Snapshot>("GET", `/v1/trips/${t.id}/snapshot`);
      assertSession(scope);
      await writeJson(`snapshot:${t.id}`, { data, at: new Date().toISOString() }, scope);
    } catch {
      // 下次再試
    }
  }
}
