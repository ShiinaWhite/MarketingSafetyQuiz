/* apk-download-diag.js —— APK_CDN_STABILITY_DIAG_V1：更新下载链路非敏感诊断（纯逻辑）。
   只服务于 DEV 隐藏诊断页；普通用户 UI 永不显示。
   记录最近一次更新下载：最终来源（CDN/Legacy）、是否回退、回退原因（仅错误码 +
   HTTP 状态，绝不含原始异常消息——其中可能带域名）、HTTP 状态、字节数、耗时、
   平均速度、CDN 缓存状态（hit/miss/unknown）。
   禁止出现：域名/endpoint/token/Authorization/SecretKey/presigned URL/cookie——
   writeBarrier 会在保存前扫描并把任何命中子串替换为 [filtered]（CDN-D7）。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.MSQDownloadDiag = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STORE_KEY = "msq.apkDownloadDiag.v1";
  var SCHEMA_VERSION = 1;

  /* 敏感子串黑名单：保存前逐值扫描（不区分大小写） */
  var FORBIDDEN = [
    "apk.shiinalab.top", "update.shiinalab.top", "shiinalab",
    "http://", "https://", "authorization", "bearer",
    "secret", "token", "presigned", "cookie", "signature="
  ];

  /* 腾讯 CDN 明确缓存指标：X-Cache-Lookup: Cache Hit / Cache Miss（实测确认）。
     拿不到或其它值 → unknown，绝不猜测（CDN-D8）。 */
  function normalizeCacheStatus(raw) {
    if (raw === undefined || raw === null) { return "unknown"; }
    var s = String(raw).toLowerCase();
    if (s.indexOf("hit") >= 0) { return "hit"; }
    if (s.indexOf("miss") >= 0) { return "miss"; }
    return "unknown";
  }

  /* 只从错误 code + 消息中的 HTTP 状态码提取原因；绝不保留原始消息全文 */
  function httpStatusFromError(err) {
    var msg = String((err && err.message) || "");
    var m = /HTTP (\d{3})/.exec(msg);
    return m ? Number(m[1]) : null;
  }

  function fallbackReasonOf(err) {
    var code = String((err && err.code) || "unknown");
    var status = httpStatusFromError(err);
    return status ? (code + " HTTP " + status) : code;
  }

  function containsForbidden(s) {
    var low = String(s).toLowerCase();
    for (var i = 0; i < FORBIDDEN.length; i++) {
      if (low.indexOf(FORBIDDEN[i]) >= 0) { return true; }
    }
    return false;
  }

  /* 保存前安全过滤：字符串值命中黑名单 → [filtered]；未知键一律丢弃 */
  var ALLOWED_KEYS = ["schemaVersion", "updatedAt", "downloadOk",
    "apkDownloadTransport", "apkFallbackUsed", "apkFallbackReason",
    "apkHttpStatus", "apkDownloadBytes", "apkDownloadMs", "apkBytesPerSec",
    "apkCacheStatus", "apkFinalHost"];

  function sanitize(record) {
    var out = {};
    for (var i = 0; i < ALLOWED_KEYS.length; i++) {
      var k = ALLOWED_KEYS[i];
      if (!(k in (record || {}))) { continue; }
      var v = record[k];
      if (typeof v === "string") {
        out[k] = containsForbidden(v) ? "[filtered]" : v;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /* 一次尝试成功后的记录。input:
     { transport:"cdn"|"legacy", fallbackUsed:bool, fallbackReason:string|null,
       result:{ httpStatus, bytes|size, downloadMs, cacheStatus }, }
     finalHost 只存标签（CDN / Legacy），绝不存域名。 */
  function buildSuccessRecord(input) {
    var r = input.result || {};
    var bytes = (typeof r.bytes === "number") ? r.bytes : r.size;
    var ms = r.downloadMs;
    var speed = (typeof bytes === "number" && typeof ms === "number" && ms > 0)
      ? Math.round(bytes * 1000 / ms) : null;
    return sanitize({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      downloadOk: true,
      apkDownloadTransport: input.transport,
      apkFallbackUsed: !!input.fallbackUsed,
      apkFallbackReason: input.fallbackReason || null,
      apkHttpStatus: (typeof r.httpStatus === "number") ? r.httpStatus : null,
      apkDownloadBytes: (typeof bytes === "number") ? bytes : null,
      apkDownloadMs: (typeof ms === "number") ? ms : null,
      apkBytesPerSec: speed,
      apkCacheStatus: normalizeCacheStatus(r.cacheStatus),
      apkFinalHost: input.transport === "cdn" ? "CDN" : "Legacy"
    });
  }

  /* 一次尝试失败后的记录（若随后回退成功，会被成功记录覆盖） */
  function buildFailureRecord(input) {
    return sanitize({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      downloadOk: false,
      apkDownloadTransport: input.transport,
      apkFallbackUsed: !!input.fallbackUsed,
      apkFallbackReason: fallbackReasonOf(input.error),
      apkHttpStatus: httpStatusFromError(input.error),
      apkDownloadBytes: null,
      apkDownloadMs: null,
      apkBytesPerSec: null,
      apkCacheStatus: "unknown",
      apkFinalHost: input.transport === "cdn" ? "CDN" : "Legacy"
    });
  }

  function save(store, record) {
    var st = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st || typeof st.setItem !== "function") { return false; }
    try {
      st.setItem(STORE_KEY, JSON.stringify(record));
      return true;
    } catch (e) { return false; }
  }

  function load(store) {
    var st = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st || typeof st.getItem !== "function") { return null; }
    try {
      var raw = st.getItem(STORE_KEY);
      if (!raw) { return null; }
      return sanitize(JSON.parse(raw));
    } catch (e) { return null; }
  }

  return {
    STORE_KEY: STORE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    FORBIDDEN: FORBIDDEN,
    ALLOWED_KEYS: ALLOWED_KEYS,
    normalizeCacheStatus: normalizeCacheStatus,
    httpStatusFromError: httpStatusFromError,
    fallbackReasonOf: fallbackReasonOf,
    sanitize: sanitize,
    buildSuccessRecord: buildSuccessRecord,
    buildFailureRecord: buildFailureRecord,
    save: save,
    load: load
  };
});
