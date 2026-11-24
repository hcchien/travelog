import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Button, Card, Chip, color, Loading, Muted, s } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useJournal, useSnapshot } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import type { JournalEntry, TripDetail } from "@/lib/types";

/** 網站寫的心得若有清單、標題、粗體等格式，App 以純文字編輯會失去格式。 */
const hasFormatting = (e: JournalEntry) =>
  e.body.content.some(
    (b) => b.type !== "paragraph" || (b.content ?? []).some((n) => (n.marks?.length ?? 0) > 0),
  );

function Section({
  trip,
  label,
  dayId,
  entries,
  pendingNotes,
  offline,
}: {
  trip: TripDetail;
  label: string;
  dayId: string | null;
  entries: JournalEntry[];
  pendingNotes: number;
  offline: boolean;
}) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const mine = entries.find((e) => e.author.userId === me?.id);
  const others = entries.filter((e) => e !== mine);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["journal", trip.id] });
    void qc.invalidateQueries({ queryKey: ["snapshot", trip.id] });
  };

  const startEdit = () => {
    const go = () => {
      setText(mine?.bodyText ?? "");
      setEditing(true);
    };
    if (mine && hasFormatting(mine)) {
      Alert.alert(
        "格式會變成純文字",
        "這篇心得在網站上有清單或粗體等格式，在 App 編輯後會變成純文字。要繼續嗎？",
        [
          { text: "取消", style: "cancel" },
          { text: "繼續", onPress: go },
        ],
      );
    } else go();
  };

  async function save() {
    setBusy(true);
    try {
      if (mine) {
        await api("PATCH", `/v1/trips/${trip.id}/journal/${mine.id}`, {
          body: { version: mine.version, bodyText: text },
        });
      } else {
        await api("POST", `/v1/trips/${trip.id}/journal`, {
          body: { target: dayId ? { scope: "day", dayId } : { scope: "trip" }, bodyText: text },
        });
      }
      setEditing(false);
      refresh();
    } catch (e) {
      Alert.alert(
        "無法儲存",
        e instanceof ApiError && e.status === 412
          ? "這篇心得在別的地方改過了，請重新整理後再編輯。"
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  async function merge() {
    if (!dayId) return;
    try {
      const r = await api<{ merged: number }>("POST", `/v1/trips/${trip.id}/journal/merge-notes`, {
        body: { dayId },
      });
      Alert.alert(`已把 ${r.merged} 則筆記加進心得`);
      refresh();
    } catch (e) {
      Alert.alert("無法加入", errorMessage(e));
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={[s.title, { fontSize: 18 }]}>{label}</Text>
      {editing ? (
        <Card style={{ gap: 10 }}>
          <TextInput
            accessibilityLabel="心得內容"
            multiline
            autoFocus
            value={text}
            onChangeText={setText}
            style={[s.input, { minHeight: 160, textAlignVertical: "top" }]}
          />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              title="儲存"
              onPress={save}
              busy={busy}
              disabled={!text.trim()}
              style={{ flex: 1 }}
            />
            <Button
              title="取消"
              variant="secondary"
              onPress={() => setEditing(false)}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : mine ? (
        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Text style={{ fontWeight: "700" }}>{mine.author.displayName}（你）</Text>
            {mine.visibility === "public" && <Chip label="公開" tone="brand" />}
          </View>
          {mine.title ? <Text style={s.title}>{mine.title}</Text> : null}
          <Text style={s.body}>{mine.bodyText}</Text>
          {!offline && <Button title="編輯" variant="secondary" onPress={startEdit} />}
        </Card>
      ) : null}
      {others.map((e) => (
        <Card key={e.id} style={{ gap: 6 }}>
          <Text style={{ fontWeight: "700" }}>{e.author.displayName}</Text>
          {e.title ? <Text style={s.title}>{e.title}</Text> : null}
          <Text style={s.body}>{e.bodyText}</Text>
        </Card>
      ))}
      {!offline && !editing && (
        <View style={{ flexDirection: "row", gap: 10 }}>
          {!mine && <Button title="寫心得" onPress={startEdit} style={{ flex: 1 }} />}
          {pendingNotes > 0 && (
            <Button
              title={`加入 ${pendingNotes} 則筆記`}
              variant="secondary"
              onPress={merge}
              style={{ flex: 1 }}
            />
          )}
        </View>
      )}
      {entries.length === 0 && offline && <Muted>還沒有心得。</Muted>}
    </View>
  );
}

export default function Journal() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { me } = useAuth();
  const snap = useSnapshot(tripId);
  const journal = useJournal(tripId);
  if (snap.isLoading || journal.isLoading) return <Loading />;
  const trip = snap.data?.data.trip;
  if (!trip || !journal.data)
    return (
      <Text style={{ padding: 16, color: color.danger }}>
        {errorMessage(journal.error ?? snap.error)}
      </Text>
    );
  const entries = journal.data.data;
  const offline = journal.data.offline;
  const notes = snap.data?.data.notes ?? [];
  const canWrite =
    trip.myRole !== "viewer" ||
    (trip as TripDetail & { viewerCanWriteJournal?: boolean }).viewerCanWriteJournal !== false;
  const pending = (dayId: string) =>
    notes.filter((n) => n.dayId === dayId && n.author.userId === me?.id && !n.mergedIntoEntryId)
      .length;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { gap: 22 }]}
      refreshControl={
        <RefreshControl
          refreshing={journal.isRefetching}
          onRefresh={() => void journal.refetch()}
        />
      }
    >
      {offline && <Muted>離線中，只能閱讀。</Muted>}
      {!canWrite && <Muted>這趟行程的擁有者沒有開放檢視者寫心得。</Muted>}
      <Section
        trip={trip}
        label="整趟旅程"
        dayId={null}
        entries={entries.filter((e) => e.scope === "trip")}
        pendingNotes={0}
        offline={offline || !canWrite}
      />
      {trip.days.map((d, i) => (
        <Section
          key={d.id}
          trip={trip}
          label={`Day ${i + 1}・${formatDay(d.date)}${d.title ? ` ${d.title}` : ""}`}
          dayId={d.id}
          entries={entries.filter((e) => e.dayId === d.id)}
          pendingNotes={pending(d.id)}
          offline={offline || !canWrite}
        />
      ))}
    </ScrollView>
  );
}
