import { Redirect } from "expo-router";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { Button, color, s } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const SANDBOX = process.env.EXPO_PUBLIC_SANDBOX_LOGIN === "1";

export default function Login() {
  const { status, signInWithGoogle, signInSandbox } = useAuth();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  if (status === "signedIn") return <Redirect href="/trips" />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert("登入失敗", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: color.navy }}
    >
      <View style={[s.center, { gap: 16 }]}>
        <Text style={{ fontSize: 34, fontWeight: "800", color: color.white }}>Travelog</Text>
        <Text style={{ color: "#C5CEDB", marginBottom: 24 }}>和旅伴一起規劃、記錄每一趟旅程</Text>
        <Button
          title="使用 Google 帳號繼續"
          onPress={() => run(signInWithGoogle)}
          busy={busy}
          style={{ alignSelf: "stretch" }}
        />
        {SANDBOX && (
          <View style={{ alignSelf: "stretch", gap: 8, marginTop: 24 }}>
            <Text style={{ color: "#C5CEDB" }}>沙盒登入（只對 pnpm sandbox 有效）</Text>
            <TextInput
              accessibilityLabel="名字"
              placeholder="名字"
              value={name}
              onChangeText={setName}
              style={s.input}
            />
            <Button
              title="沙盒登入"
              variant="secondary"
              disabled={!name.trim()}
              onPress={() => run(() => signInSandbox(name.trim()))}
            />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
