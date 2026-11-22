"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { categoryLabel } from "@/lib/items";
import { keys, useSavedForTrip, useWishlist } from "@/lib/queries";
import type { Item, ItemType, Place, SavedCategory, TripDetail } from "@/lib/types";
import { Bookmark, ThumbUp, Trash } from "../icons";
import { PlaceSearch } from "../place-search";
import { useToast } from "../toast";
import { TripMap } from "../trip-map";
import { cx, Pill } from "../ui";

const typeFromCategory = (c: SavedCategory): ItemType =>
  c === "food" || c === "cafe"
    ? "food"
    : c === "stay"
      ? "stay"
      : c === "shopping"
        ? "activity"
        : "sight";

export function SidePanel({
  trip,
  dayId,
  dayLabel,
  dayItems,
  canEdit,
}: {
  trip: TripDetail;
  dayId: string | null;
  dayLabel: string;
  dayItems: Item[];
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<"wishlist" | "saved">("wishlist");
  const qc = useQueryClient();
  const toast = useToast();
  const wishlist = useWishlist(trip.id);
  const saved = useSavedForTrip(trip.id);

  const firstPlace = dayItems.find((i) => i.place?.lat != null)?.place ?? wishlist.data?.[0]?.place;
  const near =
    firstPlace?.lat != null && firstPlace.lng != null
      ? { lat: firstPlace.lat, lng: firstPlace.lng }
      : null;

  const points = dayItems
    .map((it, i) => ({ it, n: i + 1 }))
    .filter(({ it }) => it.place?.lat != null && it.place.lng != null)
    .map(({ it, n }) => ({
      id: it.id,
      label: String(n),
      title: it.title,
      lat: it.place?.lat as number,
      lng: it.place?.lng as number,
      confirmed: it.confirmed,
    }));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.wishlist(trip.id) });
    void qc.invalidateQueries({ queryKey: keys.items(trip.id) });
  };

  async function attempt(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast(ok);
      refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  const addToWishlist = (p: Place) =>
    attempt(async () => {
      try {
        await api("POST", `/v1/trips/${trip.id}/wishlist`, {
          body: { googlePlaceId: p.googlePlaceId },
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) throw new Error("這個地點已經在想去清單裡");
        throw e;
      }
    }, `已把「${p.name}」加入想去清單`);

  const saveToLibrary = (p: Place) =>
    attempt(async () => {
      try {
        await api("POST", "/v1/me/saved-places", { body: { googlePlaceId: p.googlePlaceId } });
        void qc.invalidateQueries({ queryKey: keys.saved });
        void qc.invalidateQueries({ queryKey: keys.savedForTrip(trip.id) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return;
        throw e;
      }
    }, `已存到我的地點`);

  return (
    <aside className="flex min-w-0 max-w-[460px] flex-[1_1_340px] flex-col gap-5">
      <TripMap points={points} />

      <section className="flex flex-col gap-3.5 rounded-2xl border border-line bg-white p-4.5">
        <div role="tablist" aria-label="候選地點" className="flex gap-1 rounded-lg bg-canvas p-1">
          {(
            [
              ["wishlist", `想去清單 ${wishlist.data?.length ?? ""}`],
              ["saved", "我的地點"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cx(
                "flex-1 rounded-md px-3 py-2 text-sm font-semibold",
                tab === key ? "bg-white text-ink shadow-sm" : "text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "wishlist" && (
          <>
            {canEdit && (
              <PlaceSearch placeholder="搜尋地點加入清單" near={near} onPick={addToWishlist} />
            )}
            {wishlist.data?.length === 0 && (
              <p className="py-4 text-center text-sm text-muted">還沒有想去的地方</p>
            )}
            <ul className="flex flex-col gap-2">
              {wishlist.data?.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center gap-2.5 rounded-xl bg-canvas px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-semibold">{w.place.name}</span>
                    <span className="truncate text-xs text-muted">
                      {w.addedBy.displayName} 新增{w.note ? `・${w.note}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-pressed={w.votedByMe}
                    aria-label={w.votedByMe ? "取消投票" : "投票支持"}
                    onClick={() =>
                      attempt(() =>
                        api(
                          w.votedByMe ? "DELETE" : "POST",
                          `/v1/trips/${trip.id}/wishlist/${w.id}/vote`,
                        ),
                      )
                    }
                    className={cx(
                      "flex h-8 items-center gap-1 rounded-full border px-2.5 text-[13px]",
                      w.votedByMe
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-line-strong bg-white text-ink-soft",
                    )}
                  >
                    <ThumbUp className="size-3.5" />
                    {w.votes}
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          attempt(
                            () =>
                              api("POST", `/v1/trips/${trip.id}/wishlist/${w.id}/schedule`, {
                                body: { dayId },
                              }),
                            `已排入${dayLabel}`,
                          )
                        }
                        className="h-8 rounded-lg bg-brand px-2.5 text-[13px] font-semibold text-white"
                      >
                        排入
                      </button>
                      <button
                        type="button"
                        aria-label="存到我的地點"
                        onClick={() => saveToLibrary(w.place)}
                        className="text-muted hover:text-brand"
                      >
                        <Bookmark />
                      </button>
                      <button
                        type="button"
                        aria-label={`從清單移除 ${w.place.name}`}
                        onClick={() =>
                          attempt(() => api("DELETE", `/v1/trips/${trip.id}/wishlist/${w.id}`))
                        }
                        className="text-muted hover:text-danger"
                      >
                        <Trash />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "saved" && (
          <>
            {trip.destinations.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">
                在行程設定加上目的地城市，就會列出你在那裡收藏的地點。
              </p>
            ) : saved.data?.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">
                你在{trip.destinations.map((d) => d.name).join("、")}還沒有收藏地點。
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {saved.data?.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2.5 rounded-xl bg-canvas px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[15px] font-semibold">{s.place.name}</span>
                    <span className="flex flex-wrap gap-1">
                      <Pill>{categoryLabel(s.category)}</Pill>
                      {s.tags.map((t) => (
                        <Pill key={t} tone="brand">
                          {t}
                        </Pill>
                      ))}
                    </span>
                    {s.privateNote && (
                      <span className="truncate text-xs text-muted">🔒 {s.privateNote}</span>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          attempt(
                            () =>
                              api("POST", `/v1/trips/${trip.id}/items`, {
                                body: {
                                  dayId,
                                  type: typeFromCategory(s.category),
                                  title: s.place.name,
                                  googlePlaceId: s.place.googlePlaceId,
                                },
                              }),
                            `已排入${dayLabel}`,
                          )
                        }
                        className="h-8 rounded-lg bg-brand px-2.5 text-[13px] font-semibold text-white"
                      >
                        排入
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          attempt(async () => {
                            try {
                              await api("POST", `/v1/trips/${trip.id}/wishlist`, {
                                body: { savedPlaceId: s.id },
                              });
                            } catch (e) {
                              if (e instanceof ApiError && e.status === 409)
                                throw new Error("已經在想去清單裡");
                              throw e;
                            }
                          }, "已加入想去清單")
                        }
                        className="h-8 rounded-lg border border-line-strong bg-white px-2.5 text-[13px] font-semibold"
                      >
                        想去
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <p className="text-xs text-muted">「排入」會加到{dayLabel}的最後，類型依地點自動判斷。</p>
    </aside>
  );
}
