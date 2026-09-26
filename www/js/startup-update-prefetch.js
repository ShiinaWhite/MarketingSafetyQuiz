/* startup-update-prefetch.js —— STARTUP_UPDATE_INSTANT_V2：启动更新早期预取。
   加载顺序位于 questions.js / explanations.js 重数据之前，使 latest 请求在
   WebView 脚本阶段就开始，而不是等题库/index 初始化。

   边界（刻意保持最小）：
   - 只复用 MSQUpdater（含 validateManifest / cache helpers）、
     MSQSample.getJSON、Capacitor App.getInfo —— 绝不实现第二套 updater；
   - 每个冷启动 fresh latest 最多发起一个主请求，唯一 Promise 通过
     window.__MSQStartupUpdatePrefetch.ready 暴露给 app.js 的 startup
     controller 复用（app.js 不得再次发起同一请求）；
   - Validated Manifest Cache 只在 validateManifest 通过后写入，
     且只能决定「是否先弹提示」；下载/安装仍走既有完整 updater 安全链。
   - 任何失败完全静默（与既有 startup 行为一致），仅记录非敏感 timing。 */
(function (root) {
  "use strict";

  var T = root.__MSQStartupTiming || (root.__MSQStartupTiming = { webviewScriptStart: Date.now() });
  function mark(name) { T[name] = Date.now(); }

  mark("startupPrefetchStart");

  function record() {
    /* 输出各段 elapsedMs（仅 DEV 诊断/日志用途，普通用户 UI 不展示） */
    try {
      var t0 = T.webviewScriptStart;
      var lines = ["[startup-update] timing"];
      ["startupPrefetchStart", "appInfoReady", "cacheChecked", "networkLatestStart",
       "networkLatestReady", "modalUiReady", "bankReady", "indexesReady",
       "promptShown"].forEach(function (k) {
        if (T[k] != null) {
          lines.push(k + "=" + (T[k] - t0) + "ms");
        }
      });
      root.console && root.console.info(lines.join(" "));
      if (T.promptShown != null) {
        root.console && root.console.info("[startup-update] CACHE_CHECK_MS=" +
          (T.cacheChecked != null ? (T.cacheChecked - T.startupPrefetchStart) : "n/a") +
          " CACHE_TO_PROMPT_MS=" + (T.promptShown - (T.cacheChecked || t0)) +
          " APP_INFO_MS=" + (T.appInfoReady != null ? (T.appInfoReady - T.startupPrefetchStart) : "n/a") +
          " FRESH_MANIFEST_MS=" + (T.networkLatestReady != null && T.networkLatestStart != null
            ? (T.networkLatestReady - T.networkLatestStart) : "n/a") +
          " MODAL_READY_MS=" + (T.modalUiReady != null ? (T.modalUiReady - t0) : "n/a") +
          " BANK_READY_MS=" + (T.bankReady != null ? (T.bankReady - t0) : "n/a") +
          " INDEX_READY_MS=" + (T.indexesReady != null ? (T.indexesReady - t0) : "n/a") +
          " TOTAL_TO_PROMPT_MS=" + (T.promptShown - t0) +
          " STARTUP_MANIFEST_SOURCE=" + (T.startupManifestSource || "n/a"));
      }
    } catch (e) { /* 日志绝不影响主流程 */ }
  }
  root.__MSQStartupTimingReport = record;

  var Updater = root.MSQUpdater;
  var Sample = root.MSQSample;

  function getAppInfo() {
    var App = (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.App) || null;
    if (!(App && typeof App.getInfo === "function")) {
      return Promise.reject(new Error("no-app-plugin"));
    }
    return App.getInfo().then(function (info) {
      return {
        id: info.id,
        versionName: info.version,
        versionCode: parseInt(info.build, 10) || 0
      };
    });
  }

  var result = {
    ok: false,
    reason: "pending",
    info: null,
    channel: null,
    cached: null,        /* { manifest, fetchedAt }（已通过 validateManifest） */
    cachedNewer: false,  /* cached.versionCode > 当前 versionCode */
    storage: null
  };
  var freshResult = null;  /* { ok:true, manifest } | { ok:false, error } */
  var resolveReady, resolveFresh;
  /* ready 在 cache 阶段结束即 resolve（cache 快路径不等网络）；
     freshReady 在 fresh revalidate 结束时 resolve（controller 网络路径等待它）。 */
  var ready = new Promise(function (resolve) { resolveReady = resolve; });
  var freshReady = new Promise(function (resolve) { resolveFresh = resolve; });

  mark("appInfoStart");
  getAppInfo().then(function (info) {
    mark("appInfoReady");
    result.info = info;
    var channel = Updater ? Updater.updateChannelFor(info.id) : null;
    result.channel = channel;
    if (!channel) {
      result.reason = "channel-unsupported";
      resolveReady(result);
      resolveFresh({ ok: false, error: "channel-unsupported" });
      return;
    }
    var storage = (typeof root.localStorage !== "undefined") ? root.localStorage : null;
    result.storage = storage;

    /* ---- Cache 快路径判定（只允许「验证过且比当前新」的 cache 决定先弹提示） ---- */
    var cachedNewer = null;
    if (storage && Updater && Updater.readLatestCache) {
      var entry = Updater.readLatestCache(storage, channel);
      if (entry) {
        var state = Updater.cachedUpdateState(info.versionCode, entry,
          { channel: channel, packageName: info.id });
        if (state === "available") {
          cachedNewer = { manifest: entry.manifest, fetchedAt: entry.fetchedAt };
        }
      }
    }
    mark("cacheChecked");
    result.cached = cachedNewer;
    result.cachedNewer = !!cachedNewer;
    /* cache 阶段完成 → 立即放行 cache 快路径（绝不等待网络） */
    resolveReady(result);

    /* ---- fresh revalidate：始终进行（cache 绝不绕过 fresh check） ---- */
    mark("networkLatestStart");
    var server = Updater.resolveUpdateServer(Updater.loadSettings(), Updater.PUBLIC_BASE_URL);
    var fetch = (Sample && typeof Sample.getJSON === "function")
      ? Sample.getJSON(server + "/api/update/" + channel + "/latest", 10000)
      : Promise.reject(new Error("无传输层"));
    fetch.then(function (manifest) {
      mark("networkLatestReady");
      var v = Updater.validateManifest(manifest, { channel: channel, packageName: info.id });
      if (v.ok) {
        /* 只允许写入已通过 validateManifest 的 manifest */
        Updater.writeLatestCache(storage, channel, manifest, Date.now());
        freshResult = { ok: true, manifest: manifest };
      } else {
        freshResult = { ok: false, error: v.error };
      }
      resolveFresh(freshResult);
    }, function (e) {
      mark("networkLatestReady");
      resolveFresh({ ok: false, error: String((e && e.message) || e || "network") });
    });
  }, function () {
    mark("appInfoReady");
    result.ok = false;
    result.reason = "no-app-info";
    resolveReady(result);
    resolveFresh({ ok: false, error: "no-app-info" });
  });

  /* ok 语义：拿到了 App 信息与渠道（fresh 可能失败=离线，仍交给 controller 走静默） */
  root.__MSQStartupUpdatePrefetch = {
    ready: ready.then(function (r) {
      r.ok = !!(r.info && r.channel);
      if (r.ok && r.reason === "pending") { r.reason = "done"; }
      r.freshReady = freshReady;
      return r;
    }),
    marks: T
  };
})(typeof self !== "undefined" ? self : this);
