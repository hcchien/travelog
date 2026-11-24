"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Key, LogoPin } from "@/components/icons";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const ERRORS: Record<string, string> = {
  state: "登入逾時，請再試一次",
  google: "Google 登入失敗，請再試一次",
};

function safeReturnTo(v: string | null) {
  return v?.startsWith("/") && !v.startsWith("//") && !v.includes("\\") && !/[\u0000-\u0020\u007f]/.test(v) ? v : "/trips";
}

function LoginForm() {
  const { status, loginWithPasskey, googleLoginUrl } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const [error, setError] = useState<string | null>(ERRORS[params.get("error") ?? ""] ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace(returnTo);
  }, [status, router, returnTo]);

  async function passkey() {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
    } catch (e) {
      // 使用者取消系統對話框時不顯示錯誤
      if (e instanceof Error && e.name === "NotAllowedError") return;
      setError(e instanceof Error && !("status" in e) ? "Passkey 登入失敗" : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="w-full max-w-[400px] rounded-2xl border border-line bg-white px-9 py-10">
      <div className="flex flex-col items-center gap-3.5">
        <LogoPin className="size-10 text-accent" />
        <h1 className="text-2xl font-bold">登入 Travelog</h1>
      </div>
      <div className="mt-7 flex flex-col gap-3">
        <button
          type="button"
          onClick={passkey}
          disabled={busy}
          className="flex h-13 items-center justify-center gap-2.5 rounded-xl bg-brand text-base font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
        >
          <Key />
          使用 Passkey 登入
        </button>
        <div className="my-1 flex items-center gap-3 text-[13px] text-muted">
          <span className="h-px flex-1 bg-line" />或<span className="h-px flex-1 bg-line" />
        </div>
        <a
          href={googleLoginUrl(returnTo)}
          className="flex h-13 items-center justify-center gap-3 rounded-xl border border-[#c9cfd8] bg-white text-base font-semibold text-ink hover:bg-canvas"
        >
          <span
            aria-hidden
            className="flex size-[22px] items-center justify-center rounded-full border border-dashed border-[#8a94a3] text-[11px] text-muted"
          >
            G
          </span>
          使用 Google 帳號繼續
        </a>
        <button
          type="button"
          disabled
          title="即將推出"
          className="flex h-13 items-center justify-center gap-3 rounded-xl bg-black text-base font-semibold text-white opacity-50"
        >
          <span
            aria-hidden
            className="flex size-[22px] items-center justify-center rounded-md border border-dashed border-[#8a94a3] text-[11px]"
          >
            A
          </span>
          使用 Apple 帳號繼續（即將推出）
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <p className="mt-7 text-center text-[13px] leading-relaxed text-muted">
        第一次使用請選 Google 或 Apple 建立帳號
        <br />
        繼續即表示你同意{" "}
        <Link href="/terms" className="text-brand">
          服務條款
        </Link>{" "}
        與{" "}
        <Link href="/privacy" className="text-brand">
          隱私權政策
        </Link>
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
