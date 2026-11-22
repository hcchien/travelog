"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Key, Trash } from "@/components/icons";
import { useToast } from "@/components/toast";
import { Avatar, Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import type { Passkey } from "@/lib/types";

function SettingsPage() {
  const { me, logout } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => (await api<{ passkeys: Passkey[] }>("GET", "/v1/me/passkeys")).passkeys,
  });

  async function addPasskey() {
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>(
        "POST",
        "/v1/auth/passkey/register/options",
      );
      const response = await startRegistration({ optionsJSON: options });
      const name =
        window.prompt("幫這把 Passkey 取個名字（例如：MacBook、iPhone）", "Passkey") ?? "Passkey";
      await api("POST", "/v1/auth/passkey/register/verify", {
        body: { challengeId, response, name: name.trim() || "Passkey" },
      });
      toast("已新增 Passkey，下次可以一鍵登入");
      void qc.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (e) {
      if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return;
      if (e instanceof Error && e.name === "InvalidStateError") {
        toast("這個裝置已經有 Passkey 了", "info");
        return;
      }
      toast(errorMessage(e), "error");
    }
  }

  if (!me) return null;
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-8">
      <h1 className="text-3xl font-bold">帳號設定</h1>

      <section className="flex items-center gap-4 rounded-2xl border border-line bg-white p-5">
        <Avatar name={me.displayName} size={56} />
        <div className="flex flex-col gap-0.5">
          <strong className="text-lg">{me.displayName}</strong>
          <span className="text-sm text-muted">{me.primaryEmail}</span>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5">
        <h2 className="text-lg font-bold">登入方式</h2>
        {me.identities.map((i) => (
          <div
            key={i.id}
            className="flex items-center justify-between rounded-lg bg-canvas px-4 py-3 text-sm"
          >
            <strong>{i.provider === "google" ? "Google" : "Apple"}</strong>
            <span className="text-muted">{i.isPrivateRelay ? "隱藏的電子郵件" : i.email}</span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Passkey</h2>
            <p className="text-sm text-muted">
              用指紋、臉部辨識或裝置密碼一鍵登入，不需要再經過 Google。
            </p>
          </div>
          <Button size="sm" onClick={addPasskey}>
            <Key className="size-4" />
            新增 Passkey
          </Button>
        </div>
        {passkeys.data?.length === 0 && <p className="text-sm text-muted">還沒有 Passkey。</p>}
        {passkeys.data?.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-lg bg-canvas px-4 py-3 text-sm"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <strong>{p.name}</strong>
              <span className="text-xs text-muted">
                建立於 {new Date(p.createdAt).toLocaleDateString("zh-TW")}
                {p.lastUsedAt && `・上次使用 ${new Date(p.lastUsedAt).toLocaleDateString("zh-TW")}`}
                {p.backedUp && "・已同步"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const name = window.prompt("新名稱", p.name);
                if (!name?.trim()) return;
                await api("PATCH", `/v1/me/passkeys/${p.id}`, {
                  body: { name: name.trim() },
                }).catch((e) => toast(errorMessage(e), "error"));
                void qc.invalidateQueries({ queryKey: ["passkeys"] });
              }}
            >
              重新命名
            </Button>
            <button
              type="button"
              aria-label={`刪除 ${p.name}`}
              onClick={async () => {
                if (!window.confirm(`刪除「${p.name}」？之後在那台裝置要改用 Google 登入。`))
                  return;
                await api("DELETE", `/v1/me/passkeys/${p.id}`);
                void qc.invalidateQueries({ queryKey: ["passkeys"] });
              }}
              className="text-muted hover:text-danger"
            >
              <Trash />
            </button>
          </div>
        ))}
      </section>

      <Button
        variant="secondary"
        className="self-start"
        onClick={async () => {
          await logout();
          router.replace("/login");
        }}
      >
        登出
      </Button>
    </main>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <SettingsPage />
      </AppShell>
    </RequireAuth>
  );
}
