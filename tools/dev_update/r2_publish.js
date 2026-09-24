#!/usr/bin/env node
/* r2_publish.js —— DEV APK 的 R2 发布逻辑（R2_FAST_TRANSFER_V1）

   设计要点（任务书第 9/10 节）：
   - APK 对象 key 按 versionCode 唯一：apk/dev/vc<N>/MarketingSafetyQuiz-dev-vc<N>.apk
     → 内容永不修改，因此可以 immutable 长缓存；也绝不复用会覆盖的 app.apk/latest.apk
   - 发布验证**不再重新下载整个 52MB**：
       PutObject → HeadObject（Content-Length + metadata.sha256/versionCode）
                → Custom Domain 轻量 HEAD + 前 1MB Range GET 与本地字节比对
     真正手机 OTA 下载后仍由 UpdatePlugin 做完整 SHA256/包名/versionCode/签名校验，
     所以客户端安全门禁一点没降。
   - prune：保留最新 N 个 vc，绝不删除当前 latest 指向的版本；
     不用「30 天无条件删除」的 Lifecycle（那可能删掉长期未更新时仍在用的 latest）。
   - 顺序不变：APK 先可用，latest.json 最后才原子更新。任何失败都让 latest 指向旧版本。 */

"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");

const APK_PREFIX = "apk/dev";
const DEFAULT_KEEP_COUNT = 3;
const DEFAULT_DOMAIN = "download.shiinalab.top";
/* APK 内容按 versionCode 唯一且永不修改 → 可以长缓存 immutable */
const APK_CACHE_CONTROL = "public, max-age=31536000, immutable";
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
/* Custom Domain 轻量验证读取的字节数：足够证明「公网确实在发这个对象」 */
const SMOKE_RANGE_BYTES = 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* 对象 key：每个 versionCode 一个唯一路径（禁止覆盖式固定名） */
function apkObjectKey(versionCode) {
  const vc = Number(versionCode);
  return APK_PREFIX + "/vc" + vc + "/MarketingSafetyQuiz-dev-vc" + vc + ".apk";
}

function apkFileName(versionCode) {
  const vc = Number(versionCode);
  return "MarketingSafetyQuiz-dev-vc" + vc + ".apk";
}

/* 规范化下载域：显式 scheme 原样保留（测试指向本地 http mock），
   否则补 https —— 生产域名 download.shiinalab.top 永远走 https。 */
function normalizeDomain(domain) {
  const raw = String(domain || DEFAULT_DOMAIN).replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) { return raw; }
  return "https://" + raw;
}

/* 公网下载地址（Custom Domain，不经 Tunnel） */
function apkPublicUrl(domain, versionCode) {
  return normalizeDomain(domain) + "/" + apkObjectKey(versionCode);
}

/* 从对象列表里提取 { versionCode, key, size }，按 vc 降序 */
function parseApkVersions(contents) {
  const out = [];
  for (const c of contents || []) {
    const m = /^apk\/dev\/vc(\d+)\//.exec(c.key || "");
    if (!m) { continue; }
    out.push({ versionCode: Number(m[1]), key: c.key, size: c.size });
  }
  out.sort(function (a, b) { return b.versionCode - a.versionCode; });
  return out;
}

/* ---- Custom Domain 轻量探测（绝不整包下载） ---- */

function domainRequest(url, options) {
  const o = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      method: o.method || "GET",
      path: u.pathname + u.search,
      headers: o.headers || {},
      timeout: o.timeoutMs || 30_000,
      agent: false
    }, function (res) {
      if (o.abortAfterBytes) {
        /* 只读前 N 字节就断开：证明公网在发这个对象，又不付 52MB 的代价 */
        const chunks = [];
        let total = 0;
        res.on("data", function (c) {
          const room = o.abortAfterBytes - total;
          if (room > 0) { chunks.push(room >= c.length ? c : c.slice(0, room)); total += Math.min(room, c.length); }
          if (total >= o.abortAfterBytes) {
            res.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          }
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", function () {
          /* destroy() 触发的 error 在已凑够字节时忽略 */
          if (total >= o.abortAfterBytes) { return; }
          reject(new Error("stream error"));
        });
        return;
      }
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

/* Custom Domain 验证：HEAD 拿元数据 + Range GET 前 1MB 与本地字节比对。
   返回 { ok, head, range, cacheStatus, checkedBytes, error } */
async function verifyCustomDomain(domain, versionCode, localBytes, options) {
  const o = options || {};
  const base = normalizeDomain(domain);
  const url = base + "/" + apkObjectKey(versionCode);
  const result = { ok: false, url: url, error: null, cacheStatus: null, checkedBytes: 0 };

  let head;
  try {
    head = await domainRequest(url, { method: "HEAD", timeoutMs: o.timeoutMs || 30_000 });
  } catch (e) {
    result.error = "domain HEAD failed: " + (e && e.message);
    return result;
  }
  result.head = {
    status: head.status,
    contentLength: Number(head.headers["content-length"] || 0),
    contentType: head.headers["content-type"] || null,
    cacheControl: head.headers["cache-control"] || null,
    acceptRanges: head.headers["accept-ranges"] || null,
    etag: head.headers["etag"] || null
  };
  result.cacheStatus = head.headers["cf-cache-status"] || null;
  if (head.status !== 200) {
    result.error = "domain HEAD status " + head.status;
    return result;
  }
  if (result.head.contentLength !== localBytes.length) {
    result.error = "domain content-length mismatch: " + result.head.contentLength +
      " != " + localBytes.length;
    return result;
  }

  /* Range GET 前 1MB：即使 CDN 忽略 Range 返回 200，也只读 1MB 就断开 */
  const n = Math.min(SMOKE_RANGE_BYTES, localBytes.length);
  let range;
  try {
    range = await domainRequest(url, {
      method: "GET",
      headers: { Range: "bytes=0-" + (n - 1) },
      abortAfterBytes: n,
      timeoutMs: o.timeoutMs || 30_000
    });
  } catch (e) {
    result.error = "domain range GET failed: " + (e && e.message);
    return result;
  }
  if (range.status !== 206 && range.status !== 200) {
    result.error = "domain range GET status " + range.status;
    return result;
  }
  result.range = {
    status: range.status,
    contentRange: range.headers["content-range"] || null,
    bytes: range.body.length
  };
  if (range.body.length !== n) {
    result.error = "domain smoke read short: " + range.body.length + " < " + n;
    return result;
  }
  if (Buffer.compare(range.body, localBytes.slice(0, n)) !== 0) {
    result.error = "domain smoke bytes differ from local APK";
    return result;
  }
  result.checkedBytes = n;
  result.ok = true;
  return result;
}

/* ---- 上传 + HeadObject 验证 ---- */

async function uploadApk(client, config, spec) {
  const key = apkObjectKey(spec.versionCode);
  /* 一致性闸门：声明的 sha256 必须等于真实字节的 sha256。
     否则 payload hash 与 manifest 会指向不同内容——宁可在这里失败，
     也不要上传一份与 latest.json 声明不符的 APK。 */
  const actualSha = sha256Hex(spec.apkBytes);
  if (actualSha !== spec.sha256) {
    return {
      ok: false, stage: "precheck",
      error: "declared sha256 does not match APK bytes (" +
        String(spec.sha256).slice(0, 12) + "… != " + actualSha.slice(0, 12) + "…)"
    };
  }
  const metadata = {
    sha256: spec.sha256,
    versioncode: String(spec.versionCode),
    versionname: spec.versionName,
    packagename: spec.packageName
  };
  const put = await client.putObject(config, config.downloadBucket, key, spec.apkBytes, {
    contentType: APK_CONTENT_TYPE,
    cacheControl: APK_CACHE_CONTROL,
    contentDisposition: 'attachment; filename="' + apkFileName(spec.versionCode) + '"',
    metadata: metadata,
    payloadHash: spec.sha256
  });
  if (!put.ok) {
    return { ok: false, stage: "put", status: put.status, error: put.error };
  }
  const head = await client.headObject(config, config.downloadBucket, key);
  if (!head.ok) {
    return { ok: false, stage: "head", status: head.status, error: "object not found after upload" };
  }
  if (head.size !== spec.apkBytes.length) {
    return {
      ok: false, stage: "head", error: "content-length mismatch: " + head.size +
        " != " + spec.apkBytes.length
    };
  }
  const m = head.metadata || {};
  if ((m.sha256 || "").toLowerCase() !== spec.sha256) {
    return { ok: false, stage: "head", error: "metadata.sha256 mismatch" };
  }
  if (String(m.versioncode || "") !== String(spec.versionCode)) {
    return { ok: false, stage: "head", error: "metadata.versionCode mismatch" };
  }
  if ((m.packagename || "") !== spec.packageName) {
    return { ok: false, stage: "head", error: "metadata.packageName mismatch" };
  }
  return {
    ok: true, key: key, size: head.size, contentType: head.contentType,
    cacheControl: head.cacheControl, etag: head.etag, metadata: m
  };
}

/* 完整发布 APK：上传 → R2 验证 → Custom Domain 轻量验证。
   任何一步失败都返回 ok:false（调用方必须因此不更新 latest.json）。 */
async function publishApk(deps) {
  const { client, config, domain, versionCode, versionName, packageName,
    apkBytes, sha256, verifyDomain } = deps;
  const objectKey = apkObjectKey(versionCode);
  const publicUrl = apkPublicUrl(domain, versionCode);

  const up = await uploadApk(client, config, {
    versionCode, versionName, packageName, apkBytes, sha256
  });
  if (!up.ok) {
    return { ok: false, objectKey, publicUrl, stage: up.stage, error: up.error };
  }

  /* 允许测试注入（mock 公网域）；生产走真实 HTTPS */
  const verifier = verifyDomain || function (d, vc, bytes) {
    return verifyCustomDomain(d, vc, bytes, {});
  };
  const dom = await verifier(domain, versionCode, apkBytes);
  if (!dom.ok) {
    return {
      ok: false, objectKey, publicUrl, stage: "domain",
      error: dom.error, domain: dom
    };
  }
  return {
    ok: true, objectKey, publicUrl,
    uploaded: up, domain: dom,
    verificationMethod: "R2 HeadObject + Custom Domain HEAD/1MB Range smoke（未整包下载）"
  };
}

/* ---- prune：保留最新 N 个 vc，绝不删除当前 latest 指向的版本 ---- */

async function pruneOldApks(deps) {
  const { client, config, keepCount, currentVersionCode } = deps;
  const keep = Number.isInteger(keepCount) ? keepCount : DEFAULT_KEEP_COUNT;
  const listed = await client.listAllObjects(config, config.downloadBucket, APK_PREFIX + "/");
  if (!listed.ok) {
    return { ok: false, error: "list failed", status: listed.status };
  }
  const versions = parseApkVersions(listed.contents);
  const survivors = versions.slice(0, Math.max(keep, 1));
  const survivorKeys = {};
  survivors.forEach(function (v) { survivorKeys[v.key] = true; });

  const deleted = [];
  const kept = [];
  const skipped = [];
  for (const v of versions) {
    if (survivorKeys[v.key]) { kept.push(v.key); continue; }
    /* 双保险：即使排序/数量算错，也绝不删除当前 latest 指向的版本 */
    if (v.versionCode === Number(currentVersionCode)) { kept.push(v.key); continue; }
    const del = await client.deleteObject(config, config.downloadBucket, v.key);
    if (del.ok) { deleted.push({ key: v.key, versionCode: v.versionCode }); }
    else { skipped.push({ key: v.key, error: del.error, status: del.status }); }
  }
  return {
    ok: true, keepCount: keep, total: versions.length,
    kept: kept, deleted: deleted, failedToDelete: skipped,
    latestProtected: versions.some(function (v) { return v.versionCode === Number(currentVersionCode); })
  };
}

module.exports = {
  APK_PREFIX: APK_PREFIX,
  DEFAULT_KEEP_COUNT: DEFAULT_KEEP_COUNT,
  DEFAULT_DOMAIN: DEFAULT_DOMAIN,
  APK_CACHE_CONTROL: APK_CACHE_CONTROL,
  APK_CONTENT_TYPE: APK_CONTENT_TYPE,
  SMOKE_RANGE_BYTES: SMOKE_RANGE_BYTES,
  sha256Hex: sha256Hex,
  normalizeDomain: normalizeDomain,
  apkObjectKey: apkObjectKey,
  apkFileName: apkFileName,
  apkPublicUrl: apkPublicUrl,
  parseApkVersions: parseApkVersions,
  domainRequest: domainRequest,
  verifyCustomDomain: verifyCustomDomain,
  uploadApk: uploadApk,
  publishApk: publishApk,
  pruneOldApks: pruneOldApks
};
