"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { LogoPin } from "@/components/icons";
import { Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";

interface RequestInfo {
  id: string;
  client: {
    name: string;
    uri: string | null;
    logoUri: string | null;
    verifiedDomain: string | null;
  };
  redirectHost: string;
  scopes: { scope: string; label: string }[];
}

/** MCP（OAuth）授權同意頁。 */
function Consent() {
  const params = useSearchParams();
  const id = params.get("request") ?? "";
  const { me } = useAuth();
  const info = useQuery({
    queryKey: ["oauth-request", id],
    queryFn: () => api<RequestInfo>("GET", `/v1/oauth/requests/${id}`),
    retry: false,
    enabled: !!id,
  });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopes = chosen ?? info.data?.scopes.map((s) => s.scope) ?? [];

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirectTo: string }>("POST", `/v1/oauth/requests/${id}/decision`, {
        body: { approve, scopes },
      });
      window.location.href = res.redirectTo;
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <main className="flex w-full max-w-[440px] flex-col gap-5 rounded-2xl border border-line bg-white px-8 py-9">
        <LogoPin className="mx-auto size-10 text-accent" />
        {info.isLoading && <p className="text-center text-sm text-muted">載入中…</p>}
        {info.isError && <p className="text-center">{errorMessage(info.error)}</p>}
        {info.data && (
          <>
            <div className="flex flex-col gap-1 text-center">
              <h1 className="text-xl font-bold">{info.data.client.name} 想要存取你的 Travelog</h1>
              <span className="text-sm text-muted">
                {info.data.client.verifiedDomain
                  ? `由 ${info.data.client.verifiedDomain} 提供・`
                  : ""}
                授權後會回到 {info.data.redirectHost}
              </span>
            </div>
            <fieldset className="flex flex-col gap-2 rounded-xl bg-canvas p-4">
              <legend className="sr-only">授權範圍</legend>
              {info.data.scopes.map((s) => (
                <label key={s.scope} className="flex items-start gap-2.5 text-[15px]">
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    checked={scopes.includes(s.scope)}
                    disabled={s.scope === "trips:read"}
                    onChange={(e) =>
                      setChosen(
                        e.target.checked
                          ? [...scopes, s.scope]
                          : scopes.filter((x) => x !== s.scope),
                      )
                    }
                  />
                  {s.label}
                </label>
              ))}
            </fieldset>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted">
              <li>它會以你（{me?.displayName}）的身分操作，權限和你在每趟行程的角色相同。</li>
              <li>它不能修改已訂位／已購票的行程點、不能邀請成員或刪除行程。</li>
              <li>它做的修改都會記在活動紀錄，可以一鍵復原；也可以隨時在帳號設定撤銷授權。</li>
            </ul>
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={busy}
                onClick={() => decide(false)}
              >
                拒絕
              </Button>
              <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
                允許
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <Suspense>
        <Consent />
      </Suspense>
    </RequireAuth>
  );
}
