import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { color } from "@/components/ui";
import { AuthProvider, useAuth } from "@/lib/auth";
import { flushOutbox, startOutboxSync } from "@/lib/outbox";
import { onNotificationOpen, registerForPush } from "@/lib/push";

function Background({ qc }: { qc: QueryClient }) {
  const { status, offline } = useAuth();
  useEffect(() => {
    if (status !== "signedIn") return;
    const refresh = (tripId: string) =>
      void qc.invalidateQueries({ queryKey: ["snapshot", tripId] });
    const stopSync = startOutboxSync(refresh);
    void flushOutbox(refresh);
    if (!offline) registerForPush().catch((e) => console.warn("推播註冊失敗", e));
    const stopOpen = onNotificationOpen((path) => router.push(path as never));
    return () => {
      stopSync();
      stopOpen();
    };
  }, [status, offline, qc]);
  return null;
}

export default function RootLayout() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <Background qc={qc} />
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: color.navy },
              headerTintColor: color.white,
              headerTitleStyle: { fontWeight: "700" },
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: color.canvas },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="trips/index" options={{ title: "我的行程" }} />
            <Stack.Screen name="trips/[tripId]/index" options={{ title: "" }} />
            <Stack.Screen name="trips/[tripId]/today" options={{ title: "今日" }} />
            <Stack.Screen name="trips/[tripId]/journal" options={{ title: "心得" }} />
            <Stack.Screen name="settings" options={{ title: "帳號設定" }} />
          </Stack>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
