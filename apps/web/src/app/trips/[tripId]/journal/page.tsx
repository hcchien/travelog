"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ChevronLeft, Copy, External } from "@/components/icons";
import { JournalBody } from "@/components/journal-doc";
import { editorDoc, JournalEditor, useJournalEditor } from "@/components/journal-editor";
import { useToast } from "@/components/toast";
import { Avatar, Button, Input } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { useTripEvents } from "@/lib/live";
import { keys, useTrip } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import type { JournalEntry, Note, ShareLink, TripDetail } from "@/lib/types";

type Target = { scope: "trip" } | { scope: "day"; dayId: string };

function EntryEditor({
  tripId,
  target,
  entry,
  onDone,
}: {
  tripId: string;
  target: Target;
  entry: JournalEntry | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const editor = useJournalEditor(entry?.body ?? null);
  const [title, setTitle] = useState(entry?.title ?? "");
  const [isPublic, setPublic] = useState(entry?.visibility === "public");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editor) return;
    setBusy(true);
    const payload = {
      title: title.trim() || null,
      body: editorDoc(editor),
      visibility: isPublic ? "public" : "members",
    };
    try {
      if (entry) {
        await api("PATCH", `/v1/trips/${tripId}/journal/${entry.id}`, {
          body: { ...payload, version: entry.version },
        });
      } else {
        await api("POST", `/v1/trips/${tripId}/journal`, { body: { ...payload, target } });
      }
      toast("已儲存");
      void qc.invalidateQueries({ queryKey: ["journal", tripId] });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        toast("這篇心得在別的地方改過了。請先複製你的內容，再重新整理。", "error");
      } else {
        toast(errorMessage(e), "error");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-white p-4">
      <Input
        aria-label="標題（選填）"
        placeholder="標題（選填）"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <JournalEditor editor={editor} />
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          className="size-4"
          checked={isPublic}
          onChange={(e) => setPublic(e.target.checked)}
        />
        放進公開遊記（擁有者建立分享連結後，任何拿到連結的人都看得到）
      </label>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !editor}>
          儲存
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}

function EntryView({
  e,
  mine,
  onEdit,
  onDelete,
}: {
  e: JournalEntry;
  mine: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-xl bg-white p-4">
      <header className="flex items-center gap-2">
        <Avatar name={e.author.displayName ?? "?"} size={28} />
        <strong className="text-sm">
          {e.author.displayName}
          {mine && "（你）"}
        </strong>
        {e.visibility === "public" && (
          <span className="rounded bg-brand-soft px-1.5 py-0.5 text-xs font-semibold text-brand">
            公開
          </span>
        )}
        <span className="ml-auto flex gap-3 text-[13px] font-semibold">
          {onEdit && (
            <button type="button" className="text-brand" onClick={onEdit}>
              編輯
            </button>
          )}
          {onDelete && (
            <button type="button" className="text-danger" onClick={onDelete}>
              刪除
            </button>
          )}
        </span>
      </header>
      {e.title && <h3 className="text-lg font-bold">{e.title}</h3>}
      <JournalBody doc={e.body} />
    </article>
  );
}

function Section({
  trip,
  label,
  sub,
  target,
  entries,
  pendingNotes,
}: {
  trip: TripDetail;
  label: string;
  sub?: string;
  target: Target;
  entries: JournalEntry[];
  pendingNotes: number;
}) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const mine = entries.find((e) => e.author.userId === me?.id) ?? null;
  const others = entries.filter((e) => e !== mine);
  const canWrite = trip.myRole !== "viewer" || trip.viewerCanWriteJournal !== false;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["journal", trip.id] });
    void qc.invalidateQueries({ queryKey: ["notes", trip.id] });
  };

  async function merge() {
    if (target.scope !== "day") return;
    try {
      const r = await api<{ merged: number }>("POST", `/v1/trips/${trip.id}/journal/merge-notes`, {
        body: { dayId: target.dayId },
      });
      toast(`已把 ${r.merged} 則筆記加進心得`);
      refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  async function remove(e: JournalEntry) {
    if (!window.confirm("刪除這篇心得？")) return;
    try {
      await api("DELETE", `/v1/trips/${trip.id}/journal/${e.id}`);
      refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold">{label}</h2>
        {sub && <span className="text-sm text-muted">{sub}</span>}
        <span className="ml-auto flex gap-2">
          {canWrite && pendingNotes > 0 && !editing && (
            <Button size="sm" variant="secondary" onClick={merge}>
              把 {pendingNotes} 則筆記加進心得
            </Button>
          )}
          {canWrite && !mine && !editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              寫心得
            </Button>
          )}
        </span>
      </div>
      {editing ? (
        <EntryEditor
          tripId={trip.id}
          target={target}
          entry={mine}
          onDone={() => setEditing(false)}
        />
      ) : (
        mine && (
          <EntryView e={mine} mine onEdit={() => setEditing(true)} onDelete={() => remove(mine)} />
        )
      )}
      {others.map((e) => (
        <EntryView
          key={e.id}
          e={e}
          mine={false}
          {...(trip.myRole === "owner" ? { onDelete: () => remove(e) } : {})}
        />
      ))}
      {!mine && !editing && others.length === 0 && (
        <p className="text-sm text-muted">還沒有心得。</p>
      )}
    </section>
  );
}

function SharePanel({ tripId }: { tripId: string }) {
  const toast = useToast();
  const [hideLodging, setHideLodging] = useState(true);
  const [journalOnly, setJournalOnly] = useState(false);
  const links = useQuery({
    queryKey: ["share-links", tripId],
    queryFn: async () =>
      (await api<{ links: ShareLink[] }>("GET", `/v1/trips/${tripId}/share-links`)).links,
  });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      void links.refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5">
      <div>
        <h2 className="text-lg font-bold">公開遊記</h2>
        <p className="text-sm text-muted">
          拿到連結的人不用登入就能看：行程表與標示「公開」的心得。訂位代號、附件、快速筆記不會公開。
        </p>
      </div>
      {links.data?.map((l) => (
        <div
          key={l.id}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate font-mono">{l.url}</span>
          <span className="text-xs text-muted">
            {l.options.journalOnly ? "只有心得" : "行程＋心得"}
            {l.options.hideLodging ? "・隱藏住宿" : ""}
          </span>
          <button
            type="button"
            aria-label="複製連結"
            className="text-ink-soft"
            onClick={() => void navigator.clipboard.writeText(l.url).then(() => toast("已複製"))}
          >
            <Copy />
          </button>
          <a
            href={l.url}
            target="_blank"
            rel="noreferrer"
            aria-label="開啟公開頁"
            className="text-ink-soft"
          >
            <External />
          </a>
          <button
            type="button"
            className="text-[13px] font-semibold text-danger"
            onClick={() =>
              window.confirm("停用這個連結？已經分享出去的人將無法再開啟。") &&
              act(() => api("DELETE", `/v1/trips/${tripId}/share-links/${l.id}`), "已停用")
            }
          >
            停用
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked={hideLodging}
            onChange={(e) => setHideLodging(e.target.checked)}
          />
          隱藏住宿
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked={journalOnly}
            onChange={(e) => setJournalOnly(e.target.checked)}
          />
          只公開心得
        </label>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            act(
              () =>
                api("POST", `/v1/trips/${tripId}/share-links`, {
                  body: { hideLodging, journalOnly },
                }),
              "已建立分享連結",
            )
          }
        >
          建立分享連結
        </Button>
      </div>
    </section>
  );
}

function ViewerToggle({ trip }: { trip: TripDetail }) {
  const toast = useToast();
  const qc = useQueryClient();
  const on = trip.viewerCanWriteJournal !== false;
  return (
    <label className="flex items-center gap-2 text-sm text-ink-soft">
      <input
        type="checkbox"
        className="size-4"
        checked={on}
        onChange={async (e) => {
          try {
            await api("PATCH", `/v1/trips/${trip.id}`, {
              body: { viewerCanWriteJournal: e.target.checked },
              ifMatch: trip.version,
            });
            void qc.invalidateQueries({ queryKey: keys.trip(trip.id) });
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        }}
      />
      檢視者也可以寫自己的心得
    </label>
  );
}

function JournalPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const { me } = useAuth();
  const trip = useTrip(tripId);
  useTripEvents(tripId);
  const journal = useQuery({
    queryKey: ["journal", tripId],
    queryFn: async () =>
      (await api<{ entries: JournalEntry[] }>("GET", `/v1/trips/${tripId}/journal`)).entries,
  });
  const notes = useQuery({
    queryKey: ["notes", tripId],
    queryFn: async () => (await api<{ notes: Note[] }>("GET", `/v1/trips/${tripId}/notes`)).notes,
  });
  const t = trip.data;
  if (!t || !journal.data) return <p className="p-10 text-center text-sm text-muted">載入中…</p>;
  const entries = journal.data;
  const pending = (dayId: string) =>
    (notes.data ?? []).filter(
      (n) => n.dayId === dayId && n.author.userId === me?.id && !n.mergedIntoEntryId,
    ).length;

  return (
    <>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[860px] items-center gap-4 px-5 py-4 sm:px-7">
          <Link
            href={`/trips/${tripId}`}
            aria-label="回到行程"
            className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft"
          >
            <ChevronLeft />
          </Link>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-muted">{t.title}</span>
            <h1 className="text-[22px] font-bold">心得</h1>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-[860px] flex-col gap-8 px-5 py-7 sm:px-7">
        {t.myRole === "owner" && (
          <>
            <SharePanel tripId={tripId} />
            <ViewerToggle trip={t} />
          </>
        )}
        <Section
          trip={t}
          label="整趟旅程"
          target={{ scope: "trip" }}
          entries={entries.filter((e) => e.scope === "trip")}
          pendingNotes={0}
        />
        {t.days.map((d, i) => (
          <Section
            key={d.id}
            trip={t}
            label={`Day ${i + 1}${d.title ? `・${d.title}` : ""}`}
            sub={formatDay(d.date, "long")}
            target={{ scope: "day", dayId: d.id }}
            entries={entries.filter((e) => e.dayId === d.id)}
            pendingNotes={pending(d.id)}
          />
        ))}
      </main>
    </>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <JournalPage />
      </AppShell>
    </RequireAuth>
  );
}
