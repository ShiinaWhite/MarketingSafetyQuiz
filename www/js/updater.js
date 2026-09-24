/* updater.js —— 应用内自更新纯逻辑（无 DOM 依赖；传输层复用 sample-collector.js 的
   requestJSON/getJSON 与原生 UpdatePlugin）。Node 自检可 require。
   协议不依赖局域网/Collector 特有行为：只依赖 HTTP(S) + latest.json + APK URL，
   未来切换 https://update.shiinalab.top 只需改更新源，不改本模块。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.MSQUpdater = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_VERSION = 1;
  var SETTINGS_KEY = "msq.update.v1";
  var MAX_APK_BYTES = 150 * 1024 * 1024;
  /* 统一公网更新/采集服务器（与 sample-collector.js 的 PUBLIC_BASE_URL 一致）。
     更新不再依赖 Sample Collector 地址 fallback。 */
  var PUBLIC_BASE_URL = "https://update.shiinalab.top";

  var CHANNEL_PACKAGE = {
    dev: "com.jty.safetyquiz.dev",
    stable: "com.jty.safetyquiz"
  };

  /* ---------------- 设置（store 可注入） ---------------- */

  function normalizeSettings(raw) {
    var s = (raw && typeof raw === "object") ? raw : {};
    var url = typeof s.serverUrl === "string" ? s.serverUrl.trim() : "";
    if (!/^https?:\/\//i.test(url)) { url = ""; }
    while (url.length > 0 && url.charAt(url.length - 1) === "/") { url = url.slice(0, -1); }
    return { serverUrl: url };
  }

  function loadSettings(store) {
    var st = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st || typeof st.getItem !== "function") { return normalizeSettings(null); }
    var raw = null;
    try { raw = JSON.parse(st.getItem(SETTINGS_KEY) || "null"); } catch (e) { raw = null; }
    return normalizeSettings(raw);
  }

  function saveSettings(store, settings) {
    var st = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st || typeof st.setItem !== "function") { return false; }
    try {
      st.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
      return true;
    } catch (e) { return false; }
  }

  /* 更新服务器解析级联：
     1) 更新模块显式配置 2) 内置公网默认（不再依赖采集服务器地址） */
  function resolveUpdateServer(updateSettings, bundledDefault) {
    var u = normalizeSettings(updateSettings).serverUrl;
    if (u) { return u; }
    var b = normalizeSettings({ serverUrl: bundledDefault }).serverUrl;
    if (!b) { b = PUBLIC_BASE_URL; }
    return b || PUBLIC_BASE_URL;
  }

  /* 渠道由当前真实 applicationId 决定，不写死 dev（cherry-pick 回 main 后自然支持 stable） */
  function updateChannelFor(applicationId) {
    if (applicationId === CHANNEL_PACKAGE.dev) { return "dev"; }
    if (applicationId === CHANNEL_PACKAGE.stable) { return "stable"; }
    return null;
  }

  /* apkUrl 支持相对路径 / 绝对 http(s) URL，未来迁移域名无需改协议 */
  function resolveApkUrl(serverUrl, apkUrl) {
    if (typeof apkUrl !== "string" || !apkUrl) { return null; }
    if (/^https?:\/\//i.test(apkUrl)) { return apkUrl; }
    var base = String(serverUrl || "").replace(/\/+$/, "");
    if (!base) { return null; }
    if (apkUrl.charAt(0) === "/") { return base + apkUrl; }
    return base + "/" + apkUrl;
  }

  /* latest.json 校验（schemaVersion=1）。返回 { ok, error }，不抛错。 */
  function validateManifest(manifest, expected) {
    var exp = expected || {};
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { ok: false, error: "更新信息格式无效" };
    }
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, error: "更新信息版本不支持（schemaVersion=" + manifest.schemaVersion + "）" };
    }
    if (exp.channel && manifest.channel !== exp.channel) {
      return { ok: false, error: "更新渠道不匹配" };
    }
    if (exp.packageName && manifest.packageName !== exp.packageName) {
      return { ok: false, error: "更新包与应用不匹配" };
    }
    if (typeof manifest.versionCode !== "number" ||
        !isFinite(manifest.versionCode) || Math.floor(manifest.versionCode) !== manifest.versionCode ||
        manifest.versionCode < 1) {
      return { ok: false, error: "更新信息 versionCode 无效" };
    }
    if (typeof manifest.versionName !== "string" || !manifest.versionName) {
      return { ok: false, error: "更新信息 versionName 无效" };
    }
    if (typeof manifest.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(manifest.sha256)) {
      return { ok: false, error: "更新信息 SHA256 无效" };
    }
    if (typeof manifest.size !== "number" || !isFinite(manifest.size) ||
        manifest.size < 1 || manifest.size > MAX_APK_BYTES) {
      return { ok: false, error: "更新包大小异常" };
    }
    if (typeof manifest.apkUrl !== "string" || !manifest.apkUrl) {
      return { ok: false, error: "更新信息缺少下载地址" };
    }
    return { ok: true, error: null };
  }

  /* versionCode 整数比较（绝不使用 versionName 字符串比较）：
     available = 发现新版本；latest = 已是最新；downgrade = 服务器版本低于当前 */
  function checkUpdateState(currentVersionCode, manifest) {
    var cur = (typeof currentVersionCode === "number" && isFinite(currentVersionCode))
      ? currentVersionCode : 0;
    if (!manifest || typeof manifest.versionCode !== "number") { return "invalid"; }
    if (manifest.versionCode > cur) { return "available"; }
    if (manifest.versionCode === cur) { return "latest"; }
    return "downgrade";
  }

  function formatBytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) { return "?"; }
    if (n >= 1024 * 1024) {
      return (Math.round(n / (1024 * 1024) * 10) / 10) + " MB";
    }
    if (n >= 1024) { return (Math.round(n / 1024 * 10) / 10) + " KB"; }
    return n + " B";
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SETTINGS_KEY: SETTINGS_KEY,
    MAX_APK_BYTES: MAX_APK_BYTES,
    PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    CHANNEL_PACKAGE: CHANNEL_PACKAGE,
    normalizeSettings: normalizeSettings,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    resolveUpdateServer: resolveUpdateServer,
    updateChannelFor: updateChannelFor,
    resolveApkUrl: resolveApkUrl,
    validateManifest: validateManifest,
    checkUpdateState: checkUpdateState,
    formatBytes: formatBytes
  };
});
