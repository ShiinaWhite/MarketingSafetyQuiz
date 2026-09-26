#!/usr/bin/env node
/* cdn_manifest_probe.js —— STARTUP_UPDATE_INSTANT_V2 Phase 5：CDN latest.json PoC 探针。
   只写 probe key（dev/probe/manifest-<ts>.json），绝不触碰真实 latest 路径
   （dev/latest.json / stable/latest.json 均不动）。
   验证：PUT → CDN GET（headers/缓存语义）→ overwrite → 再 GET（freshness）
   → query string 是否影响 cache key → TTFB/total 时延 →
   与现网 Tunnel latest（update.shiinalab.top/api/update/dev/latest）多次时延对比。
   用法：node tools/dev_update/cdn_manifest_probe.js
   退出码 0 = probe 完成（结论打印在输出里，不自动切生产）。 */
"use strict";

const https = require("https");
const http = require("http");
const cospublish = require("./cos_publish.js");
const cos = require("../cos/cos.js");

function now() { return Date.now(); }

function fetchTiming(url, redirects) {
  return new Promise((resolve) => {
    const t0 = now();
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(u, { method: "GET" }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location &&
          !(redirects > 4)) {
        res.resume();
        const t1 = now();
        fetchTiming(new URL(res.headers.location, u).href, (redirects || 0) + 1)
          .then((r) => resolve(Object.assign({}, r, { redirect: true, ttfbOfLast: r.ttfb })));
        return;
      }
      const ttfb = now() - t0;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode, ttfb, total: now() - t0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: String(e.message || e) }));
    req.setTimeout(15000, () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

async function main() {
  const loaded = cospublish.loadUpdatesConfig({});
  if (!loaded.ok) { console.log("[probe-fail] " + loaded.error); process.exit(1); }
  const config = loaded.config;
  const cdnBase = loaded.cdnBaseUrl.replace(/\/+$/, "");
  const bucket = config.bucket;
  const stamp = now();
  const key = "dev/probe/manifest-" + stamp + ".json";
  const cdnUrl = cdnBase + "/" + key;

  console.log("== CDN manifest PoC ==");
  console.log("bucket=" + bucket + " key=" + key);

  /* 1) PUT v1（no-store：期望语义 = 永不陈旧） */
  const bodyV1 = JSON.stringify({ probe: true, rev: 1, ts: stamp });
  const put1 = await cos.putObject(config, bucket, key, bodyV1,
    { contentType: "application/json", cacheControl: "no-store" });
  console.log("PUT v1(no-store): ok=" + put1.ok + " status=" + put1.status);
  if (!put1.ok) { process.exit(1); }

  /* 2) CDN GET ×3：可见性 + headers + 时延 */
  for (let i = 0; i < 3; i++) {
    const g = await fetchTiming(cdnUrl);
    console.log("GET#" + (i + 1) + " status=" + g.status +
      " ttfb=" + g.ttfb + "ms total=" + g.total + "ms" +
      " cache-control=" + (g.headers["cache-control"] || "-") +
      " age=" + (g.headers["age"] != null ? g.headers["age"] : "-") +
      " x-cache=" + (g.headers["x-cache"] || "-") +
      " bodyRev=" + (String(g.body).match(/"rev":(\d+)/) || [])[1]);
  }

  /* 3) overwrite → 立即 GET（freshness：no-store 下必须立即看到 rev=2） */
  const bodyV2 = JSON.stringify({ probe: true, rev: 2, ts: stamp });
  await cos.putObject(config, bucket, key, bodyV2,
    { contentType: "application/json", cacheControl: "no-store" });
  const g2 = await fetchTiming(cdnUrl);
  const rev2 = (String(g2.body).match(/"rev":(\d+)/) || [])[1];
  console.log("OVERWRITE→GET: status=" + g2.status + " ttfb=" + g2.ttfb + "ms" +
    " bodyRev=" + rev2 + " → " + (rev2 === "2" ? "FRESH（无陈旧）" : "STALE（CDN 缓存了旧值！）"));

  /* 4) query string 是否影响 cache key（cdnUrl + ?t=1 应同样拿到 rev=2） */
  const g3 = await fetchTiming(cdnUrl + "?t=" + stamp);
  const rev3 = (String(g3.body).match(/"rev":(\d+)/) || [])[1];
  console.log("QUERY-STRING GET: bodyRev=" + rev3 + " age=" +
    (g3.headers["age"] != null ? g3.headers["age"] : "-") +
    " → " + (rev3 === "2" ? "同 key 新值（query 不复活旧缓存）" : "query 拿到旧值/异常"));

  /* 5) 短 TTL 对比组：max-age=15 的 probe key，overwrite 后 3s 内观测 stale 窗口 */
  const keyTtl = "dev/probe/manifest-ttl-" + stamp + ".json";
  const urlTtl = cdnBase + "/" + keyTtl;
  await cos.putObject(config, bucket, keyTtl, JSON.stringify({ rev: 1 }),
    { contentType: "application/json", cacheControl: "max-age=15" });
  await cos.putObject(config, bucket, keyTtl, JSON.stringify({ rev: 2 }),
    { contentType: "application/json", cacheControl: "max-age=15" });
  const gt1 = await fetchTiming(urlTtl);
  console.log("TTL(max-age=15) overwrite→GET: bodyRev=" +
    (String(gt1.body).match(/"rev":(\d+)/) || [])[1] +
    " age=" + (gt1.headers["age"] != null ? gt1.headers["age"] : "-") +
    " （>1 即证明短 TTL 会返回陈旧 manifest → latest 不适合用 TTL）");

  /* 6) 时延对比：CDN probe key vs 现网 Tunnel latest（各 5 次） */
  const tunnelUrl = "https://update.shiinalab.top/api/update/dev/latest";
  async function sample(url, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = await fetchTiming(url + (url.indexOf("?") >= 0 ? "&" : "?") + "_p=" + now());
      out.push({ ok: r.status === 200, ttfb: r.ttfb, total: r.total });
    }
    return out;
  }
  const cdnSamples = await sample(cdnUrl, 5);
  const tunnelSamples = await sample(tunnelUrl, 5);
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log("CDN   GET×5 ttfb: " + cdnSamples.map((s) => s.ttfb).join(",") +
    "ms（median=" + med(cdnSamples.map((s) => s.ttfb)) + "ms）");
  console.log("Tunnel latest×5 ttfb: " + tunnelSamples.map((s) => s.ttfb).join(",") +
    "ms（median=" + med(tunnelSamples.map((s) => s.ttfb)) + "ms） status: " +
    tunnelSamples.map((s) => s.ok ? "200" : "fail").join(","));

  /* 7) 清理 probe keys */
  await cos.deleteObject(config, bucket, key, {});
  await cos.deleteObject(config, bucket, keyTtl, {});
  const gone = await fetchTiming(cdnUrl);
  console.log("CLEANUP: probe keys deleted; GET after delete status=" + gone.status +
    "（404 = 未污染 CDN 缓存层）");
  console.log("== probe 结束（仅调查，未切生产） ==");
}

main().catch((e) => { console.log("[probe-fail] " + String((e && e.stack) || e)); process.exit(1); });
