import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { ItemRow } from "@/components/ItemRow";
import { Button, Card, color, Loading, Muted, s } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAttachments } from "@/lib/attachments";
import { useSnapshot } from "@/lib/queries";
import { formatDay, todayIn } from "@/lib/time";

/** 行程表（App 以查看為主；規劃與編輯在網站）。 */
export default function TripScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const snap = useSnapshot(tripId);
  const files = useAttachments(tripId);
  const [picked, setPicked] = useState<string | null>(null);
  const data = snap.data?.data;
  const day = useMemo(() => {
    if (!data) return undefined;
    const today = todayIn(data.trip.primaryTz);
    return (
      data.trip.days.find((d) => d.id === picked) ??
      data.trip.days.find((d) => d.date === today) ??
      data.trip.days[0]
    );
  }, [data, picked]);

  if (snap.isLoading) return <Loading />;
  if (!data || !day)
    return <Text style={{ padding: 16, color: color.danger }}>{errorMessage(snap.error)}</Text>;
  const items = data.items.filter((i) => i.dayId === day.id);
  const unscheduled = data.items.filter((i) => !i.dayId);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: data.trip.title }} />
      {snap.data?.offline && (
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
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={snap.isRefetching} onRefresh={() => void snap.refetch()} />
        }
      >
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button
            title="今日"
            style={{ flex: 1 }}
            onPress={() => router.push(`/trips/${tripId}/today`)}
          />
          <Button
            title="心得"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => router.push(`/trips/${tripId}/journal`)}
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6 }}
        >
          {data.trip.days.map((d, i) => (
            <Pressable
              key={d.id}
              accessibilityRole="button"
              accessibilityState={{ selected: d.id === day.id }}
              onPress={() => setPicked(d.id)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 999,
                backgroundColor: d.id === day.id ? color.navy : color.white,
                borderWidth: 1,
                borderColor: color.line,
              }}
            >
              <Text
                style={{ color: d.id === day.id ? color.white : color.inkSoft, fontWeight: "600" }}
              >
                Day {i + 1}・{formatDay(d.date)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {day.title ? <Text style={s.h2}>{day.title}</Text> : null}
        {items.length === 0 ? (
          <Muted>這天沒有安排行程。</Muted>
        ) : (
          <Card style={{ padding: 0, overflow: "hidden" }}>
            {items.map((it) => (
              <ItemRow
                key={it.id}
                tripId={tripId}
                item={it}
                attachments={(files.data ?? []).filter((a) => a.itemId === it.id)}
              />
            ))}
          </Card>
        )}
        {unscheduled.length > 0 && (
          <>
            <Text style={s.h2}>未排入</Text>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              {unscheduled.map((it) => (
                <ItemRow key={it.id} tripId={tripId} item={it} attachments={[]} />
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}
