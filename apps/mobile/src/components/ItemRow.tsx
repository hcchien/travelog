import * as WebBrowser from "expo-web-browser";
import { Alert, Linking, Pressable, Text, View } from "react-native";
import { api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/time";
import type { Attachment, Item } from "@/lib/types";
import { Chip, color, s, TYPE_LABEL } from "./ui";

export function mapsUrl(it: Item) {
  const p = it.place;
  if (!p) return null;
  const qs = new URLSearchParams({
    api: "1",
    destination: p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : p.name,
  });
  qs.set("destination_place_id", p.googlePlaceId);
  return `https://www.google.com/maps/dir/?${qs}`;
}

async function openAttachment(tripId: string, a: Attachment) {
  try {
    const { url } = await api<{ url: string }>(
      "GET",
      `/v1/trips/${tripId}/attachments/${a.id}/download`,
    );
    await WebBrowser.openBrowserAsync(url);
  } catch (e) {
    Alert.alert("無法開啟", errorMessage(e));
  }
}

export function ItemRow({
  tripId,
  item,
  attachments,
  done,
  current,
}: {
  tripId: string;
  item: Item;
  attachments: Attachment[];
  done?: boolean;
  current?: boolean;
}) {
  const nav = mapsUrl(item);
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#EEF0F3",
        backgroundColor: current ? "#FFF6EF" : item.confirmed ? color.pinBg : color.white,
      }}
    >
      <Text
        style={{
          width: 46,
          fontWeight: done ? "400" : "600",
          color: done ? color.muted : color.ink,
        }}
      >
        {formatTime(item.startAt, item.tz) || "—"}
      </Text>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[s.title, done && { color: color.muted, textDecorationLine: "line-through" }]}>
          {item.title}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <Chip label={TYPE_LABEL[item.type] ?? item.type} />
          {item.confirmed && <Chip label="📌 已確定" tone="pin" />}
        </View>
        {item.booking?.confirmationCode ? (
          <Text selectable style={{ color: color.inkSoft }}>
            訂位代號{" "}
            <Text style={{ fontWeight: "700", fontFamily: "Menlo" }}>
              {item.booking.confirmationCode}
            </Text>
          </Text>
        ) : null}
        {item.place?.address ? <Text style={s.muted}>{item.place.address}</Text> : null}
        {attachments.map((a) => (
          <Pressable key={a.id} accessibilityRole="link" onPress={() => openAttachment(tripId, a)}>
            <Text style={{ color: color.brand, fontWeight: "600" }}>📄 {a.filename}</Text>
          </Pressable>
        ))}
      </View>
      {nav && (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`導航到 ${item.title}`}
          onPress={() => Linking.openURL(nav)}
        >
          <Text style={{ color: color.brand, fontWeight: "600" }}>導航</Text>
        </Pressable>
      )}
    </View>
  );
}
