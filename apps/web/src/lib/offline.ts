import { ApiError, api, OfflineError, sameSession, sessionScope, SessionChangedError } from "./api";
import type { Snapshot, Trip } from "./types";

const key = (tripId: string, userId: string) => `travelog:snapshot:${userId}:${tripId}`;
export function loadSnapshot(tripId: string): Snapshot | null {
  const { userId } = sessionScope();
  if (!userId) return null;
  try { const raw = localStorage.getItem(key(tripId, userId)); return raw ? JSON.parse(raw) as Snapshot : null; }
  catch { return null; }
}
export async function refreshSnapshot(tripId: string): Promise<Snapshot> {
  const scope = sessionScope();
  try {
    const s = await api<Snapshot>("GET", `/v1/trips/${tripId}/snapshot`);
    if (!sameSession(scope)) throw new SessionChangedError();
    if (scope.userId) { try { localStorage.setItem(key(tripId, scope.userId), JSON.stringify(s)); } catch {} }
    return s;
  } catch (e) {
    if (scope.userId && e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      try { localStorage.removeItem(key(tripId, scope.userId)); } catch {}
    }
    throw e;
  }
}
export async function snapshotWithOfflineFallback(tripId: string) {
  try { return { data: await refreshSnapshot(tripId), offline: false }; }
  catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    const cached = loadSnapshot(tripId);
    if (!cached) throw e;
    return { data: cached, offline: true };
  }
}
export function prefetchUpcomingSnapshots(trips: Trip[], today: string) {
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 2);
  const limit = soon.toISOString().slice(0, 10);
  for (const t of trips) if (t.startDate <= limit && t.endDate >= today) void refreshSnapshot(t.id).catch(() => {});
}
