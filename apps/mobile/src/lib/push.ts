import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";
import { readJson, removeKey, writeJson } from "./storage";

const TOKEN_KEY = "push.token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** 取得推播權限並把 Expo 推播權杖註冊到 API。模擬器或沒有 EAS 專案 ID 時略過。 */
export async function registerForPush() {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!Device.isDevice || !projectId) return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "行程更新",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api("POST", "/v1/me/push-tokens", {
    body: { token, platform: Platform.OS === "ios" ? "ios" : "android" },
  });
  await writeJson(TOKEN_KEY, token);
}

export async function unregisterPush() {
  const token = await readJson<string>(TOKEN_KEY);
  if (!token) return;
  await api("DELETE", "/v1/me/push-tokens", { body: { token } });
  await removeKey(TOKEN_KEY);
}

/** 點通知時開啟對應頁面（通知 data.path，例如 /trips/<id>/today）。 */
export function onNotificationOpen(open: (path: string) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const path = r.notification.request.content.data?.path;
    if (typeof path === "string" && path.startsWith("/trips/")) open(path);
  });
  return () => sub.remove();
}
