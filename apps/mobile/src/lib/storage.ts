import Storage from "@react-native-async-storage/async-storage";

/** 本機快取（AsyncStorage）：離線時讀取。不用 expo-sqlite，避免 drizzle-orm 的選用 peer 把 Expo 拉進 API 映像檔。 */
export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await Storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown) {
  await Storage.setItem(key, JSON.stringify(value));
}

export async function removeKey(key: string) {
  await Storage.removeItem(key);
}

/** 登出時清除所有快取。 */
export async function clearAll() {
  await Storage.clear();
}
