import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { ItemRow, mapsUrl } from "@/components/ItemRow";
import { NoteSheet } from "@/components/NoteSheet";
import { Button, Card, color, Loading, Muted, s } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAttachments } from "@/lib/attachments";
import { type PendingNote, subscribeOutbox } from "@/lib/outbox";
import { useSnapshot } from "@/lib/queries";
import { formatDay, formatTime, todayIn, zoned } from "@/lib/time";

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function Today() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const qc = useQueryClient();
  const snap = useSnapshot(tripId);
  const files = useAttachments(tripId);
  const now = useNow();
  const [noting, setNoting] = useState(false);
  const [pending, setPending] = useState<PendingNote[]>([]);
  useEffect(
    () => subscribeOutbox((l) => setPending(l.filter((n) => n.tripId === tripId))),
    [tripId],
  );
  // 佇列送完時重新整理
  useEffect(() => {
    if (pending.length === 0) void qc.invalidateQueries({ queryKey: ["snapshot", tripId] });
  }, [pending.length, qc, tripId]);

  const data = snap.data?.data;
  const tz = data?.trip.primaryTz ?? "Asia/Taipei";
  const todayDate = todayIn(tz);
  const day = useMemo(
    () => data?.trip.days.find((d) => d.date === todayDate) ?? data?.trip.days[0],
    [data, todayDate],
  );

  if (snap.isLoading) return <Loading />;
  if (!data || !day) {
    return (
      <View style={s.center}>
        <Text style={s.body}>{errorMessage(snap.error)}</Text>
        <Muted>連上網路後打開一次這趟行程，就會存下離線資料。</Muted>
      </View>
    );
  }

  const index = data.trip.days.indexOf(day);
  const isToday = day.date === todayDate;
  const items = data.items.filter((i) => i.dayId === day.id);
  const next = isToday ? items.find((i) => i.startAt && new Date(i.startAt) > now) : undefined;
  const order = (id: string | null) => data.trip.days.findIndex((d) => d.id === id);
  const lodging = data.items
    .filter((i) => i.type === "stay" && i.dayId && order(i.dayId) <= index)
    .sort((a, b) => order(b.dayId) - order(a.dayId))[0];
  const notes = data.notes.filter((n) => n.dayId === day.id);
  const myPending = pending.filter((n) => n.dayId === day.id);
  const nav = next ? mapsUrl(next) : null;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: `Day ${index + 1}・${formatDay(day.date)}` }} />
      {snap.data?.offline && (
        <Text
          style={{
            backgroundColor: color.accent,
            color: color.white,
            padding: 8,
            textAlign: "center",
          }}
        >
          離線中・{snap.data.at ? new Date(snap.data.at).toLocaleString("zh-TW") : ""} 的資料
        </Text>
      )}
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={snap.isRefetching} onRefresh={() => void snap.refetch()} />
        }
      >
        {isToday && <Muted>當地時間 {zoned(now, tz).time}</Muted>}
        {next && (
          <Card style={{ gap: 10 }}>
            <Text style={{ color: color.pinInk, fontWeight: "700" }}>
              下一站・{formatTime(next.startAt, next.tz)}
            </Text>
            <Text style={{ fontSize: 22, fontWeight: "700", color: color.ink }}>{next.title}</Text>
            {next.place?.address ? <Muted>{next.place.address}</Muted> : null}
            {nav && <Button title="開始導航" onPress={() => Linking.openURL(nav)} />}
          </Card>
        )}

        <Text style={s.h2}>{isToday ? "今天的行程" : "這天的行程"}</Text>
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
                done={isToday && !!it.startAt && new Date(it.endAt ?? it.startAt) < now}
                current={it.id === next?.id}
              />
            ))}
          </Card>
        )}

        {lodging && (
          <Card style={{ gap: 4 }}>
            <Text style={{ color: "#5B3A8C", fontWeight: "700" }}>今晚住宿</Text>
            <Text style={s.title}>{lodging.title}</Text>
            {lodging.place?.address ? <Muted>{lodging.place.address}</Muted> : null}
            {lodging.booking?.confirmationCode ? (
              <Text selectable style={s.body}>
                訂位代號{" "}
                <Text style={{ fontWeight: "700" }}>{lodging.booking.confirmationCode}</Text>
              </Text>
            ) : null}
          </Card>
        )}

        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <Text style={s.h2}>筆記</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push(`/trips/${tripId}/journal`)}
          >
            <Text style={{ color: color.brand, fontWeight: "600" }}>整理成心得 →</Text>
          </Pressable>
        </View>
        {myPending.map((n) => (
          <Card key={n.key} style={{ gap: 2, borderStyle: "dashed" }}>
            <Muted>{formatTime(n.takenAt, tz)}・等待同步</Muted>
            <Text style={s.body}>{n.body}</Text>
          </Card>
        ))}
        {notes.map((n) => (
          <Card key={n.id} style={{ gap: 2 }}>
            <Muted>
              {formatTime(n.takenAt, tz)} {n.author.displayName}
            </Muted>
            <Text style={s.body}>{n.body}</Text>
          </Card>
        ))}
        {notes.length + myPending.length === 0 && (
          <Muted>還沒有筆記。按右下角的按鈕隨手記一筆。</Muted>
        )}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新增快速筆記"
        onPress={() => setNoting(true)}
        style={{
          position: "absolute",
          right: 20,
          bottom: 34,
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: color.accent,
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOpacity: 0.2,
          shadowRadius: 8,
          elevation: 4,
        }}
      >
        <Text style={{ color: color.white, fontSize: 26 }}>✎</Text>
      </Pressable>
      <NoteSheet tripId={tripId} dayId={day.id} open={noting} onClose={() => setNoting(false)} />
    </View>
  );
}
