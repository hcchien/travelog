"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { Place, Suggestion } from "@/lib/types";
import { Search } from "./icons";

const newSession = () => crypto.randomUUID();

/**
 * 地點搜尋（Google Places Autocomplete，透過 API 代理）。
 * 同一次搜尋使用同一個 session token，選定後才查詳細資料，降低費用。
 */
export function PlaceSearch({
  onPick,
  placeholder = "搜尋地點",
  near,
}: {
  onPick: (place: Place) => void | Promise<void>;
  placeholder?: string;
  near?: { lat: number; lng: number } | null;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const session = useRef(newSession());
  const listId = useId();

  const nearQuery = useMemo(() => (near ? `&lat=${near.lat}&lng=${near.lng}` : ""), [near]);

  useEffect(() => {
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await api<{ suggestions: Suggestion[] }>(
          "GET",
          `/v1/places/autocomplete?q=${encodeURIComponent(q.trim())}&session=${session.current}${nearQuery}`,
          { signal: ctrl.signal },
        );
        setResults(res.suggestions);
        setActive(-1);
        setError(null);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(errorMessage(e));
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, nearQuery]);

  async function pick(s: Suggestion) {
    setBusy(true);
    try {
      const place = await api<Place>("POST", "/v1/places/resolve", {
        body: { googlePlaceId: s.googlePlaceId, sessionToken: session.current },
      });
      session.current = newSession();
      setQ("");
      setResults([]);
      await onPick(place);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-white px-3">
        <Search className="size-4 text-muted" />
        <input
          type="search"
          aria-label={placeholder}
          aria-describedby={results.length > 0 ? listId : undefined}
          value={q}
          disabled={busy}
          placeholder={placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, results.length - 1));
            else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && results[active]) {
              e.preventDefault();
              void pick(results[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
        />
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {results.length > 0 && (
        <ul
          id={listId}
          aria-label="搜尋結果"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-white shadow-lg"
        >
          {results.map((s, i) => (
            <li key={s.googlePlaceId}>
              <button
                type="button"
                onClick={() => void pick(s)}
                className={`flex w-full flex-col items-start px-3 py-2 text-left hover:bg-canvas ${i === active ? "bg-canvas" : ""}`}
              >
                <span className="text-[15px] font-semibold">{s.mainText}</span>
                <span className="text-xs text-muted">{s.secondaryText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
