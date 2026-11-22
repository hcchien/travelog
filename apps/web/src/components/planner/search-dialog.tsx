"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Place, TripDetail } from "@/lib/types";
import { Search } from "../icons";
import { Dialog } from "../ui";

interface Results {
  items: { id: string; title: string; dayId: string | null; confirmed: boolean }[];
  notes: { id: string; body: string; dayId: string | null }[];
  wishlist: { id: string; note: string | null; place: Place }[];
}

/** 行程內搜尋：行程點、地點、訂位代號、筆記、想去清單。 */
export function SearchDialog({
  trip,
  open,
  onClose,
  onPickItem,
}: {
  trip: TripDetail;
  open: boolean;
  onClose: () => void;
  onPickItem: (itemId: string, dayId: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [r, setR] = useState<Results | null>(null);
  useEffect(() => {
    if (!q.trim()) {
      setR(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api<Results>("GET", `/v1/trips/${trip.id}/search?q=${encodeURIComponent(q.trim())}`, {
        signal: ctrl.signal,
      })
        .then(setR)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, trip.id]);

  const dayName = (dayId: string | null) => {
    const i = trip.days.findIndex((d) => d.id === dayId);
    return i < 0 ? "未排入" : `Day ${i + 1}`;
  };
  const empty = r && r.items.length + r.notes.length + r.wishlist.length === 0;

  return (
    <Dialog open={open} onClose={onClose} title="搜尋這趟行程">
      <div className="flex flex-col gap-3">
        <div className="flex h-11 items-center gap-2 rounded-lg border border-line-strong px-3">
          <Search className="size-4 text-muted" />
          <input
            type="search"
            aria-label="搜尋這趟行程"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="例如：飯店、JR、訂位代號"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </div>
        {empty && <p className="text-sm text-muted">找不到「{q}」。</p>}
        {r && r.items.length > 0 && (
          <ul className="flex flex-col gap-1">
            {r.items.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => onPickItem(i.id, i.dayId)}
                  className="flex w-full justify-between rounded-lg px-3 py-2 text-left hover:bg-canvas"
                >
                  <span className="font-semibold">{i.title}</span>
                  <span className="text-sm text-muted">{dayName(i.dayId)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {r?.notes.map((n) => (
          <p key={n.id} className="rounded-lg bg-canvas px-3 py-2 text-sm">
            <span className="mr-2 text-xs text-muted">筆記・{dayName(n.dayId)}</span>
            {n.body}
          </p>
        ))}
        {r?.wishlist.map((w) => (
          <p key={w.id} className="rounded-lg bg-canvas px-3 py-2 text-sm">
            <span className="mr-2 text-xs text-muted">想去清單</span>
            {w.place.name}
          </p>
        ))}
      </div>
    </Dialog>
  );
}
