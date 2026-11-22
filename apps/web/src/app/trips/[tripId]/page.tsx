"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ChevronLeft, Plus, Pushpin, Search, UserPlus } from "@/components/icons";
import { ItemCard } from "@/components/planner/item-card";
import { ItemDialog } from "@/components/planner/item-dialog";
import { SearchDialog } from "@/components/planner/search-dialog";
import { SidePanel } from "@/components/planner/side-panel";
import { useToast } from "@/components/toast";
import { TripForm } from "@/components/trip-form";
import { Avatar, Button, cx, Dialog, EmptyState } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { useTripEvents } from "@/lib/live";
import { keys, useItems, useTrip } from "@/lib/queries";
import { formatDay, formatRange, offsetFromTaipei, today } from "@/lib/time";
import type { Item, TripDay, Warning } from "@/lib/types";

const NONE = "none";

function DayButton({
  day,
  label,
  sub,
  count,
  selected,
  onSelect,
}: {
  day: string;
  label: string;
  sub: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const drop = useDroppable({ id: `day:${day}` });
  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        "flex flex-col gap-0.5 rounded-xl border px-3.5 py-3 text-left transition-colors",
        selected ? "border-brand bg-brand-soft" : "border-line bg-white hover:border-line-strong",
        drop.isOver && "border-dashed border-brand bg-brand-soft",
      )}
    >
      <span className={cx("text-[13px] font-semibold", selected ? "text-brand" : "text-muted")}>
        {label}
      </span>
      <span className="text-[15px] font-semibold">{sub}</span>
      <span className="text-[13px] text-muted">{count > 0 ? `${count} 個行程點` : "尚未安排"}</span>
    </button>
  );
}

function Planner() {
  const { tripId } = useParams<{ tripId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const trip = useTrip(tripId);
  const items = useItems(tripId);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ item: Item | null } | null>(null);
  const [editingTrip, setEditingTrip] = useState(false);
  const [searching, setSearching] = useState(false);
  // 其他成員（或 MCP）修改時即時更新
  useTripEvents(tripId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items.data ?? []) {
      const k = it.dayId ?? NONE;
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    for (const list of m.values())
      list.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return m;
  }, [items.data]);

  if (trip.isError) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <EmptyState title="找不到這趟行程">可能已被刪除，或你不是成員。</EmptyState>
      </main>
    );
  }
  if (!trip.data) return <p className="p-10 text-center text-sm text-muted">載入中…</p>;
  const t = trip.data;
  const canEdit = t.myRole !== "viewer";

  // 預設選今天（旅行中）或第一天
  const days = t.days;
  const todayDay = days.find((d) => d.date === today());
  const dayKey = selected ?? todayDay?.id ?? days[0]?.id ?? NONE;
  const currentDay: TripDay | undefined = days.find((d) => d.id === dayKey);
  const dayIndex = currentDay ? days.indexOf(currentDay) : -1;
  const dayLabel = currentDay ? `Day ${dayIndex + 1}` : "未排入";
  const dayItems = byDay.get(dayKey) ?? [];
  const unscheduled = byDay.get(NONE) ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.items(tripId) });
    void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
  };

  function showWarnings(w?: Warning[]) {
    if (w && w.length > 0) {
      const names = w.map((x) => items.data?.find((i) => i.id === x.itemId)?.title).filter(Boolean);
      toast(`時間和已釘選的「${names.join("、")}」重疊`, "warning");
    }
  }

  async function move(item: Item, toDay: string, index: number, optimisticKey: string) {
    const prev = items.data;
    qc.setQueryData<Item[]>(keys.items(tripId), (old) =>
      old?.map((i) =>
        i.id === item.id
          ? { ...i, dayId: toDay === NONE ? null : toDay, sortKey: optimisticKey }
          : i,
      ),
    );
    try {
      const res = await api<{ warnings: Warning[] }>(
        "POST",
        `/v1/trips/${tripId}/items/${item.id}/move`,
        {
          body: { dayId: toDay === NONE ? null : toDay, index },
        },
      );
      showWarnings(res.warnings);
    } catch (e) {
      qc.setQueryData(keys.items(tripId), prev);
      toast(
        e instanceof ApiError && e.status === 423 ? "已釘選的行程點不能移動" : errorMessage(e),
        "error",
      );
    } finally {
      invalidate();
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const item = items.data?.find((i) => i.id === e.active.id);
    if (!item || !e.over) return;
    const overId = String(e.over.id);
    if (overId.startsWith("day:")) {
      const target = overId.slice(4);
      if (target === (item.dayId ?? NONE)) return;
      const list = byDay.get(target) ?? [];
      const last = list.at(-1)?.sortKey ?? null;
      void move(item, target, list.length, generateKeyBetween(last, null));
      toast(
        `已移到${target === NONE ? "未排入" : `Day ${days.findIndex((d) => d.id === target) + 1}`}`,
      );
      return;
    }
    const from = dayItems.findIndex((i) => i.id === item.id);
    const to = dayItems.findIndex((i) => i.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const reordered = arrayMove(dayItems, from, to);
    const key = generateKeyBetween(
      reordered[to - 1]?.sortKey ?? null,
      reordered[to + 1]?.sortKey ?? null,
    );
    void move(item, dayKey, to, key);
  }

  const confirmedCount = dayItems.filter((i) => i.confirmed).length;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-5 py-4 sm:px-7">
          <Link
            href="/trips"
            aria-label="回到我的行程"
            className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft"
          >
            <ChevronLeft />
          </Link>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
            <h1 className="text-[22px] font-bold">{t.title}</h1>
            <span className="text-sm text-muted">
              {formatRange(t.startDate, t.endDate)}・{days.length} 天・{t.primaryTz}（
              {offsetFromTaipei(t.primaryTz)}）
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex -space-x-2">
              {t.members.slice(0, 5).map((m) => (
                <Avatar key={m.userId} name={m.displayName} ring />
              ))}
            </div>
            {today() >= t.startDate && today() <= t.endDate && (
              <Link
                href={`/trips/${tripId}/today`}
                className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-semibold text-white"
              >
                今日
              </Link>
            )}
            <button
              type="button"
              aria-label="搜尋這趟行程"
              onClick={() => setSearching(true)}
              className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft"
            >
              <Search />
            </button>
            <Link
              href={`/trips/${tripId}/journal`}
              className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3.5 text-sm font-semibold"
            >
              心得
            </Link>
            <Link
              href={`/trips/${tripId}/members`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-sm font-semibold"
            >
              <UserPlus />
              成員
            </Link>
            {canEdit && (
              <Button variant="secondary" size="sm" onClick={() => setEditingTrip(true)}>
                行程設定
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1400px] flex-wrap items-start gap-6 px-5 py-6 sm:px-7">
        <nav
          aria-label="選擇日期"
          className="flex min-w-0 flex-[1_1_180px] flex-col gap-1.5 sm:max-w-[220px]"
        >
          {days.map((d, i) => (
            <DayButton
              key={d.id}
              day={d.id}
              label={`Day ${i + 1}・${formatDay(d.date)}`}
              sub={d.title ?? (d.date === today() ? "今天" : formatDay(d.date, "long"))}
              count={byDay.get(d.id)?.length ?? 0}
              selected={d.id === dayKey}
              onSelect={() => setSelected(d.id)}
            />
          ))}
          {(unscheduled.length > 0 || dayKey === NONE) && (
            <DayButton
              day={NONE}
              label="未排入"
              sub="還沒決定哪天"
              count={unscheduled.length}
              selected={dayKey === NONE}
              onSelect={() => setSelected(NONE)}
            />
          )}
          {canEdit && <p className="px-1 pt-2 text-xs text-muted">可以把行程點拖到其他天。</p>}
        </nav>

        <section className="flex min-w-0 flex-[999_1_480px] flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-xl font-bold">
                {dayLabel}
                {currentDay && `・${formatDay(currentDay.date, "long")}`}
              </h2>
              <span className="text-sm text-muted">
                {dayItems.length > 0 ? `${dayItems.length} 個行程點` : "尚未安排"}
              </span>
              {confirmedCount > 0 && (
                <span className="mt-1 flex items-center gap-1.5 text-[13px] text-pin-ink">
                  <Pushpin className="size-3.5 text-pin" />
                  已訂位／已購票的行程點會釘選，日期、時間、地點與順序都不能更動
                </span>
              )}
            </div>
            {canEdit && (
              <Button size="sm" onClick={() => setDialog({ item: null })}>
                <Plus />
                新增行程點
              </Button>
            )}
          </div>

          {items.isLoading ? (
            <p className="text-sm text-muted">載入中…</p>
          ) : dayItems.length === 0 ? (
            <EmptyState title="這天還沒有安排">
              從右邊的想去清單或我的地點排入，或直接新增行程點。
            </EmptyState>
          ) : (
            <SortableContext
              items={dayItems.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="flex flex-col gap-2.5">
                {dayItems.map((it, i) => (
                  <ItemCard
                    key={it.id}
                    item={it}
                    n={i + 1}
                    canEdit={canEdit}
                    onOpen={() => setDialog({ item: it })}
                  />
                ))}
              </ol>
            </SortableContext>
          )}
        </section>

        <SidePanel
          trip={t}
          dayId={dayKey === NONE ? null : dayKey}
          dayLabel={dayLabel}
          dayItems={dayItems}
          canEdit={canEdit}
        />
      </main>

      <ItemDialog
        trip={t}
        item={dialog?.item ?? null}
        dayId={dayKey === NONE ? null : dayKey}
        open={dialog !== null}
        canEdit={canEdit}
        onClose={() => setDialog(null)}
        onSaved={(w) => {
          setDialog(null);
          showWarnings(w);
          invalidate();
        }}
      />

      <SearchDialog
        trip={t}
        open={searching}
        onClose={() => setSearching(false)}
        onPickItem={(itemId, dayId) => {
          setSearching(false);
          setSelected(dayId ?? NONE);
          const it = items.data?.find((i) => i.id === itemId);
          if (it) setDialog({ item: it });
        }}
      />

      <Dialog open={editingTrip} onClose={() => setEditingTrip(false)} title="行程設定">
        <TripForm
          submitLabel="儲存"
          initial={{
            title: t.title,
            startDate: t.startDate,
            endDate: t.endDate,
            primaryTz: t.primaryTz,
            destinations: t.destinations,
          }}
          onSubmit={async (v) => {
            try {
              await api("PATCH", `/v1/trips/${tripId}`, { body: v, ifMatch: t.version });
            } catch (e) {
              if (e instanceof ApiError && e.status === 409 && Array.isArray(e.body.dates)) {
                throw new ApiError(
                  409,
                  e.type,
                  `${(e.body.dates as string[]).join("、")} 還有行程點，請先移到其他天`,
                  e.body,
                );
              }
              throw e;
            }
            setEditingTrip(false);
            invalidate();
            void qc.invalidateQueries({ queryKey: ["trips"] });
            void qc.invalidateQueries({ queryKey: keys.savedForTrip(tripId) });
          }}
        />
        {t.myRole === "owner" && (
          <div className="mt-6 border-t border-line pt-4">
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                if (!window.confirm(`確定要刪除「${t.title}」？所有行程點都會一起刪除，無法復原。`))
                  return;
                try {
                  await api("DELETE", `/v1/trips/${tripId}`);
                  window.location.href = "/trips";
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              刪除這趟行程
            </Button>
          </div>
        )}
      </Dialog>
    </DndContext>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <Planner />
      </AppShell>
    </RequireAuth>
  );
}
