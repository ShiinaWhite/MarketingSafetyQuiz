/* sw.js —— 离线缓存：所有资源全部本地，无任何网络回退到外部站点 */
const CACHE = "msq-cache-v4";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/core.js",
  "js/app.js",
  "data/config.js",
  "data/questions.js",
  "data/questions.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 题库数据需先运行 tools/import_xlsx.py 生成，新克隆仓库中可能不存在，
    // 逐项添加并容忍缺失，保证 Service Worker 本体总能安装成功
    await Promise.all(ASSETS.map((a) => cache.add(a).catch(() => { })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 缓存优先；仅缓存同源 GET 请求，绝不请求第三方 */
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) { return; }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) { return hit; }
      return fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      }).catch(() => caches.match("./"));
    })
  );
});
