import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { ApiError, api, OfflineError } from "./api";
import { assertSession, sameSession, sessionScope } from "./session";
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

const load = async (scope = sessionScope()) => (await readJson<PendingNote[]>(KEY, scope)) ?? [];
async function save(list: PendingNote[], scope = sessionScope()) {
  assertSession(scope);
  await writeJson(KEY, list, scope);
  assertSession(scope);
  for (const l of listeners) l(list);
}

export function subscribeOutbox(l: Listener) {
  listeners.add(l);
  const scope = sessionScope();
  void load(scope).then((list) => {
    if (sameSession(scope)) l(list);
  });
  return () => {
    listeners.delete(l);
  };
}

export async function queueNote(note: Omit<PendingNote, "key" | "takenAt">) {
  const scope = sessionScope();
  if (!scope.userId) throw new Error("需要登入");
  const list = await load(scope);
  assertSession(scope);
  list.push({ ...note, key: Crypto.randomUUID(), takenAt: new Date().toISOString() });
  await save(list, scope);
  void flushOutbox();
}

/** 依序送出；遇到離線就停，下次有網路再試。被伺服器拒絕（4xx）的丟棄，避免卡住整個佇列。 */
export function flushOutbox(onSent?: (tripId: string) => void): Promise<void> {
  const scope = sessionScope();
  if (!scope.userId) return Promise.resolve();
  flushing ??= (async () => {
    let list = await load(scope);
    while (list.length > 0 && sameSession(scope)) {
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
        if (!sameSession(scope)) return;
        onSent?.(n.tripId);
      } catch (e) {
        if (!sameSession(scope)) return;
        if (e instanceof OfflineError) break;
        if (e instanceof ApiError && (e.status >= 500 || e.status === 401 || e.status === 429))
          break;
        console.warn("離線筆記被拒絕，已丟棄", e);
      }
      list = (await load(scope)).filter((x) => x.key !== n.key);
      await save(list, scope);
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
