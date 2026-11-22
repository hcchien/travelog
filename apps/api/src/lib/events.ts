/**
 * 行程事件（ARCHITECTURE §6.3）。來源是 activity_log 的 NOTIFY，
 * 每個 API 執行個體各自 LISTEN，再轉發給訂閱該行程的 SSE 連線。
 */
export interface TripEvent {
  id: string;
  tripId: string;
  action: string;
  actorId: string | null;
  via: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

type Listener = (e: TripEvent) => void;

export class TripEvents {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly global = new Set<Listener>();

  /** 訂閱所有行程的事件（推播通知用）。 */
  subscribeAll(listener: Listener): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }

  subscribe(tripId: string, listener: Listener): () => void {
    let set = this.listeners.get(tripId);
    if (!set) {
      set = new Set();
      this.listeners.set(tripId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(tripId);
    };
  }

  /** 由資料庫 NOTIFY 呼叫。 */
  dispatch(payload: string) {
    let event: TripEvent;
    try {
      event = JSON.parse(payload) as TripEvent;
    } catch {
      return;
    }
    for (const l of [...(this.listeners.get(event.tripId) ?? []), ...this.global]) {
      try {
        l(event);
      } catch (err) {
        console.error("trip event listener failed", err);
      }
    }
  }

  get subscriberCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

export const TRIP_EVENTS_CHANNEL = "trip_events";
