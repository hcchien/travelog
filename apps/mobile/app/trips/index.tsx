import { Link, Redirect, router, Stack } from "expo-router";
import { useEffect } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { Card, color, Loading, Muted, s } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { prefetchUpcoming, useTrips } from "@/lib/queries";
import { formatDay } from "@/lib/time";

export default function Trips() {
  const { status } = useAuth();
  const trips = useTrips();
  useEffect(() => {
    if (trips.data && !trips.data.offline) void prefetchUpcoming(trips.data.data);
  }, [trips.data]);
  if (status === "signedOut") return <Redirect href="/login" />;
  if (trips.isLoading) return <Loading />;

  const today = new Date().toISOString().slice(0, 10);
  const list = [...(trips.data?.data ?? [])].sort((a, b) => {
    const pa = a.endDate < today ? 1 : 0;
    const pb = b.endDate < today ? 1 : 0;
    return (
      pa - pb ||
      (pa ? b.startDate.localeCompare(a.startDate) : a.startDate.localeCompare(b.startDate))
    );
  });

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" style={{ color: color.white, fontSize: 16 }}>
              設定
            </Link>
          ),
        }}
      />
      {trips.data?.offline && (
        <Text
          style={{
            backgroundColor: color.accent,
            color: color.white,
            padding: 8,
            textAlign: "center",
          }}
        >
          離線中，顯示上次的資料
        </Text>
      )}
      {trips.error && (
        <Text style={{ padding: 16, color: color.danger }}>{errorMessage(trips.error)}</Text>
      )}
      <FlatList
        contentContainerStyle={s.content}
        data={list}
        keyExtractor={(t) => t.id}
        refreshControl={
          <RefreshControl refreshing={trips.isRefetching} onRefresh={() => void trips.refetch()} />
        }
        ListEmptyComponent={<Muted>還沒有行程。請先在網站建立行程，或請旅伴邀請你。</Muted>}
        renderItem={({ item: t }) => {
          const ongoing = t.startDate <= today && today <= t.endDate;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(ongoing ? `/trips/${t.id}/today` : `/trips/${t.id}`)}
            >
              <Card style={{ gap: 4, opacity: t.endDate < today ? 0.7 : 1 }}>
                {ongoing && (
                  <Text style={{ color: color.accent, fontWeight: "700", fontSize: 13 }}>
                    旅行中
                  </Text>
                )}
                <Text style={[s.title, { fontSize: 18 }]}>{t.title}</Text>
                <Muted>
                  {formatDay(t.startDate)} – {formatDay(t.endDate)}
                  {t.destinations.length ? `・${t.destinations.map((d) => d.name).join("、")}` : ""}
                </Muted>
              </Card>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
