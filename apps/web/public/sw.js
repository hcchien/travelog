/* Travelog service worker（ARCHITECTURE §6.4）
 * - 靜態資源（/_next/static）：cache-first，檔名含雜湊，可以永久快取
 * - 頁面：network-first，離線時改用上次的版本（例如「今日」頁）
 * - API 不經過這裡；離線資料由頁面存在 localStorage
 */
const VERSION = "travelog-v1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.addAll(["/trips"]).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(
          async () =>
            (await caches.match(req)) ?? (await caches.match("/trips")) ?? Response.error(),
        ),
    );
  }
});
