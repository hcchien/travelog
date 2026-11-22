"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ChevronLeft, Copy } from "@/components/icons";
import { useToast } from "@/components/toast";
import { Avatar, Button, cx, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { keys, useTrip } from "@/lib/queries";
import type { Activity, Invitation, TripRole } from "@/lib/types";

const ROLE_LABEL: Record<TripRole, string> = {
  owner: "擁有者",
  editor: "編輯者",
  viewer: "檢視者",
};

const ACTION_LABEL: Record<string, string> = {
  "trip.created": "建立了行程",
  "trip.updated": "修改了行程設定",
  "trip.ownership_transferred": "轉移了擁有權",
  "item.created": "新增了行程點",
  "item.updated": "修改了行程點",
  "item.moved": "移動了行程點",
  "item.deleted": "刪除了行程點",
  "item.confirmed": "釘選了行程點",
  "item.unconfirmed": "解除了行程點的確定",
  "booking.created": "新增了訂位",
  "booking.updated": "修改了訂位",
  "wishlist.added": "加入想去清單",
  "wishlist.scheduled": "把想去的地方排進行程",
  "invitation.created": "建立了邀請",
  "member.joined": "加入了行程",
  "member.left": "離開了行程",
  "member.removed": "移除了成員",
  "member.role_changed": "變更了成員身分",
};
const VIA: Record<Activity["via"], string> = {
  web: "Web",
  app: "App",
  mcp: "MCP",
  ai_assistant: "AI 助理",
};

function MembersPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const trip = useTrip(tripId);
  const role = trip.data?.myRole;
  const canInvite = role === "owner" || role === "editor";
  const isOwner = role === "owner";

  const invitations = useQuery({
    queryKey: ["invitations", tripId],
    queryFn: async () =>
      (await api<{ invitations: Invitation[] }>("GET", `/v1/trips/${tripId}/invitations`))
        .invitations,
    enabled: canInvite,
  });
  const activity = useQuery({
    queryKey: ["activity", tripId],
    queryFn: async () =>
      (await api<{ activity: Activity[] }>("GET", `/v1/trips/${tripId}/activity?limit=30`))
        .activity,
  });

  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [expires, setExpires] = useState<"7" | "30" | "never">("7");
  const [link, setLink] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
    void qc.invalidateQueries({ queryKey: ["invitations", tripId] });
    void qc.invalidateQueries({ queryKey: ["activity", tripId] });
  };

  async function attempt(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const createInvite = (withEmail?: string) =>
    attempt(async () => {
      const res = await api<Invitation>("POST", `/v1/trips/${tripId}/invitations`, {
        body: {
          role: inviteRole,
          expiresInDays: expires === "never" ? null : Number(expires),
          ...(withEmail ? { email: withEmail } : {}),
        },
      });
      if (withEmail) {
        setEmail("");
        toast(`已邀請 ${withEmail}`);
      } else {
        setLink(res.url ?? null);
      }
    });

  if (!trip.data) return <p className="p-10 text-center text-sm text-muted">載入中…</p>;
  const t = trip.data;

  return (
    <>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-5 py-4 sm:px-7">
          <Link
            href={`/trips/${tripId}`}
            aria-label="回到行程"
            className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft"
          >
            <ChevronLeft />
          </Link>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-muted">{t.title}</span>
            <h1 className="text-[22px] font-bold">成員與分享</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-wrap items-start gap-6 px-5 py-7 sm:px-7">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {canInvite && (
            <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white px-6 py-5">
              <div>
                <h2 className="text-lg font-bold">邀請旅伴</h2>
                <p className="text-sm text-muted">對方用 Google 或 Apple 帳號登入後就會加入。</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <fieldset className="flex min-w-0 flex-[1_1_160px] flex-col gap-1.5">
                  <legend className="mb-1.5 text-[13px] font-semibold text-ink-soft">
                    加入後的身分
                  </legend>
                  <div className="flex gap-1.5">
                    {(["editor", "viewer"] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={inviteRole === r}
                        onClick={() => {
                          setInviteRole(r);
                          setLink(null);
                        }}
                        className={cx(
                          "h-11 flex-1 rounded-lg border text-sm font-semibold",
                          inviteRole === r
                            ? "border-brand bg-brand-soft text-brand"
                            : "border-line-strong bg-white text-ink-soft",
                        )}
                      >
                        {ROLE_LABEL[r]}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <Field label="連結有效期限" className="min-w-0 flex-[1_1_160px]">
                  {(id) => (
                    <Select
                      id={id}
                      value={expires}
                      onChange={(e) => setExpires(e.target.value as typeof expires)}
                    >
                      <option value="7">7 天</option>
                      <option value="30">30 天</option>
                      <option value="never">不限期</option>
                    </Select>
                  )}
                </Field>
              </div>
              {link ? (
                <div className="flex flex-wrap gap-2.5">
                  <div className="flex h-12 min-w-0 flex-[1_1_300px] items-center overflow-hidden rounded-lg border border-line bg-canvas px-3.5 font-mono text-sm text-ink-soft">
                    <span className="truncate">{link}</span>
                  </div>
                  <Button
                    onClick={async () => {
                      await navigator.clipboard.writeText(link);
                      toast("已複製邀請連結");
                    }}
                  >
                    <Copy />
                    複製連結
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="self-start"
                  disabled={busy}
                  onClick={() => createInvite()}
                >
                  產生邀請連結
                </Button>
              )}
              <div className="h-px bg-line" />
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email) void createInvite(email);
                }}
              >
                <label htmlFor="invite-email" className="text-[13px] font-semibold text-ink-soft">
                  或用 email 邀請
                </label>
                <div className="flex flex-wrap gap-2.5">
                  <Input
                    id="invite-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="friend@gmail.com"
                    className="min-w-0 flex-[1_1_260px]"
                  />
                  <Button type="submit" variant="secondary" disabled={busy || !email}>
                    寄出邀請
                  </Button>
                </div>
                <span className="text-[13px] text-muted">
                  對方若用 Apple「隱藏我的電子郵件」登入，email 會對不上，請改傳上面的連結。
                </span>
              </form>
            </section>
          )}

          <section className="flex flex-col rounded-2xl border border-line bg-white px-6 py-5">
            <h2 className="mb-2 text-lg font-bold">成員（{t.members.length}）</h2>
            {t.members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center gap-3 border-b border-[#eef0f3] py-2.5 last:border-0"
              >
                <Avatar name={m.displayName} size={40} />
                <strong className="min-w-0 flex-1 text-[15px]">
                  {m.displayName}
                  {m.userId === me?.id && "（你）"}
                </strong>
                {isOwner && m.role !== "owner" ? (
                  <>
                    <Select
                      aria-label={`${m.displayName}的身分`}
                      className="h-9 w-auto text-sm"
                      value={m.role}
                      disabled={busy}
                      onChange={(e) =>
                        attempt(
                          () =>
                            api("PATCH", `/v1/trips/${tripId}/members/${m.userId}`, {
                              body: { role: e.target.value },
                            }),
                          "已變更身分",
                        )
                      }
                    >
                      <option value="editor">編輯者</option>
                      <option value="viewer">檢視者</option>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`把擁有權轉移給 ${m.displayName}？你會變成編輯者。`)) {
                          void attempt(
                            () =>
                              api("POST", `/v1/trips/${tripId}/transfer-ownership`, {
                                body: { userId: m.userId },
                              }),
                            "已轉移擁有權",
                          );
                        }
                      }}
                    >
                      設為擁有者
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`把 ${m.displayName} 移出這趟行程？`)) {
                          void attempt(
                            () => api("DELETE", `/v1/trips/${tripId}/members/${m.userId}`),
                            "已移除成員",
                          );
                        }
                      }}
                    >
                      移除
                    </Button>
                  </>
                ) : (
                  <span className="rounded-lg bg-canvas px-3 py-1.5 text-sm font-semibold text-ink-soft">
                    {ROLE_LABEL[m.role]}
                  </span>
                )}
              </div>
            ))}
            {role !== "owner" && (
              <Button
                variant="danger"
                size="sm"
                className="mt-4 self-start"
                onClick={async () => {
                  if (!window.confirm("確定要離開這趟行程？")) return;
                  try {
                    await api("DELETE", `/v1/trips/${tripId}/members/${me?.id}`);
                    router.replace("/trips");
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  }
                }}
              >
                離開這趟行程
              </Button>
            )}
          </section>

          {canInvite && (invitations.data?.length ?? 0) > 0 && (
            <section className="flex flex-col rounded-2xl border border-line bg-white px-6 py-5">
              <h2 className="mb-2 text-lg font-bold">尚未使用的邀請</h2>
              {invitations.data?.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center gap-3 border-b border-[#eef0f3] py-2.5 text-sm last:border-0"
                >
                  <span className="min-w-0 flex-1">
                    {inv.email ?? "邀請連結"}・{ROLE_LABEL[inv.role]}
                    <span className="block text-xs text-muted">
                      {inv.expiresAt
                        ? `${new Date(inv.expiresAt).toLocaleDateString("zh-TW")} 到期`
                        : "不限期"}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      attempt(
                        () => api("DELETE", `/v1/trips/${tripId}/invitations/${inv.id}`),
                        "已撤回邀請",
                      )
                    }
                  >
                    撤回
                  </Button>
                </div>
              ))}
            </section>
          )}
        </div>

        <aside className="flex min-w-0 max-w-[400px] flex-[1_1_320px] flex-col gap-3 rounded-2xl border border-line bg-white p-5">
          <h2 className="text-[17px] font-bold">最近活動</h2>
          {activity.data?.length === 0 && <p className="text-sm text-muted">還沒有活動</p>}
          {activity.data?.map((a) => (
            <div key={a.id} className="flex items-start gap-2.5 text-sm leading-relaxed">
              <span
                className={cx(
                  "mt-0.5 flex-none rounded-md px-1.5 py-0.5 text-xs font-bold",
                  a.via === "mcp" || a.via === "ai_assistant"
                    ? "bg-brand-soft text-brand"
                    : "bg-canvas text-ink-soft",
                )}
              >
                {VIA[a.via]}
              </span>
              <span>
                <strong>{a.actorName ?? "已刪除的使用者"}</strong>{" "}
                {ACTION_LABEL[a.action] ?? a.action}
                {typeof a.diff?.title === "string" && `「${a.diff.title}」`}
                <span className="block text-[13px] text-muted">
                  {new Date(a.createdAt).toLocaleString("zh-TW", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
              </span>
            </div>
          ))}
        </aside>
      </main>
    </>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <MembersPage />
      </AppShell>
    </RequireAuth>
  );
}
