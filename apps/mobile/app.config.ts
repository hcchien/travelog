import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Travelog App（M7）。原生模組（Google Sign-In、推播）需要 development build，不能用 Expo Go：
 *   pnpm --filter @travelog/mobile ios   或   eas build --profile development
 * 環境變數（EXPO_PUBLIC_* 會打包進 App）：
 *   EXPO_PUBLIC_API_ORIGIN           API 網址，例如 https://api.dev.example.com
 *   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID Google OAuth「網頁」用戶端 ID（ID token 的 aud）
 *   EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID Google OAuth iOS 用戶端 ID
 *   EXPO_PUBLIC_SANDBOX_LOGIN=1      顯示沙盒登入（只對 pnpm sandbox 有效）
 *   EAS_PROJECT_ID                   推播需要的 EAS 專案 ID
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
  // Google Sign-In 的 iOS URL scheme 是反轉的 client ID
  const iosUrlScheme = iosClientId
    ? iosClientId.split(".").reverse().join(".")
    : "com.googleusercontent.apps.unset";
  const bundleId = process.env.APP_BUNDLE_ID ?? "app.travelog.dev";
  return {
    ...config,
    name: "Travelog",
    slug: "travelog",
    scheme: "travelog",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: false,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSLocationWhenInUseUsageDescription: "記筆記時可以附上目前位置",
      },
    },
    android: {
      package: bundleId,
      permissions: ["ACCESS_COARSE_LOCATION", "POST_NOTIFICATIONS"],
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      ["expo-notifications", { color: "#16263D" }],
      ["@react-native-google-signin/google-signin", { iosUrlScheme }],
      ["expo-splash-screen", { backgroundColor: "#16263D" }],
    ],
    experiments: { typedRoutes: false },
    extra: {
      eas: { projectId: process.env.EAS_PROJECT_ID },
    },
  };
};
