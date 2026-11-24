import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text, TextInput, View } from "react-native";
import { Button, Card, color, Muted, s } from "@/components/ui";
import { API_ORIGIN, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Settings() {
  const { me, signOut, deleteAccount } = useAuth();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function remove() {
    Alert.alert("永久刪除帳號？", "刪除後無法復原。", [
      { text: "取消", style: "cancel" },
      {
        text: "刪除",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await deleteAccount();
            router.replace("/login");
          } catch (e) {
            Alert.alert("無法刪除", errorMessage(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Card style={{ gap: 4 }}>
        <Text style={s.title}>{me?.displayName}</Text>
        {me?.primaryEmail ? <Muted>{me.primaryEmail}</Muted> : null}
      </Card>
      <Button
        title="登出"
        variant="secondary"
        onPress={async () => {
          await signOut();
          router.replace("/login");
        }}
      />
      <Card style={{ gap: 10, borderColor: "#F2C4BF" }}>
        <Text style={[s.title, { color: color.danger }]}>刪除帳號</Text>
        <Text style={s.body}>
          你自己的心得、筆記、地點庫與登入方式會被刪除。你擁有、且還有其他旅伴的行程會轉給旅伴；只有你一個人的行程會整趟刪除。
        </Text>
        <Text style={s.body}>請輸入 DELETE 確認：</Text>
        <TextInput
          accessibilityLabel="輸入 DELETE 確認"
          autoCapitalize="characters"
          autoCorrect={false}
          value={confirm}
          onChangeText={setConfirm}
          style={s.input}
        />
        <Button
          title="刪除帳號"
          variant="danger"
          disabled={confirm !== "DELETE"}
          busy={busy}
          onPress={remove}
        />
      </Card>
      <View style={{ alignItems: "center", marginTop: 12 }}>
        <Muted>API：{API_ORIGIN}</Muted>
      </View>
    </ScrollView>
  );
}
