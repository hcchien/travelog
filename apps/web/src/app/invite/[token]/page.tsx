"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { LogoPin } from "@/components/icons";
import { Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRange } from "@/lib/time";

interface Preview {
  trip: { id: string; title: string; startDate: string; endDate: string };
  role: "editor" | "viewer";
  invitedBy: string;
  status: "valid" | "expired" | "revoked" | "used";
  email: string | null;
}

const ROLE = { editor: "編輯者", viewer: "檢視者" };
const STATUS = {
  expired: "這個邀請已過期",
  revoked: "這個邀請已被撤回",
  used: "這個邀請已經被使用",
};

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { status, googleLoginUrl, me } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api<Preview>("GET", `/v1/invitations/${token}`),
    retry: false,
  });

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ tripId: string }>("POST", `/v1/invitations/${token}/accept`);
      router.replace(`/trips/${res.tripId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const p = preview.data;
  const returnTo = `/invite/${token}`;
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <main className="w-full max-w-[420px] rounded-2xl border border-line bg-white px-8 py-9">
        <LogoPin className="mx-auto size-10 text-accent" />
        {preview.isLoading && <p className="mt-6 text-center text-sm text-muted">載入中…</p>}
        {preview.isError && (
          <p className="mt-6 text-center">找不到這個邀請，請向朋友確認連結是否正確。</p>
        )}
        {p && (
          <div className="mt-6 flex flex-col gap-5">
            <div className="rounded-xl bg-[#fdebdd] px-4 py-3.5 text-[15px] leading-relaxed text-pin-ink">
              <strong>{p.invitedBy}</strong> 邀請你以「{ROLE[p.role]}」身分加入
              <br />
              <strong className="text-lg">{p.trip.title}</strong>
              <span className="block text-sm">{formatRange(p.trip.startDate, p.trip.endDate)}</span>
            </div>
            {p.email && <p className="text-sm text-muted">這個邀請只限 {p.email} 使用。</p>}
            {p.status !== "valid" ? (
              <p className="text-center font-semibold text-danger">{STATUS[p.status]}</p>
            ) : status === "authenticated" ? (
              <>
                <Button onClick={accept} disabled={busy}>
                  以 {me?.displayName} 加入行程
                </Button>
                <Link href="/trips" className="text-center text-sm text-muted">
                  先不要
                </Link>
              </>
            ) : status === "anonymous" ? (
              <div className="flex flex-col gap-3">
                <Link
                  href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
                  className="flex h-12 items-center justify-center rounded-xl bg-brand font-semibold text-white"
                >
                  登入後加入
                </Link>
                <a
                  href={googleLoginUrl(returnTo)}
                  className="flex h-12 items-center justify-center rounded-xl border border-line-strong font-semibold"
                >
                  使用 Google 帳號繼續
                </a>
              </div>
            ) : null}
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
