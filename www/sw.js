/* sw.js —— 离线缓存：资源全部本地，无任何外部网络请求。
   策略：network-first（有网时永远取最新资源并更新缓存），断网时回退缓存，
   兼顾「完全离线可用」与「版本升级后不再跑到旧代码」。 */
const CACHE = "msq-cache-v18";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/core.js",
  "js/app.js",
  "data/config.js",
  "data/questions.js",
  "data/questions.json",
  "data/explanations.js",
  "data/explanations.json",
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

/* 仅处理同源 GET：network-first，失败回退缓存（离线） */
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) { return; }
  e.respondWith(
    fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return resp;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("./"))
    )
  );
});
