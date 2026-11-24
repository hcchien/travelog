"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  api,
  bindSessionUser,
  sessionScope,
  sameSession,
  SessionChangedError,
  getAccessToken,
  lastRefreshOffline,
  refreshAccessToken,
  setAccessToken,
} from "./api";
import { bindTokenGetter } from "./live";
import type { Me } from "./types";

type Status = "loading" | "authenticated" | "anonymous" | "offline";

bindTokenGetter(getAccessToken);
const ME_KEY = "travelog:me";

interface AuthContextValue {
  status: Status;
  me: Me | null;
  loginWithPasskey: () => Promise<void>;
  googleLoginUrl: (returnTo?: string) => string;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const queryClient = useQueryClient();

  const reset = useCallback(async () => {
    setAccessToken(null);
    setMe(null);
    setStatus("anonymous");
    const scope = sessionScope();
    await queryClient.cancelQueries();
    if (!sameSession(scope)) return;
    queryClient.clear();
    try {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("travelog:")) localStorage.removeItem(key);
    } catch {}
  }, [queryClient]);

  const loadMe = useCallback(async () => {
    try {
      const m = await api<Me>("GET", "/v1/me");
      if (sessionScope().userId !== m.id) {
        bindSessionUser(m.id);
        const scope = sessionScope();
        await queryClient.cancelQueries();
        queryClient.clear();
        if (!sameSession(scope)) return;
      }
      setMe(m);
      setStatus("authenticated");
      try {
        localStorage.setItem(ME_KEY, JSON.stringify(m));
      } catch {}
    } catch (error) {
      if (!(error instanceof SessionChangedError)) await reset();
    }
  }, [queryClient, reset]);

  const reload = useCallback(async () => {
    const token = await refreshAccessToken();
    if (!token) {
      // 沒有網路時，用上次的使用者資料進入離線模式
      const cached = lastRefreshOffline ? localStorage.getItem(ME_KEY) : null;
      if (cached) {
        const user = JSON.parse(cached) as Me;
        bindSessionUser(user.id);
        setMe(user);
        setStatus("offline");
        return;
      }
      await reset();
      return;
    }
    await loadMe();
  }, [loadMe, reset]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loginWithPasskey = useCallback(async () => {
    const { challengeId, options } = await api<{ challengeId: string; options: never }>(
      "POST",
      "/v1/auth/passkey/login/options",
    );
    const response = await startAuthentication({ optionsJSON: options });
    const { accessToken } = await api<{
      accessToken: string;
      refreshToken?: string;
    }>("POST", "/v1/auth/passkey/login/verify", {
      body: { challengeId, client: "web", response },
    });
    setAccessToken(accessToken);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    const logout = api("POST", "/v1/auth/logout", { body: {} }).catch(() => {});
    await reset();
    await logout;
  }, [reset]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      loginWithPasskey,
      logout,
      reload,
      googleLoginUrl: (returnTo = "/trips") =>
        `/session/google?returnTo=${encodeURIComponent(returnTo)}`,
    }),
    [status, me, loginWithPasskey, logout, reload],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** 需要登入的頁面：未登入時導到登入頁，登入後回到原頁。offlineOk：離線時仍可顯示。 */
export function RequireAuth({
  children,
  offlineOk,
}: {
  children: React.ReactNode;
  offlineOk?: boolean;
}) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "anonymous") router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);
  if (status === "offline") {
    if (offlineOk) return <>{children}</>;
    return (
      <div className="p-10 text-center text-sm text-muted">
        目前沒有網路。可以在行程的「今日」頁面查看已下載的行程。
      </div>
    );
  }
  if (status !== "authenticated") {
    return <div className="p-10 text-center text-sm text-muted">載入中…</div>;
  }
  return <>{children}</>;
}
