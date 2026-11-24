"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { COMMON_TIME_ZONES } from "@/lib/time";
import type { Destination, Place } from "@/lib/types";
import { PlaceSearch } from "./place-search";
import { Button, Field, Input, Select } from "./ui";

export interface TripFormValue {
  title: string;
  startDate: string;
  endDate: string;
  primaryTz: string;
  destinations: Destination[];
}

/** 建立／編輯行程表單。目的地用地點搜尋選城市，取得城市 key（我的地點庫依此篩選）。 */
export function TripForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial: TripFormValue;
  submitLabel: string;
  onSubmit: (v: TripFormValue) => Promise<void>;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addDestination(p: Place) {
    if (!p.cityKey || !p.cityName) {
      setError("無法判斷這個地點所在的城市，請改搜尋城市名稱");
      return;
    }
    const d = { cityKey: p.cityKey, name: p.cityName };
    setV((x) => ({
      ...x,
      destinations: x.destinations.some((y) => y.cityKey === d.cityKey)
        ? x.destinations
        : [...x.destinations, d],
      // 第一個目的地決定預設時區
      primaryTz: x.destinations.length === 0 && p.tz ? p.tz : x.primaryTz,
    }));
  }

  const zones = COMMON_TIME_ZONES.some(([z]) => z === v.primaryTz)
    ? COMMON_TIME_ZONES
    : [[v.primaryTz, v.primaryTz] as const, ...COMMON_TIME_ZONES];

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit(v);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="行程名稱">
        {(id) => (
          <Input
            id={id}
            required
            maxLength={120}
            value={v.title}
            onChange={(e) => setV({ ...v, title: e.target.value })}
            placeholder="例如：京都・大阪 秋楓之旅"
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="出發日">
          {(id) => (
            <Input
              id={id}
              type="date"
              required
              value={v.startDate}
              onChange={(e) =>
                setV({
                  ...v,
                  startDate: e.target.value,
                  // 日期字串（YYYY-MM-DD）依字典序比較；回程日不能早於出發日
                  endDate: [v.endDate, e.target.value].sort().at(-1) ?? e.target.value,
                })
              }
            />
          )}
        </Field>
        <Field label="回程日">
          {(id) => (
            <Input
              id={id}
              type="date"
              required
              min={v.startDate}
              value={v.endDate}
              onChange={(e) => setV({ ...v, endDate: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink-soft">目的地</span>
        {v.destinations.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {v.destinations.map((d) => (
              <span
                key={d.cityKey}
                className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-3 py-1 text-sm font-semibold text-brand"
              >
                {d.name}
                <button
                  type="button"
                  aria-label={`移除 ${d.name}`}
                  onClick={() =>
                    setV({
                      ...v,
                      destinations: v.destinations.filter((x) => x.cityKey !== d.cityKey),
                    })
                  }
                  className="ml-1 text-brand/70 hover:text-brand"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <PlaceSearch placeholder="搜尋城市，例如：京都" onPick={addDestination} />
        <span className="text-xs text-muted">我的地點庫會依目的地城市篩選。</span>
      </div>
      <Field label="主要時區" hint="行程點有地點時，會以地點所在時區顯示。">
        {(id) => (
          <Select
            id={id}
            value={v.primaryTz}
            onChange={(e) => setV({ ...v, primaryTz: e.target.value })}
          >
            {zones.map(([z, label]) => (
              <option key={z} value={z}>
                {label}（{z}）
              </option>
            ))}
          </Select>
        )}
      </Field>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
