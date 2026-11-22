import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

export const color = {
  navy: "#16263D",
  brand: "#1F5FAD",
  brandSoft: "#E8F0FA",
  accent: "#E8762D",
  canvas: "#F5F6F8",
  ink: "#1B2430",
  inkSoft: "#46505E",
  muted: "#6B7686",
  line: "#E3E6EB",
  pinBg: "#FFF4E8",
  pinInk: "#A4510F",
  danger: "#C0392B",
  white: "#FFFFFF",
};

export const TYPE_LABEL: Record<string, string> = {
  transport: "交通",
  stay: "住宿",
  food: "餐廳",
  sight: "景點",
  activity: "活動",
  shopping: "購物",
  other: "其他",
};

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg =
    variant === "primary" ? color.brand : variant === "danger" ? color.danger : color.white;
  const fg = variant === "secondary" ? color.ink : color.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === "secondary" && s.secondary,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Chip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "pin" | "brand";
}) {
  const bg = tone === "pin" ? "#FBE3C9" : tone === "brand" ? color.brandSoft : color.canvas;
  const fg = tone === "pin" ? color.pinInk : tone === "brand" ? color.brand : color.inkSoft;
  return (
    <View style={[s.chip, { backgroundColor: bg }]}>
      <Text style={[s.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.brand} />
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 16, gap: 14, paddingBottom: 120 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  button: {
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  secondary: { borderWidth: 1, borderColor: "#D5DAE1" },
  buttonText: { fontSize: 16, fontWeight: "600" },
  card: {
    backgroundColor: color.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: color.line,
    padding: 16,
  },
  chip: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" },
  chipText: { fontSize: 12, fontWeight: "700" },
  muted: { color: color.muted, fontSize: 14 },
  h1: { fontSize: 24, fontWeight: "700", color: color.ink },
  h2: { fontSize: 16, fontWeight: "700", color: color.inkSoft },
  title: { fontSize: 16, fontWeight: "600", color: color.ink },
  body: { fontSize: 15, color: color.ink, lineHeight: 22 },
  input: {
    borderWidth: 1,
    borderColor: "#D5DAE1",
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    backgroundColor: color.white,
    color: color.ink,
  },
});
