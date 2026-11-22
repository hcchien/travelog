"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { API_ORIGIN, api, refreshAccessToken, setAccessToken } from "./api";
import type { Me } from "./types";

type Status = "loading" | "authenticated" | "anonymous";

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

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/v1/me"));
      setStatus("authenticated");
    } catch {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  const reload = useCallback(async () => {
    const token = await refreshAccessToken();
    if (!token) {
      setMe(null);
      setStatus("anonymous");
      return;
    }
    await loadMe();
  }, [loadMe]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loginWithPasskey = useCallback(async () => {
    const { challengeId, options } = await api<{ challengeId: string; options: never }>(
      "POST",
      "/v1/auth/passkey/login/options",
    );
    const response = await startAuthentication({ optionsJSON: options });
    const { accessToken } = await api<{ accessToken: string }>(
      "POST",
      "/v1/auth/passkey/login/verify",
      {
        body: { challengeId, client: "web", response },
      },
    );
    setAccessToken(accessToken);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    await api("POST", "/v1/auth/logout", { body: {} }).catch(() => {});
    setAccessToken(null);
    setMe(null);
    setStatus("anonymous");
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      loginWithPasskey,
      logout,
      reload,
      googleLoginUrl: (returnTo = "/trips") =>
        `${API_ORIGIN}/v1/auth/google?returnTo=${encodeURIComponent(returnTo)}`,
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

/** 需要登入的頁面：未登入時導到登入頁，登入後回到原頁。 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "anonymous") router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);
  if (status !== "authenticated") {
    return <div className="p-10 text-center text-sm text-muted">載入中…</div>;
  }
  return <>{children}</>;
}
