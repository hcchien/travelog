"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, File, Pushpin } from "@/components/icons";
import { useToast } from "@/components/toast";
import { Button, cx, Dialog, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { confirmedLabel, itemTypeMeta } from "@/lib/items";
import { useTripEvents } from "@/lib/live";
import { loadSnapshot, refreshSnapshot } from "@/lib/offline";
import { formatDay, formatTime, isoToZoned } from "@/lib/time";
import type { Item, Note, Snapshot } from "@/lib/types";

function mapsUrl(it: Item) {
  const p = it.place;
  if (!p) return null;
  const qs = new URLSearchParams({ api: "1" });
  if (p.lat != null && p.lng != null) qs.set("destination", `${p.lat},${p.lng}`);
  else qs.set("destination", p.name);
  qs.set("destination_place_id", p.googlePlaceId);
  return `https://www.google.com/maps/dir/?${qs}`;
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function QuickNote({
  tripId,
  dayId,
  open,
  onClose,
}: {
  tripId: string;
  dayId: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [withLocation, setWithLocation] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      let coords: { lat: number; lng: number } | null = null;
      if (withLocation && "geolocation" in navigator) {
        coords = await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => resolve(null),
            { timeout: 8000, maximumAge: 60_000 },
          ),
        );
      }
      await api("POST", `/v1/trips/${tripId}/notes`, { body: { body, dayId, ...(coords ?? {}) } });
      setBody("");
      toast("已記下");
      void qc.invalidateQueries({ queryKey: ["snapshot", tripId] });
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="快速筆記">
      <div className="flex flex-col gap-3">
        <Textarea
          aria-label="筆記內容"
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="例如：這家抹茶冰淇淋超好吃"
          className="min-h-28"
        />
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={withLocation}
            onChange={(e) => setWithLocation(e.target.checked)}
            className="size-4"
          />
          附上目前位置（只有行程成員看得到）
        </label>
        <Button onClick={save} disabled={busy || !body.trim()}>
          記下
        </Button>
      </div>
    </Dialog>
  );
}

function Today() {
  const { tripId } = useParams<{ tripId: string }>();
  const { status } = useAuth();
  const now = useNow();
  const [noting, setNoting] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const live = useTripEvents(tripId);

  const snap = useQuery({
    queryKey: ["snapshot", tripId],
    queryFn: async (): Promise<{ data: Snapshot; offline: boolean }> => {
      if (status !== "offline") {
        try {
          return { data: await refreshSnapshot(tripId), offline: false };
        } catch {
          // 落到下面讀取離線資料
        }
      }
      const cached = loadSnapshot(tripId);
      if (!cached) throw new Error("沒有離線資料");
      return { data: cached, offline: true };
    },
    retry: false,
  });

  const s = snap.data?.data;
  const tz = s?.trip.primaryTz ?? "Asia/Taipei";
  const todayLocal = isoToZoned(now.toISOString(), tz).date;
  const day = useMemo(() => {
    if (!s) return undefined;
    return (
      s.trip.days.find((d) => d.id === picked) ??
      s.trip.days.find((d) => d.date === todayLocal) ??
      s.trip.days[0]
    );
  }, [s, picked, todayLocal]);

  if (snap.isLoading) return <p className="p-10 text-center text-sm text-muted">載入中…</p>;
  if (!s || !day) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p className="mt-10">目前沒有網路，這趟行程也還沒有下載離線資料。</p>
        <p className="mt-2 text-sm text-muted">連上網路後打開一次這個頁面，就會自動存下來。</p>
      </main>
    );
  }

  const dayIndex = s.trip.days.indexOf(day);
  const items = s.items.filter((i) => i.dayId === day.id);
  const isToday = day.date === todayLocal;
  const next = isToday ? items.find((i) => i.startAt && new Date(i.startAt) > now) : undefined;
  const stays = s.items.filter((i) => i.type === "stay" && i.dayId);
  const dayOrder = (id: string | null) => s.trip.days.findIndex((d) => d.id === id);
  const lodging = stays
    .filter((i) => dayOrder(i.dayId) <= dayIndex)
    .sort((a, b) => dayOrder(b.dayId) - dayOrder(a.dayId))[0];
  const notes = s.notes.filter((n: Note) => n.dayId === day.id);
  const offline = snap.data?.offline;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-canvas">
      <header className="flex flex-col gap-3 bg-navy px-5 pt-5 pb-4 text-white">
        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/trips/${tripId}`}
            className="flex items-center gap-1 text-sm text-[#c5cedb]"
          >
            <ChevronLeft className="size-4" />
            {s.trip.title}
          </Link>
          <span
            className={cx(
              "rounded-full px-2.5 py-1 text-xs",
              offline ? "bg-accent text-white" : "bg-white/15 text-[#e3e8ef]",
            )}
          >
            {offline
              ? `離線中・${new Date(s.generatedAt).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" })} 的資料`
              : live
                ? "✓ 已離線儲存・即時更新"
                : "✓ 已離線儲存"}
          </span>
        </div>
        <div>
          <h1 className="text-2xl font-bold">
            Day {dayIndex + 1}
            {day.title ? `・${day.title}` : ""}
          </h1>
          <span className="text-sm text-[#c5cedb]">
            {formatDay(day.date, "long")}
            {isToday && `・當地時間 ${isoToZoned(now.toISOString(), tz).time}`}
          </span>
        </div>
        <nav aria-label="選擇日期" className="-mx-1 flex gap-1.5 overflow-x-auto pb-1">
          {s.trip.days.map((d, i) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={d.id === day.id}
              onClick={() => setPicked(d.id)}
              className={cx(
                "flex-none rounded-full px-3 py-1 text-sm",
                d.id === day.id ? "bg-white font-semibold text-navy" : "bg-white/10 text-[#e3e8ef]",
              )}
            >
              Day {i + 1}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex flex-1 flex-col gap-3.5 p-4 pb-28">
        {next && (
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
            <span className="text-[13px] font-bold text-pin-ink">
              下一站・{formatTime(next.startAt, next.tz)}
            </span>
            <div className="flex flex-col gap-1">
              <strong className="text-[22px]">{next.title}</strong>
              {next.place?.address && (
                <span className="text-sm text-muted">{next.place.address}</span>
              )}
            </div>
            {mapsUrl(next) && (
              <a
                href={mapsUrl(next) as string}
                target="_blank"
                rel="noreferrer"
                className="flex h-12 items-center justify-center rounded-xl bg-brand font-semibold text-white"
              >
                開始導航
              </a>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-bold text-ink-soft">
            {isToday ? "今天的行程" : "這天的行程"}
          </h2>
          {items.length === 0 ? (
            <p className="rounded-xl bg-white p-4 text-sm text-muted">這天沒有安排行程。</p>
          ) : (
            <ol className="overflow-hidden rounded-2xl border border-line bg-white">
              {items.map((it) => {
                const done = isToday && it.startAt && new Date(it.endAt ?? it.startAt) < now;
                const current = it.id === next?.id;
                return (
                  <li
                    key={it.id}
                    className={cx(
                      "flex items-start gap-3 border-b border-[#eef0f3] px-4 py-3 last:border-0",
                      it.confirmed && "bg-pin-bg",
                      current && "bg-[#fff6ef]",
                    )}
                  >
                    <span
                      className={cx(
                        "mt-0.5 w-11 flex-none text-sm",
                        done ? "text-muted" : "font-semibold",
                      )}
                    >
                      {formatTime(it.startAt, it.tz) || "—"}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span
                        className={cx(
                          "text-[15px]",
                          done ? "text-muted line-through" : "font-semibold",
                        )}
                      >
                        {it.title}
                      </span>
                      <span className="flex flex-wrap gap-1.5 text-xs">
                        <span
                          className={cx(
                            "rounded px-1.5 py-0.5 font-semibold",
                            itemTypeMeta(it.type).chip,
                          )}
                        >
                          {itemTypeMeta(it.type).label}
                        </span>
                        {it.confirmed && (
                          <span className="flex items-center gap-1 rounded bg-pin-chip px-1.5 py-0.5 font-bold text-pin-ink">
                            <Pushpin className="size-3" />
                            {confirmedLabel(it.booking?.kind, it.confirmSource)}
                          </span>
                        )}
                      </span>
                      {it.booking?.confirmationCode && (
                        <span className="flex items-center gap-1 text-[13px] text-ink-soft">
                          <File className="size-3.5" />
                          訂位代號{" "}
                          <strong className="font-mono">{it.booking.confirmationCode}</strong>
                        </span>
                      )}
                    </div>
                    {mapsUrl(it) && (
                      <a
                        href={mapsUrl(it) as string}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-none text-sm font-semibold text-brand"
                      >
                        導航
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {lodging && (
          <section className="flex flex-col gap-1 rounded-2xl border border-line bg-white p-4">
            <span className="text-[13px] font-bold text-[#5b3a8c]">今晚住宿</span>
            <strong className="text-[16px]">{lodging.title}</strong>
            {lodging.place?.address && (
              <span className="text-sm text-muted">{lodging.place.address}</span>
            )}
            {lodging.booking?.confirmationCode && (
              <span className="text-sm">
                訂位代號 <strong className="font-mono">{lodging.booking.confirmationCode}</strong>
              </span>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="flex items-center justify-between text-[15px] font-bold text-ink-soft">
            筆記
            {!offline && (
              <Link href={`/trips/${tripId}/journal`} className="text-sm font-semibold text-brand">
                整理成心得 →
              </Link>
            )}
          </h2>
          {notes.length === 0 && (
            <p className="text-sm text-muted">還沒有筆記。按右下角的按鈕隨手記一筆。</p>
          )}
          {notes.map((n) => (
            <div key={n.id} className="rounded-xl bg-white px-4 py-3 text-[15px]">
              <span className="block text-xs text-muted">
                {formatTime(n.takenAt, tz)} {n.author.displayName}
                {n.lat != null && "・📍"}
              </span>
              {n.body}
            </div>
          ))}
        </section>
      </main>

      <button
        type="button"
        aria-label="新增快速筆記"
        disabled={offline}
        title={offline ? "離線時無法新增筆記" : undefined}
        onClick={() => setNoting(true)}
        className="fixed right-5 bottom-6 flex size-14 items-center justify-center rounded-full bg-accent text-white shadow-lg disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
      <QuickNote tripId={tripId} dayId={day.id} open={noting} onClose={() => setNoting(false)} />
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth offlineOk>
      <Today />
    </RequireAuth>
  );
}
