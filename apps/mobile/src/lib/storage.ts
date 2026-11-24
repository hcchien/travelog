import Storage from "@react-native-async-storage/async-storage";
import { sameSession, sessionScope } from "./session";

type Scope = ReturnType<typeof sessionScope>;
const keyFor = (key: string, scope: Scope) =>
  key === "me" ? "travelog:me" : `travelog:${scope.userId ?? "anonymous"}:${key}`;
let writes: Promise<unknown> = Promise.resolve();
function ordered<T>(action: () => Promise<T>): Promise<T> {
  const work = writes.then(action, action);
  writes = work.catch(() => {});
  return work;
}
export async function readJson<T>(key: string, scope = sessionScope()): Promise<T | null> {
  try {
    await writes;
    const raw = await Storage.getItem(keyFor(key, scope));
    return sameSession(scope) && raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export async function writeJson(key: string, value: unknown, scope = sessionScope()) {
  await ordered(async () => {
    if (sameSession(scope)) await Storage.setItem(keyFor(key, scope), JSON.stringify(value));
  });
}
export async function removeKey(key: string, scope = sessionScope()) {
  await ordered(() => Storage.removeItem(keyFor(key, scope)));
}
export async function clearAll() {
  await ordered(() => Storage.clear());
}
