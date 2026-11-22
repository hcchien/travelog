import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { ApiError, api, OfflineError } from "./api";
import { readJson, writeJson } from "./storage";

/**
 * 離線筆記佇列（ARCHITECTURE §6.4）：先存在本機，有網路時依序送出。
 * 每則帶固定的 Idempotency-Key，重送不會重複建立。
 */
export interface PendingNote {
  key: string;
  tripId: string;
  dayId: string | null;
  body: string;
  takenAt: string;
  lat?: number;
  lng?: number;
}

const KEY = "outbox.notes";
type Listener = (pending: PendingNote[]) => void;
const listeners = new Set<Listener>();
let flushing: Promise<void> | null = null;

const load = async () => (await readJson<PendingNote[]>(KEY)) ?? [];
async function save(list: PendingNote[]) {
  await writeJson(KEY, list);
  for (const l of listeners) l(list);
}

export function subscribeOutbox(l: Listener) {
  listeners.add(l);
  void load().then(l);
  return () => {
    listeners.delete(l);
  };
}

export async function queueNote(note: Omit<PendingNote, "key" | "takenAt">) {
  const list = await load();
  list.push({ ...note, key: Crypto.randomUUID(), takenAt: new Date().toISOString() });
  await save(list);
  void flushOutbox();
}

/** 依序送出；遇到離線就停，下次有網路再試。被伺服器拒絕（4xx）的丟棄，避免卡住整個佇列。 */
export function flushOutbox(onSent?: (tripId: string) => void): Promise<void> {
  flushing ??= (async () => {
    let list = await load();
    while (list.length > 0) {
      const n = list[0] as PendingNote;
      try {
        await api("POST", `/v1/trips/${n.tripId}/notes`, {
          headers: { "Idempotency-Key": n.key },
          body: {
            body: n.body,
            takenAt: n.takenAt,
            ...(n.dayId ? { dayId: n.dayId } : {}),
            ...(n.lat !== undefined && n.lng !== undefined ? { lat: n.lat, lng: n.lng } : {}),
          },
        });
        onSent?.(n.tripId);
      } catch (e) {
        if (e instanceof OfflineError) break;
        if (e instanceof ApiError && (e.status >= 500 || e.status === 401 || e.status === 429))
          break;
        console.warn("離線筆記被拒絕，已丟棄", e);
      }
      list = (await load()).filter((x) => x.key !== n.key);
      await save(list);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** 網路恢復時自動送出。 */
export function startOutboxSync(onSent: (tripId: string) => void) {
  return NetInfo.addEventListener((s) => {
    if (s.isConnected && s.isInternetReachable !== false) void flushOutbox(onSent);
  });
}
