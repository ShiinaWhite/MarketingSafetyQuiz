#!/usr/bin/env node
/* cos_publish.js —— DEV APK 的腾讯 COS + CDN 发布 provider（APK_DELIVERY_COS_CDN_VC13_V1）

   与 r2_publish.js 的关系：同一套 fail-closed 状态机思想（上传 → HeadObject 元数据
   校验 → 公网验证 → 【最后才】由 publish.js 原子写 latest.json），对象操作直接复用
   tools/r2/r2.js 的 SigV4（经 tools/cos/cos.js 适配，零新签名代码），HTTP 复用
   r2_publish.domainRequest。差异只有三点：
   - 对象 key 规范：dev/vc<N>/msq-dev-vc<N>.apk（任务书钦定，immutable，禁 latest.apk）
   - 凭据：仓库根 .env.cos.updates.local（TENCENT_COS_* 命名 → cos.js COS_* 映射）
   - 公网验证是**全量下载 + SHA256**（CDN_FULL_DOWNLOAD，任务书明确要求；r2 版是 1MB 冒烟）

   fail-closed：本模块任何函数都不写 latest.json；publishApk 失败必须让调用方
   保持 manifest 不变。 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const r2 = require("../r2/r2.js");
const cos = require("../cos/cos.js");
const r2publish = require("./r2_publish.js");

const APK_PREFIX = "dev";   /* 对象前缀；完整 key = dev/vc<N>/msq-dev-vc<N>.apk */
/* STABLE_RELEASE_PIPELINE_V1：channel-aware 对象布局。
   dev    → dev/vc<N>/msq-dev-vc<N>.apk      （历史键格式，绝不改变）
   stable → stable/v<N>/msq-stable-v<N>.apk  （独立前缀，与 /dev/ 完全隔离）
   两者都禁止 latest.apk / update.apk 等可覆盖固定名。 */
const CHANNEL_COS_PREFIX = { dev: "dev", stable: "stable" };
const CHANNEL_KEY_RE = { dev: /^dev\/vc(\d+)\//, stable: /^stable\/v(\d+)\// };

function channelCosPrefix(channel) {
  return CHANNEL_COS_PREFIX[channel === "stable" ? "stable" : "dev"];
}
const APK_CACHE_CONTROL = "public, max-age=31536000, immutable";
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
const DEFAULT_CDN_BASE_URL = "https://apk.shiinalab.top";
const UPDATES_ENV_FILE = path.join(__dirname, "..", "..", ".env.cos.updates.local");
/* CDN 全量下载上限（与 UpdateVerifier.MAX_APK_BYTES 同级，防御异常响应打爆内存/磁盘） */
const MAX_CDN_DOWNLOAD_BYTES = 150 * 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* 对象 key：每个 versionCode 一个唯一路径；ASCII 文件名（避免 URL 编码歧义）；
   禁止 app.apk / latest.apk / update.apk 等可覆盖固定名。
   channel 参数缺省 = "dev"，历史调用（apkObjectKey(13)）行为逐字节不变。 */
function apkObjectKey(versionCode, channel) {
  const vc = Number(versionCode);
  if (channel === "stable") { return "stable/v" + vc + "/msq-stable-v" + vc + ".apk"; }
  return APK_PREFIX + "/vc" + vc + "/msq-dev-vc" + vc + ".apk";
}

function apkFileName(versionCode, channel) {
  const vc = Number(versionCode);
  if (channel === "stable") { return "msq-stable-v" + vc + ".apk"; }
  return "msq-dev-vc" + vc + ".apk";
}

function normalizeCdnBase(cdnBase) {
  const raw = String(cdnBase || DEFAULT_CDN_BASE_URL).replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) { return raw; }
  return "https://" + raw;
}

function apkPublicUrl(cdnBase, versionCode, channel) {
  return normalizeCdnBase(cdnBase) + "/" + apkObjectKey(versionCode, channel);
}

/* 从对象列表提取 { versionCode, key, size }，vc 降序（prune 用）。
   channel 决定 key 模式与过滤：dev 模式绝不匹配 stable 键（反之亦然）。 */
function parseApkVersions(contents, channel) {
  const re = CHANNEL_KEY_RE[channel === "stable" ? "stable" : "dev"];
  const out = [];
  for (const c of contents || []) {
    const m = re.exec(c.key || "");
    if (!m) { continue; }
    out.push({ versionCode: Number(m[1]), key: c.key, size: c.size });
  }
  out.sort(function (a, b) { return b.versionCode - a.versionCode; });
  return out;
}

/* ---- 凭据装载：仓库根 .env.cos.updates.local（TENCENT_COS_*）→ cos.js config ----
   SecretKey 只进内存 config，绝不打印、绝不入日志/报告/JSON。 */
function loadUpdatesConfig(opts) {
  const o = opts || {};
  const envFile = o.envFile || UPDATES_ENV_FILE;
  let fileVals = {};
  try {
    fileVals = r2.parseEnvFile(fs.readFileSync(envFile, "utf8"));
  } catch (e) {
    return { ok: false, error: "missing " + envFile + "（需要 TENCENT_COS_SECRET_ID/KEY/BUCKET/REGION + APK_CDN_BASE_URL）" };
  }
  const merged = {
    COS_SECRET_ID: fileVals.TENCENT_COS_SECRET_ID,
    COS_SECRET_KEY: fileVals.TENCENT_COS_SECRET_KEY,
    COS_BUCKET: fileVals.TENCENT_COS_BUCKET,
    COS_REGION: fileVals.TENCENT_COS_REGION,
    COS_APPID: fileVals.TENCENT_COS_APPID ||
      ((fileVals.TENCENT_COS_BUCKET || "").match(/(\d{6,})$/) || [])[1] || ""
  };
  const missing = Object.keys(merged).filter(function (k) { return !merged[k]; });
  if (missing.length) {
    return { ok: false, error: "missing COS config: " + missing.join(", ") };
  }
  const config = cos.buildConfig(merged);
  return {
    ok: true,
    config: config,
    cdnBaseUrl: normalizeCdnBase(fileVals.APK_CDN_BASE_URL || o.cdnBaseUrl)
  };
}

/* ---- 上传 + HeadObject 验证（状态机与 r2_publish.uploadApk 同构） ----
   1) precheck：声明的 sha256 必须等于真实字节 sha256
   2) PUT immutable key，metadata 至少 sha256/versioncode/size（另附 versionname/packagename）
   3) HeadObject：Content-Length + 全部关键 metadata 回读一致
   任何一步失败返回 ok:false —— 调用方不得更新 latest.json。 */
async function uploadApk(client, config, spec) {
  const key = apkObjectKey(spec.versionCode, spec.channel);
  const actualSha = sha256Hex(spec.apkBytes);
  if (actualSha !== String(spec.sha256 || "").toLowerCase()) {
    return {
      ok: false, stage: "precheck",
      error: "declared sha256 does not match APK bytes (" +
        String(spec.sha256).slice(0, 12) + "… != " + actualSha.slice(0, 12) + "…)"
    };
  }
  const metadata = {
    sha256: actualSha,
    versioncode: String(spec.versionCode),
    size: String(spec.apkBytes.length),
    versionname: spec.versionName || "",
    packagename: spec.packageName || ""
  };
  const put = await client.putObject(config, config.bucket, key, spec.apkBytes, {
    contentType: APK_CONTENT_TYPE,
    cacheControl: APK_CACHE_CONTROL,
    contentDisposition: 'attachment; filename="' + apkFileName(spec.versionCode, spec.channel) + '"',
    metadata: metadata,
    payloadHash: actualSha
  });
  if (!put.ok) {
    return { ok: false, stage: "put", status: put.status, error: put.error };
  }
  const head = await client.headObject(config, config.bucket, key);
  if (!head.ok) {
    return { ok: false, stage: "head", status: head.status, error: "object not found after upload" };
  }
  if (head.size !== spec.apkBytes.length) {
    return { ok: false, stage: "head", error: "content-length mismatch: " + head.size +
      " != " + spec.apkBytes.length };
  }
  const m = head.metadata || {};
  if ((m.sha256 || "").toLowerCase() !== actualSha) {
    return { ok: false, stage: "head", error: "metadata.sha256 mismatch" };
  }
  if (String(m.versioncode || "") !== String(spec.versionCode)) {
    return { ok: false, stage: "head", error: "metadata.versionCode mismatch" };
  }
  if (String(m.size || "") !== String(spec.apkBytes.length)) {
    return { ok: false, stage: "head", error: "metadata.size mismatch" };
  }
  if (spec.packageName && (m.packagename || "") !== spec.packageName) {
    return { ok: false, stage: "head", error: "metadata.packageName mismatch" };
  }
  return { ok: true, key: key, size: head.size, etag: head.etag, metadata: m };
}

/* ---- CDN 全量下载验证（CDN_FULL_DOWNLOAD → SHA256 → size） ----
   与 r2 版的 1MB 冒烟不同：任务书要求正式发布前 CDN 公网完整下载并比对 SHA。
   node https 不自动跟随 redirect —— apkUrl 按约定是 https 直达 200；
   若出现 3xx 一律判失败（fail closed，不做通道猜测）。 */
async function verifyCdnFullDownload(cdnUrl, localBytes, options) {
  const o = options || {};
  const res = await r2publish.domainRequest(cdnUrl, {
    method: "GET",
    timeoutMs: o.timeoutMs || 120_000,
    abortAfterBytes: Math.min(localBytes.length + 1, MAX_CDN_DOWNLOAD_BYTES)
  });
  if (res.status !== 200) {
    return { ok: false, stage: "cdn", status: res.status,
      error: "CDN GET status " + res.status + "（期望 200 直达）" };
  }
  if (res.body.length !== localBytes.length) {
    return { ok: false, stage: "cdn", error: "CDN size mismatch: " + res.body.length +
      " != " + localBytes.length };
  }
  const cdnSha = sha256Hex(res.body);
  if (cdnSha !== sha256Hex(localBytes)) {
    return { ok: false, stage: "cdn", error: "CDN sha256 mismatch: " + cdnSha.slice(0, 12) + "…" };
  }
  return { ok: true, stage: "cdn", bytes: res.body.length, sha256: cdnSha };
}

/* ---- 完整发布：上传 → COS HeadObject → CDN 全量下载验证 ----
   client 可注入（mock），fetcher 可注入（测试 mock CDN / 失败注入）。 */
async function publishApk(deps) {
  const { client, config, cdnBaseUrl, versionCode, versionName, packageName,
    apkBytes, sha256, verifyCdn } = deps;
  const channel = deps.channel === "stable" ? "stable" : "dev";
  /* STP-12：packageName 必须与期望渠道包名一致（期望值来自渠道配置，
     实际值来自 aapt 实测）——不一致在上传前拒绝，绝不写入任何对象。 */
  if (deps.expectedPackageName && packageName !== deps.expectedPackageName) {
    return {
      ok: false, stage: "package",
      error: "packageName mismatch (expected " + deps.expectedPackageName +
        ", got " + packageName + ")"
    };
  }
  const objectKey = apkObjectKey(versionCode, channel);
  const publicUrl = apkPublicUrl(cdnBaseUrl, versionCode, channel);

  const up = await uploadApk(client, config, {
    versionCode, versionName, packageName, apkBytes, sha256, channel
  });
  if (!up.ok) {
    return { ok: false, objectKey, publicUrl, stage: up.stage, error: up.error };
  }
  const verifier = verifyCdn || function (url, bytes) {
    return verifyCdnFullDownload(url, bytes, {});
  };
  const cdn = await verifier(publicUrl, apkBytes);
  if (!cdn.ok) {
    return { ok: false, objectKey, publicUrl, stage: cdn.stage || "cdn",
      status: cdn.status, error: cdn.error };
  }
  return {
    ok: true, objectKey, publicUrl,
    uploaded: up, cdn: cdn,
    verificationMethod: "COS HeadObject(size+metadata) + CDN 全量下载 SHA256/size 验证"
  };
}

/* ---- prune：保留最新 N 个 vc + current latest 绝不删。
   channel 决定 list 前缀与 key 解析：dev prune 只看 dev/ 键，
   stable prune 只看 stable/ 键 —— 两个渠道的对象互不触碰。 ---- */
async function pruneOldApks(deps) {
  const { client, config, keepCount, currentVersionCode } = deps;
  const channel = deps.channel === "stable" ? "stable" : "dev";
  const keep = Number.isInteger(keepCount) ? keepCount : 3;
  const listed = await client.listAllObjects(config, config.bucket, channelCosPrefix(channel) + "/");
  if (!listed.ok) {
    return { ok: false, error: "list failed", status: listed.status };
  }
  const versions = parseApkVersions(listed.contents, channel);
  const survivors = versions.slice(0, Math.max(keep, 1));
  const survivorKeys = {};
  survivors.forEach(function (v) { survivorKeys[v.key] = true; });
  const deleted = [];
  const kept = [];
  const failedToDelete = [];
  for (const v of versions) {
    if (survivorKeys[v.key]) { kept.push(v.key); continue; }
    if (v.versionCode === Number(currentVersionCode)) { kept.push(v.key); continue; }
    const del = await client.deleteObject(config, config.bucket, v.key);
    if (del.ok) { deleted.push({ key: v.key, versionCode: v.versionCode }); }
    else { failedToDelete.push({ key: v.key, error: del.error, status: del.status }); }
  }
  return {
    ok: true, keepCount: keep, total: versions.length,
    kept: kept, deleted: deleted, failedToDelete: failedToDelete,
    latestProtected: versions.some(function (v) { return v.versionCode === Number(currentVersionCode); })
  };
}

module.exports = {
  APK_PREFIX: APK_PREFIX,
  CHANNEL_COS_PREFIX: CHANNEL_COS_PREFIX,
  channelCosPrefix: channelCosPrefix,
  APK_CONTENT_TYPE: APK_CONTENT_TYPE,
  APK_CACHE_CONTROL: APK_CACHE_CONTROL,
  DEFAULT_CDN_BASE_URL: DEFAULT_CDN_BASE_URL,
  UPDATES_ENV_FILE: UPDATES_ENV_FILE,
  sha256Hex: sha256Hex,
  loadUpdatesConfig: loadUpdatesConfig,
  apkObjectKey: apkObjectKey,
  apkFileName: apkFileName,
  apkPublicUrl: apkPublicUrl,
  parseApkVersions: parseApkVersions,
  uploadApk: uploadApk,
  verifyCdnFullDownload: verifyCdnFullDownload,
  publishApk: publishApk,
  pruneOldApks: pruneOldApks
};
