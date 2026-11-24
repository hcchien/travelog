import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ApiError,
  api,
  clearSession,
  getRefreshToken,
  OfflineError,
  refreshSession,
  saveSession,
  setSignedOutHandler,
} from "./api";
import { unregisterPush } from "./push";
import { assertSession, bindSessionUser, sessionScope } from "./session";
import { clearAll, readJson, writeJson } from "./storage";
import type { Me } from "./types";

type Status = "loading" | "signedOut" | "signedIn";

interface AuthState {
  status: Status;
  me: Me | null;
  /** 啟動時連不上伺服器：使用快取資料。 */
  offline: boolean;
  signInWithGoogle(): Promise<void>;
  signInSandbox(name: string): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const ME_KEY = "me";

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "",
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);

  const loadMe = useCallback(async () => {
    const before = sessionScope();
    const m = await api<Me>("GET", "/v1/me");
    assertSession(before);
    bindSessionUser(m.id);
    const scope = sessionScope();
    await writeJson(ME_KEY, m, scope);
    assertSession(scope);
    setMe(m);
    setOffline(false);
    setStatus("signedIn");
  }, []);

  const reset = useCallback(async () => {
    setMe(null);
    setStatus("loading");
    const clearing = clearSession(); // Invalidates in-flight API/refresh/outbox work synchronously.
    await queryClient.cancelQueries();
    queryClient.clear();
    await clearing;
    await clearAll();
    setStatus("signedOut");
  }, [queryClient]);

  useEffect(() => {
    setSignedOutHandler(() => {
      void reset();
    });
    (async () => {
      if (!(await getRefreshToken())) return setStatus("signedOut");
      try {
        await refreshSession();
        await loadMe();
      } catch (e) {
        if (e instanceof OfflineError) {
          // 離線開啟：用上次的帳號資料，行程與今日頁讀快取
          const cached = await readJson<Me>(ME_KEY);
          if (!cached) return setStatus("signedOut");
          bindSessionUser(cached.id);
          setMe(cached);
          setOffline(true);
          setStatus("signedIn");
        } else {
          await reset();
        }
      }
    })();
  }, [loadMe, reset]);

  const exchange = useCallback(
    async (idToken: string) => {
      await reset();
      const scope = sessionScope();
      const tokens = await api<{ accessToken: string; refreshToken: string }>(
        "POST",
        "/v1/auth/google/native",
        {
          body: { idToken },
          auth: false,
        },
      );
      assertSession(scope);
      await saveSession(tokens, scope);
      await loadMe();
    },
    [loadMe, reset],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      me,
      offline,
      async signInWithGoogle() {
        await GoogleSignin.hasPlayServices();
        const res = await GoogleSignin.signIn();
        if (!isSuccessResponse(res)) return; // 使用者取消
        const idToken = res.data.idToken;
        if (!idToken) throw new Error("Google 沒有回傳 ID token，請確認 webClientId 設定");
        await exchange(idToken);
      },
      async signInSandbox(name: string) {
        // 只對 pnpm sandbox 的假 Google 有效
        const sub = `sandbox-app-${Array.from(name)
          .map((ch) => ch.codePointAt(0)?.toString(16))
          .join("")
          .slice(0, 40)}`;
        await exchange(`sandbox|${sub}|${name}|`);
      },
      async signOut() {
        const refreshToken = await getRefreshToken();
        await unregisterPush().catch(() => {});
        if (refreshToken) {
          await api("POST", "/v1/auth/logout", { body: { refreshToken }, auth: false }).catch(
            () => {},
          );
        }
        await GoogleSignin.signOut().catch(() => {});
        await reset();
      },
      async deleteAccount() {
        await api("DELETE", "/v1/me", { body: { confirm: "DELETE" } });
        await GoogleSignin.revokeAccess().catch(() => {});
        await reset();
      },
    }),
    [status, me, offline, exchange, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth 必須在 AuthProvider 內使用");
  return v;
}

export { ApiError };
