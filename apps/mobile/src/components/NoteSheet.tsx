import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { queueNote } from "@/lib/outbox";
import { Button, color, s } from "./ui";

/** 快速筆記：先放進離線佇列，有網路時自動送出。 */
export function NoteSheet({
  tripId,
  dayId,
  open,
  onClose,
}: {
  tripId: string;
  dayId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await queueNote({ tripId, dayId, body: body.trim() });
      setBody("");
      onClose();
    } catch (e) {
      Alert.alert("無法儲存", e instanceof Error ? e.message : "請再試一次");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable accessibilityLabel="關閉" style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: color.white,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: 20,
            gap: 12,
          }}
        >
          <Text style={[s.title, { fontSize: 18 }]}>快速筆記</Text>
          <TextInput
            accessibilityLabel="筆記內容"
            autoFocus
            multiline
            maxLength={2000}
            value={body}
            onChangeText={setBody}
            placeholder="例如：這家抹茶冰淇淋超好吃"
            style={[s.input, { minHeight: 110, textAlignVertical: "top" }]}
          />
          <Text style={s.muted}>沒有網路也可以記，連上網路後會自動同步。</Text>
          <Button title="記下" onPress={save} busy={busy} disabled={!body.trim()} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
