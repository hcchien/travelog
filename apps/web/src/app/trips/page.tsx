"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Plus } from "@/components/icons";
import { TripForm, type TripFormValue } from "@/components/trip-form";
import { Button, Dialog, EmptyState, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { daysBetween, formatRange, today } from "@/lib/time";
import type { Trip, TripDetail } from "@/lib/types";

const COVERS = ["#DCE8F5", "#E5EFE8", "#F1E6DA", "#EFE9F7", "#E6F0F3"];

function phase(t: Trip) {
  const d = today();
  if (d < t.startDate) {
    const n = daysBetween(d, t.startDate) - 1;
    return {
      label: n === 0 ? "明天出發" : `${n} 天後出發`,
      tone: "pin" as const,
      group: "upcoming",
    };
  }
  if (d <= t.endDate) return { label: "旅行中", tone: "brand" as const, group: "ongoing" };
  return { label: "已結束", tone: "neutral" as const, group: "past" };
}

function TripCard({ trip, index }: { trip: Trip; index: number }) {
  const p = phase(trip);
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white hover:border-line-strong"
    >
      <div
        className="flex h-28 items-start justify-end p-3"
        style={{ background: COVERS[index % COVERS.length] }}
      >
        <Pill tone={p.tone}>{p.label}</Pill>
      </div>
      <div className="flex flex-col gap-1.5 px-4.5 py-4">
        <strong className="text-[17px]">{trip.title}</strong>
        <span className="text-sm text-muted">
          {formatRange(trip.startDate, trip.endDate)}
          {trip.destinations.length > 0 && `・${trip.destinations.map((d) => d.name).join("、")}`}
        </span>
        {trip.myRole !== "owner" && (
          <span className="text-xs text-muted">
            {trip.myRole === "editor" ? "你是編輯者" : "你是檢視者"}
          </span>
        )}
      </div>
    </Link>
  );
}

function TripsPage() {
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const trips = useQuery({
    queryKey: ["trips"],
    queryFn: () => api<{ trips: Trip[] }>("GET", "/v1/trips"),
  });
  const create = useMutation({
    mutationFn: (v: TripFormValue) => api<TripDetail>("POST", "/v1/trips", { body: v }),
    onSuccess: (trip) => {
      void qc.invalidateQueries({ queryKey: ["trips"] });
      router.push(`/trips/${trip.id}`);
    },
  });

  const list = trips.data?.trips ?? [];
  const upcoming = list
    .filter((t) => phase(t).group !== "past")
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = list.filter((t) => phase(t).group === "past");
  const d = today();

  return (
    <main className="mx-auto flex max-w-[1280px] flex-col gap-10 px-5 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-bold">我的行程</h1>
          <span className="text-[15px] text-muted">
            {upcoming.length} 趟即將出發或進行中・{past.length} 趟已結束
          </span>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-[18px]" />
          建立行程
        </Button>
      </div>

      {trips.isLoading && <p className="text-sm text-muted">載入中…</p>}
      {trips.isSuccess && list.length === 0 && (
        <EmptyState title="還沒有行程">建立第一趟行程，邀請旅伴一起規劃。</EmptyState>
      )}

      {upcoming.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-bold">即將出發</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
            {upcoming.map((t, i) => (
              <TripCard key={t.id} trip={t} index={i} />
            ))}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-bold">已結束</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
            {past.map((t, i) => (
              <TripCard key={t.id} trip={t} index={i + upcoming.length} />
            ))}
          </div>
        </section>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="建立行程">
        <TripForm
          submitLabel="建立"
          initial={{
            title: "",
            startDate: d,
            endDate: d,
            primaryTz: "Asia/Tokyo",
            destinations: [],
          }}
          onSubmit={async (v) => {
            await create.mutateAsync(v);
          }}
        />
      </Dialog>
    </main>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <TripsPage />
      </AppShell>
    </RequireAuth>
  );
}
