#!/usr/bin/env node
/* cdn_probe.js —— APK_CDN_STABILITY_DIAG_V1：CDN 冷/热基准探针（不改生产）。
   流程：COS PUT probe immutable key（与线上 vc17 同字节、短 TTL 自清理）
     → HeadObject 验证 → CDN 下载 5 次（每次记录 status/bytes/elapsed/speed/
       X-Cache-Lookup/Age + SHA256）→ COS DELETE 清理。
   不写 latest.json、不触碰发布键。probe 用 max-age=600：边缘副本 10 分钟
   自行过期（ PurgeUrlsCache 权限不可用时的自清理方案）。 */
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const r2 = require("../r2/r2.js");
const cospub = require("./cos_publish.js");

async function main() {
  const cfg = cospub.loadUpdatesConfig({});
  if (!cfg.ok) { console.error("config: " + cfg.error); process.exit(1); }
  const config = cfg.config;
  const cdnBase = cfg.cdnBaseUrl.replace(/\/+$/, "");

  const args = process.argv.slice(2);
  const preheatFlag = args.indexOf("--preheat");
  const hasPreheat = preheatFlag >= 0;
  if (hasPreheat) { args.splice(preheatFlag, 1); }
  const localApk = args[0] ||
    require("path").join(__dirname, "..", "..", "release", "营销安规刷题-DEV.apk");
  const bytes = fs.readFileSync(localApk);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  console.log("local bytes=" + bytes.length + " sha256=" + sha);

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const preheat = hasPreheat;
  const key = "dev/probe/" + (preheat ? "cdn-preheat-" : "cdn-stability-") + ts + ".apk";
  const url = cdnBase + "/" + key;
  console.log("probe key=" + key + (preheat ? " (preheat PoC)" : ""));

  /* 1) COS PUT（短 TTL：边缘 10 分钟自清理，无需 purge 权限） */
  const put = await r2.putObject(config, config.bucket, key, bytes, {
    contentType: "application/vnd.android.package-archive",
    cacheControl: "public, max-age=600",
    payloadHash: sha,
    metadata: {
      sha256: sha,
      size: String(bytes.length),
      probe: "cdn-stability-" + ts
    }
  });
  if (!put.ok) { console.error("COS PUT failed: " + JSON.stringify(put)); process.exit(1); }
  console.log("COS PUT ok etag=" + put.etag);

  /* 2) HeadObject 验证 */
  const head = await r2.headObject(config, config.bucket, key);
  if (!head.ok || head.size !== bytes.length) {
    console.error("HeadObject failed: " + JSON.stringify(head).slice(0, 300));
    process.exit(1);
  }
  console.log("HeadObject ok size=" + head.size + " cacheControl=" + head.cacheControl);

  /* 2.5) 可选：CDN URL 预热 PoC（权限被拒则如实报告 BLOCKED，不做任何扩权） */
  if (preheat) {
    const api = require("./tencent_api.js");
    const push = await api.cdnCall({ action: "PushUrlsCache", payload: { Urls: [url] } });
    const err = push.body && push.body.Response && push.body.Response.Error;
    if (err) {
      console.log("PREHEAT_POC = BLOCKED_BY_CREDENTIAL (" + err.Code + ")");
      const del0 = await r2.deleteObject(config, config.bucket, key);
      console.log("cleanup delete=" + JSON.stringify(del0.ok));
      process.exit(0);
    }
    console.log("PushUrlsCache accepted: " + JSON.stringify(push.body.Response).slice(0, 400));
    console.log("waiting 120s for preheat...");
    await new Promise((r2sl) => setTimeout(r2sl, 120000));
  }

  /* 3) CDN 下载 5 次（全量，记录 timing + 缓存头 + SHA） */
  const runs = [];
  for (let i = 1; i <= 5; i++) {
    const t0 = Date.now();
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    const runSha = crypto.createHash("sha256").update(buf).digest("hex");
    const cache = String(res.headers.get("x-cache-lookup") || "");
    const age = String(res.headers.get("age") || "");
    const rec = {
      run: i,
      status: res.status,
      bytes: buf.length,
      ms: ms,
      bytesPerSec: Math.round(buf.length * 1000 / Math.max(1, ms)),
      cacheStatus: /hit/i.test(cache) ? "HIT" : (/miss/i.test(cache) ? "MISS" : "UNKNOWN"),
      cacheRaw: cache || "(none)",
      age: age || "(none)",
      shaMatches: runSha === sha
    };
    runs.push(rec);
    console.log(JSON.stringify(rec));
    await new Promise((r2sl) => setTimeout(r2sl, 2000));
  }

  /* 4) COS DELETE 清理（源站删除；边缘副本随 10 分钟 TTL 自行过期） */
  const del = await r2.deleteObject(config, config.bucket, key);
  console.log("cleanup delete=" + JSON.stringify(del.ok));

  const speeds = runs.map((r) => r.bytesPerSec).sort((a, b) => a - b);
  console.log("SUMMARY speed(B/s): " + JSON.stringify(runs.map((r) => r.bytesPerSec)) +
    " median=" + speeds[Math.floor(speeds.length / 2)] +
    " allShaOk=" + runs.every((r) => r.shaMatches) +
    " cache=" + JSON.stringify(runs.map((r) => r.cacheStatus)));
}

main().catch(function (e) {
  console.error("probe failed:", e && e.message);
  process.exit(1);
});
