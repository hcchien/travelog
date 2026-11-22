"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ORIGIN, refreshAccessToken } from "./api";
import { keys } from "./queries";

let currentToken: () => string | null = () => null;
/** api.ts 設定 access token 時一併提供給即時連線使用。 */
export const bindTokenGetter = (fn: () => string | null) => {
  currentToken = fn;
};

/**
 * 訂閱行程的即時事件（SSE）。收到事件就讓相關查詢重抓。
 * 用 fetch 串流讀取，才能帶 Authorization 標頭；斷線後以退避方式重連。
 */
export function useTripEvents(tripId: string) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;
    let retry = 0;

    async function connect() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          let token = currentToken() ?? (await refreshAccessToken());
          let res = await fetch(`${API_ORIGIN}/v1/trips/${tripId}/events`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: ctrl.signal,
          });
          if (res.status === 401) {
            token = await refreshAccessToken();
            res = await fetch(`${API_ORIGIN}/v1/trips/${tripId}/events`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: ctrl.signal,
            });
          }
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          setConnected(true);
          retry = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";
            for (const e of events) {
              if (!e.includes("event: trip")) continue;
              void qc.invalidateQueries({ queryKey: keys.items(tripId) });
              void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
              void qc.invalidateQueries({ queryKey: keys.wishlist(tripId) });
              void qc.invalidateQueries({ queryKey: ["activity", tripId] });
              void qc.invalidateQueries({ queryKey: ["notes", tripId] });
              void qc.invalidateQueries({ queryKey: ["snapshot", tripId] });
              void qc.invalidateQueries({ queryKey: ["journal", tripId] });
              void qc.invalidateQueries({ queryKey: ["attachments", tripId] });
            }
          }
        } catch {
          // 連線中斷或離線
        }
        setConnected(false);
        if (stopped) return;
        retry = Math.min(retry + 1, 6);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
      }
    }
    void connect();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [tripId, qc]);

  return connected;
}
