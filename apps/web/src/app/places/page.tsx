"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { External, Trash } from "@/components/icons";
import { PlaceSearch } from "@/components/place-search";
import { useToast } from "@/components/toast";
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  Pill,
  Select,
  Textarea,
} from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { CATEGORIES, categoryLabel } from "@/lib/items";
import type { Place, SavedCategory, SavedPlace } from "@/lib/types";

interface City {
  cityKey: string;
  cityName: string;
  count: number;
}

function EditSaved({ item, onDone }: { item: SavedPlace; onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState(item.category);
  const [tags, setTags] = useState(item.tags.join("、"));
  const [note, setNote] = useState(item.privateNote ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("PATCH", `/v1/me/saved-places/${item.id}`, {
            body: {
              category,
              tags: tags.split(/[、,，\s]+/).filter(Boolean),
              privateNote: note || null,
            },
          });
          onDone();
        } catch (err) {
          toast(errorMessage(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="分類">
        {(id) => (
          <Select
            id={id}
            value={category}
            onChange={(e) => setCategory(e.target.value as SavedCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="標籤" hint="用頓號或空白分隔，例如：必去、雨天備案">
        {(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </Field>
      <Field label="私人備註" hint="只有你看得到；加入行程時可以選擇是否帶入。">
        {(id) => (
          <Textarea
            id={id}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：必點抹茶拿鐵、週一公休"
          />
        )}
      </Field>
      <Button type="submit" disabled={busy}>
        儲存
      </Button>
    </form>
  );
}

function PlacesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [city, setCity] = useState<string | null>(null);
  const [category, setCategory] = useState<SavedCategory | null>(null);
  const [editing, setEditing] = useState<SavedPlace | null>(null);

  const cities = useQuery({
    queryKey: ["saved", "cities"],
    queryFn: async () =>
      (await api<{ cities: City[] }>("GET", "/v1/me/saved-places/cities")).cities,
  });
  const activeCity = city ?? cities.data?.[0]?.cityKey ?? null;
  const list = useQuery({
    queryKey: ["saved", "list", activeCity, category],
    enabled: activeCity !== null,
    queryFn: async () => {
      const qs = new URLSearchParams({ city: activeCity as string });
      if (category) qs.set("category", category);
      return (await api<{ items: SavedPlace[] }>("GET", `/v1/me/saved-places?${qs}`)).items;
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["saved"] });

  async function add(p: Place) {
    try {
      const saved = await api<SavedPlace>("POST", "/v1/me/saved-places", {
        body: { googlePlaceId: p.googlePlaceId },
      });
      setCity(saved.cityKey);
      toast(`已收藏到「${saved.cityName}」`);
      refresh();
    } catch (e) {
      toast(
        e instanceof ApiError && e.status === 409 ? "這個地點已經收藏過了" : errorMessage(e),
        e instanceof ApiError && e.status === 409 ? "info" : "error",
      );
    }
  }

  const activeName = cities.data?.find((c) => c.cityKey === activeCity)?.cityName;

  return (
    <main className="mx-auto flex max-w-[1280px] flex-col gap-6 px-5 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-bold">我的地點</h1>
          <span className="text-[15px] text-muted">
            常去城市的餐廳、景點，規劃新行程時直接選入。
          </span>
        </div>
        <div className="w-full max-w-sm">
          <PlaceSearch placeholder="搜尋地點加入收藏" onPick={add} />
        </div>
      </div>

      {cities.isSuccess && cities.data.length === 0 ? (
        <EmptyState title="還沒有收藏的地點">
          用上面的搜尋框收藏常去的地方，會自動依城市分類。
        </EmptyState>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <nav
            aria-label="城市"
            className="flex min-w-0 max-w-[240px] flex-[1_1_200px] flex-col gap-1.5"
          >
            {cities.data?.map((c) => (
              <button
                key={c.cityKey}
                type="button"
                aria-pressed={c.cityKey === activeCity}
                onClick={() => setCity(c.cityKey)}
                className={cx(
                  "flex justify-between rounded-lg px-3.5 py-2.5 text-left text-[15px]",
                  c.cityKey === activeCity
                    ? "bg-brand-soft font-semibold text-brand"
                    : "hover:bg-white",
                )}
              >
                {c.cityName}
                <span className="text-sm text-muted">{c.count}</span>
              </button>
            ))}
          </nav>

          <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-2 text-xl font-bold">{activeName}</h2>
              {[{ value: null, label: "全部" }, ...CATEGORIES].map((c) => (
                <button
                  key={c.label}
                  type="button"
                  aria-pressed={category === c.value}
                  onClick={() => setCategory(c.value as SavedCategory | null)}
                  className={cx(
                    "h-8 rounded-full border px-3 text-sm",
                    category === c.value
                      ? "border-brand bg-brand-soft font-semibold text-brand"
                      : "border-line-strong bg-white text-ink-soft",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {list.data?.length === 0 && <p className="text-sm text-muted">這個分類還沒有地點。</p>}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {list.data?.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-4"
                >
                  <div className="flex items-start gap-2">
                    <strong className="min-w-0 flex-1 text-[16px]">{s.place.name}</strong>
                    {s.place.googleMapsUri && (
                      <a
                        href={s.place.googleMapsUri}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`在 Google 地圖開啟 ${s.place.name}`}
                        className="text-muted hover:text-brand"
                      >
                        <External />
                      </a>
                    )}
                    <button
                      type="button"
                      aria-label={`刪除 ${s.place.name}`}
                      onClick={async () => {
                        if (!window.confirm(`從地點庫移除「${s.place.name}」？`)) return;
                        await api("DELETE", `/v1/me/saved-places/${s.id}`);
                        refresh();
                      }}
                      className="text-muted hover:text-danger"
                    >
                      <Trash />
                    </button>
                  </div>
                  <span className="text-xs text-muted">{s.place.address}</span>
                  <div className="flex flex-wrap gap-1">
                    <Pill>{categoryLabel(s.category)}</Pill>
                    {s.tags.map((t) => (
                      <Pill key={t} tone="brand">
                        {t}
                      </Pill>
                    ))}
                  </div>
                  {s.privateNote && (
                    <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
                      {s.privateNote}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="self-start text-sm font-semibold text-brand"
                  >
                    編輯
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.place.name ?? ""}
      >
        {editing && (
          <EditSaved
            item={editing}
            onDone={() => {
              setEditing(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </main>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <PlacesPage />
      </AppShell>
    </RequireAuth>
  );
}
