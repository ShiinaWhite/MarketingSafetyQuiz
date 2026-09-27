/* telemetry.js —— USAGE_TELEMETRY_V1 客户端纯逻辑（DATA_PLATFORM_V1_DESIGN.md §3-§8）
   UMD：Node 直接 require（TEL-* 测试），浏览器挂 window.MSQTelemetry。

   设计约束：
   - 只聚合，不逐事件上传（currentBucket 只存 counters/histograms/桶边界/动作数）；
   - 不保存 raw events / 逐次时间线 / 任何 query、OCR、内容文本（TEL-PRIVACY）；
   - 逻辑搜题口径 = 空闲门（1200ms）+ query 去重，逐字输入只产出 1 次计数（§4）；
   - 冻结三条件：30 动作 / 6h 桶龄 / 本地跨日；outbox ACK 后才删除；
   - 上传节流 30min；退避 5min→30min→2h→6h 封顶 24h + jitter；400 只丢被拒批次；
   - 本模块绝不抛出：所有公开方法吞异常（telemetry 故障不影响任何业务）。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else { root.MSQTelemetry = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_VERSION = 1;
  var STATE_KEY = "msq.telemetry.v1";

  /* 与服务端 allowlist 同源（tools/telemetry/store.js）；客户端守卫防未知键入库 */
  var COUNTERS = [
    "app_cold_start", "app_resume",
    "text_search", "text_search_with_results", "text_search_no_result", "search_result_open",
    "photo_attempt", "photo_capture_success", "photo_cancel", "photo_failure",
    "photo_process_success", "photo_process_failure",
    "recognized_question_total", "confidence_high", "confidence_medium",
    "confidence_low", "confidence_none",
    "auto_single", "auto_multi", "auto_judge", "type_manual_correction",
    "feedback_missing_question", "feedback_wrong_screen_number",
    "feedback_wrong_page_type", "feedback_wrong_answer", "feedback_other",
    "mode_sequence_start", "mode_random_start", "mode_single_start", "mode_multi_start",
    "mode_judge_start", "mode_wrong_start", "mode_recite_start", "mode_exam_start",
    "camera_error", "ocr_error", "matcher_error", "telemetry_upload_error"
  ];

  var HISTOGRAM_EDGES = {
    photo_total_ms: { edges: [1000, 2000, 4000, 8000],
      labels: ["<1000", "1000-2000", "2000-4000", "4000-8000", ">=8000"] },
    ocr_ms: { edges: [500, 1000, 2000, 4000],
      labels: ["<500", "500-1000", "1000-2000", "2000-4000", ">=4000"] }
  };

  var BACKOFF_SCHEDULE_MS = [5 * 60000, 30 * 60000, 2 * 3600000, 6 * 3600000];
  var MAX_BACKOFF_MS = 24 * 3600000;
  var JITTER_MIN = 0.8, JITTER_MAX = 1.2;
  var MIN_UPLOAD_INTERVAL_MS = 30 * 60000;
  var SEARCH_IDLE_MS = 1200;
  var FREEZE_ACTION_THRESHOLD = 30;
  var FREEZE_AGE_MS = 6 * 3600000;
  var OUTBOX_MAX_BATCHES = 120;
  var MAX_BATCHES_PER_POST = 20;
  var MAX_BODY_BYTES = 128 * 1024;
  var DRAIN_TAIL_DELAY_MS = 60000;

  /* ---------------- 纯函数 ---------------- */

  function localDayString(ms) {
    var d = new Date(ms);
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  }

  function bucketize(name, value) {
    var spec = HISTOGRAM_EDGES[name];
    if (!spec || typeof value !== "number" || !isFinite(value) || value < 0) { return null; }
    for (var i = 0; i < spec.edges.length; i++) {
      if (value < spec.edges[i]) { return spec.labels[i]; }
    }
    return spec.labels[spec.labels.length - 1];
  }

  /* 有限指数退避 + jitter；attempts 从 1 计。schedule 耗尽后封顶 24h（§8） */
  function backoffMs(attempts, rand) {
    var idx = Math.max(0, Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1));
    var base = (attempts > BACKOFF_SCHEDULE_MS.length)
      ? MAX_BACKOFF_MS : BACKOFF_SCHEDULE_MS[idx];
    var r = (typeof rand === "function" ? rand() : Math.random());
    var jitter = JITTER_MIN + (JITTER_MAX - JITTER_MIN) * r;
    return Math.round(Math.min(base * jitter, MAX_BACKOFF_MS));
  }

  /* 诊断只出掩码：前 6 + … + 后 4（64 hex） */
  function maskDeviceId(id) {
    if (typeof id !== "string" || id.length < 12) { return null; }
    return id.slice(0, 6) + "…" + id.slice(-4);
  }

  function uuidV4(random) {
    var rnd = (typeof random === "function") ? random : Math.random;
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      try { return crypto.randomUUID(); } catch (e) { /* 退回手工实现 */ }
    }
    var hex = "0123456789abcdef";
    var s = "";
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { s += "-"; }
      else if (i === 14) { s += "4"; }
      else if (i === 19) { s += hex[8 + Math.floor(rnd() * 4)]; }
      else { s += hex[Math.floor(rnd() * 16)]; }
    }
    return s;
  }

  function isCounterMetric(k) { return COUNTERS.indexOf(k) >= 0; }

  /* ---------------- state 规范化（防损坏 / 防未知键残留） ---------------- */

  function freshBucket(nowMs, day) {
    return {
      periodStart: nowMs, periodEnd: null, localDay: day,
      counters: {}, histograms: {}, meaningfulActionCount: 0
    };
  }

  function normalizeState(raw, nowMs, day) {
    var s = (raw && typeof raw === "object") ? raw : {};
    var out = {
      schemaVersion: SCHEMA_VERSION,
      deviceId: (typeof s.deviceId === "string" && /^[0-9a-f]{64}$/.test(s.deviceId))
        ? s.deviceId : null,
      /* DATA_PLATFORM_V1_1：batch 端凭据（服务端签发的 HMAC 派生物，非原始 secret） */
      deviceToken: (typeof s.deviceToken === "string" && /^[0-9a-f]{64}$/.test(s.deviceToken))
        ? s.deviceToken : null,
      currentBucket: freshBucket(nowMs, day),
      outbox: [],
      lastFlushSuccessAt: (typeof s.lastFlushSuccessAt === "number") ? s.lastFlushSuccessAt : 0,
      lastUploadAttemptAt: (typeof s.lastUploadAttemptAt === "number") ? s.lastUploadAttemptAt : 0,
      nextRetryAt: (typeof s.nextRetryAt === "number") ? s.nextRetryAt : 0,
      flushAttempts: (typeof s.flushAttempts === "number") ? s.flushAttempts : 0,
      lastFlushResult: (typeof s.lastFlushResult === "string") ? s.lastFlushResult : "",
      registerRetryAt: (typeof s.registerRetryAt === "number") ? s.registerRetryAt : 0,
      registerAttempts: (typeof s.registerAttempts === "number") ? s.registerAttempts : 0
    };
    var b = s.currentBucket;
    if (b && typeof b === "object" && typeof b.periodStart === "number") {
      out.currentBucket.periodStart = b.periodStart;
      out.currentBucket.localDay = (typeof b.localDay === "string") ? b.localDay : day;
      out.currentBucket.meaningfulActionCount =
        (typeof b.meaningfulActionCount === "number") ? b.meaningfulActionCount : 0;
      var i;
      if (b.counters && typeof b.counters === "object") {
        for (i in b.counters) {
          if (isCounterMetric(i) && typeof b.counters[i] === "number") {
            out.currentBucket.counters[i] = b.counters[i];
          }
        }
      }
      if (b.histograms && typeof b.histograms === "object") {
        for (i in b.histograms) {
          var spec = HISTOGRAM_EDGES[i];
          var h = b.histograms[i];
          if (!spec || !h || typeof h !== "object") { continue; }
          var cleaned = {};
          for (var label in h) {
            if (spec.labels.indexOf(label) >= 0 && typeof h[label] === "number") {
              cleaned[label] = h[label];
            }
          }
          if (Object.keys(cleaned).length) { out.currentBucket.histograms[i] = cleaned; }
        }
      }
    }
    if (Array.isArray(s.outbox)) {
      for (var j = 0; j < s.outbox.length && out.outbox.length < OUTBOX_MAX_BATCHES; j++) {
        var ob = s.outbox[j];
        if (ob && typeof ob === "object" && typeof ob.batchId === "string" &&
            typeof ob.periodStart === "number") {
          out.outbox.push(ob);
        }
      }
    }
    return out;
  }

  /* ---------------- 控制器（同步核心；原生异步加载由 createFromEnvironment 包装） ---------------- */

  function createController(deps) {
    var d = deps || {};
    var now = function () {
      return (d.clock && typeof d.clock.now === "function") ? d.clock.now() : Date.now();
    };
    var today = function () {
      return (d.clock && typeof d.clock.localDay === "function")
        ? d.clock.localDay() : localDayString(Date.now());
    };
    var uuid = function () { return uuidV4(d.random); };
    var rand = d.random || Math.random;

    /* lastCountedQuery / pendingSearch 只存内存：query 字符串绝不持久化（§4） */
    var lastCountedQuery = null;
    var pendingSearch = null;
    var searchTimer = null;
    var flushing = false;

    var initialRaw = null;
    try {
      initialRaw = (d.storage && typeof d.storage.load === "function") ? d.storage.load() : null;
    } catch (e) { initialRaw = null; }
    var state = normalizeState(initialRaw, now(), today());

    function persist() {
      try {
        if (d.storage && typeof d.storage.save === "function") { d.storage.save(state); }
      } catch (e) { /* 存储失败：metric 静默丢弃，绝不影响业务 */ }
    }

    function bumpCounter(metric) {
      var c = state.currentBucket.counters;
      c[metric] = (c[metric] || 0) + 1;
      state.currentBucket.meaningfulActionCount += 1;
    }

    function maybeFreeze() {
      var t = now();
      var b = state.currentBucket;
      var dayChanged = b.localDay !== today();
      var ageExceeded = (t - b.periodStart) >= FREEZE_AGE_MS;
      var actionsExceeded = b.meaningfulActionCount >= FREEZE_ACTION_THRESHOLD;
      if (!actionsExceeded && !ageExceeded && !dayChanged) { return false; }
      freezeBucket(t, dayChanged);
      return true;
    }

    function freezeBucket(t, fromDayChange) {
      var b = state.currentBucket;
      b.periodEnd = t;
      b.batchId = uuid();
      state.outbox.push(b);
      while (state.outbox.length > OUTBOX_MAX_BATCHES) {
        state.outbox.shift();   /* 防御上限：丢最老，计数进新桶 */
        try {
          state.currentBucket.counters.telemetry_upload_error =
            (state.currentBucket.counters.telemetry_upload_error || 0) + 1;
          state.currentBucket.meaningfulActionCount += 1;
        } catch (e) { /* 忽略 */ }
      }
      state.currentBucket = freshBucket(t, today());
      persist();
      attemptFlush(fromDayChange ? "day-roll" : "freeze");
    }

    /* ---------------- 公开方法（全部吞异常） ---------------- */

    function record(metric) {
      try {
        if (!isCounterMetric(metric)) { return; }
        bumpCounter(metric);
        maybeFreeze();
        persist();
      } catch (e) { /* swallow */ }
    }

    /* 批量计数（识别题量/置信度分布）：一次聚合 n 次增量，只 persist 一次 */
    function add(metric, n) {
      try {
        if (!isCounterMetric(metric)) { return; }
        var k = Math.floor(Number(n));
        if (!(k >= 1 && k <= 10000)) { return; }
        var c = state.currentBucket.counters;
        c[metric] = (c[metric] || 0) + k;
        state.currentBucket.meaningfulActionCount += k;
        maybeFreeze();
        persist();
      } catch (e) { /* swallow */ }
    }

    function observeHistogram(name, value) {
      try {
        var label = bucketize(name, value);
        if (!label) { return; }
        var h = state.currentBucket.histograms;
        if (!h[name]) { h[name] = {}; }
        h[name][label] = (h[name][label] || 0) + 1;
        state.currentBucket.meaningfulActionCount += 1;
        maybeFreeze();
        persist();
      } catch (e) { /* swallow */ }
    }

    function fireSearchTimer() {
      searchTimer = null;
      if (!pendingSearch) { return; }
      var p = pendingSearch;
      pendingSearch = null;
      lastCountedQuery = p.query;
      record("text_search");
      record(p.resultCount > 0 ? "text_search_with_results" : "text_search_no_result");
    }

    /* 逻辑搜题口径（§4）：空闲门 + 去重；query 只在内存参与判定 */
    function observeSearch(query, resultCount) {
      try {
        var q = String(query == null ? "" : query).trim();
        if (!q) {
          lastCountedQuery = null;          /* 清空 = 下次输入视为新意图 */
          pendingSearch = null;
          if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
          return;
        }
        if (q === lastCountedQuery) { return; }   /* 同 query：筛选/重渲染不重复计数 */
        pendingSearch = { query: q, resultCount: (typeof resultCount === "number" &&
          isFinite(resultCount) && resultCount > 0) ? resultCount : 0 };
        if (searchTimer) { clearTimeout(searchTimer); }
        var timerFn = d.setTimeout || setTimeout;
        searchTimer = timerFn(fireSearchTimer, SEARCH_IDLE_MS);
      } catch (e) { /* swallow */ }
    }

    function appInfo() {
      try { return (typeof d.appInfo === "function") ? d.appInfo() : null; }
      catch (e) { return null; }
    }

    /* ---------------- 注册（§3）与上传（§7/§8） ---------------- */

    function registerAndFlush() {
      flushing = true;
      var native = d.native;
      Promise.resolve()
        .then(function () {
          if (!(native && typeof native.getAndroidId === "function")) {
            throw new Error("no-native");
          }
          return native.getAndroidId();
        })
        .then(function (androidId) {
          if (!androidId) { throw new Error("no-android-id"); }
          return d.transport.post(d.serverUrl + "/api/telemetry/register",
            { schemaVersion: SCHEMA_VERSION, androidId: String(androidId) }, 15000);
        })
        .then(function (resp) {
          var id = resp && resp.deviceId;
          var token = resp && resp.deviceToken;
          if (!(typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) ||
              !(typeof token === "string" && /^[0-9a-f]{64}$/.test(token))) {
            throw new Error("bad-register-response");
          }
          state.deviceId = id;
          state.deviceToken = token;
          state.registerRetryAt = 0;
          state.registerAttempts = 0;
          /* 注册本身也是一次 telemetry 网络交互：30min 上传间隔从注册时刻起算（§7） */
          state.lastUploadAttemptAt = now();
          state.lastFlushResult = "registered";
          persist();
          flushing = false;
          attemptFlush("registered");
        })
        .catch(function () {
          state.registerAttempts += 1;
          state.registerRetryAt = now() + backoffMs(state.registerAttempts, rand);
          state.lastFlushResult = "register failed";
          persist();
          flushing = false;
        });
    }

    function withMeta(b) {
      var info = appInfo();
      return {
        batchId: b.batchId,
        localDay: b.localDay,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd || b.periodStart,
        versionCode: info ? info.versionCode : 0,
        versionName: info ? String(info.versionName) : "unknown",
        channel: info ? (info.channel || "unknown") : "unknown",
        packageName: info ? String(info.packageName) : "unknown",
        counters: b.counters,
        histograms: b.histograms
      };
    }

    function postBatch(batches) {
      var payload = {
        schemaVersion: SCHEMA_VERSION,
        deviceId: state.deviceId,
        deviceToken: state.deviceToken,
        batches: batches
      };
      var body = JSON.stringify(payload);
      while (body.length > MAX_BODY_BYTES && payload.batches.length > 1) {
        payload.batches.pop();
        body = JSON.stringify(payload);
      }
      return d.transport.post(d.serverUrl + "/api/telemetry/batch", payload, 15000)
        .then(function (resp) { return { resp: resp, sent: payload.batches }; });
    }

    function flushNow() {
      flushing = true;
      var info = appInfo();
      if (!info || !info.versionCode) {
        /* 无版本信息（App.getInfo 未就绪）：不上报，等下一个触发点 */
        flushing = false;
        return;
      }
      var take = state.outbox.slice(0, MAX_BATCHES_PER_POST).map(withMeta);
      state.lastUploadAttemptAt = now();
      persist();
      postBatch(take).then(function (r) {
        var acked = {};
        var resp = r.resp || {};
        var accepted = (resp.accepted || []).concat(resp.alreadyAccepted || []);
        for (var i = 0; i < accepted.length; i++) { acked[accepted[i]] = true; }
        var sentIds = {};
        for (var j = 0; j < r.sent.length; j++) { sentIds[r.sent[j].batchId] = true; }
        /* ACK 后才删除：accepted ∪ alreadyAccepted = 服务端已知的批次 */
        state.outbox = state.outbox.filter(function (b) {
          if (acked[b.batchId]) { return false; }
          return true;
        });
        state.lastFlushSuccessAt = now();
        state.flushAttempts = 0;
        state.nextRetryAt = state.outbox.length ? (now() + DRAIN_TAIL_DELAY_MS) : 0;
        state.lastFlushResult = "OK (" + accepted.length + " acked)";
        persist();
        flushing = false;
      }, function (e) {
        var status = e && e.status;
        if (status === 401 || status === 403) {
          /* DATA_PLATFORM_V1_1：凭据失效（secret 轮换/服务端重置）→ 清空凭据
             重新注册（走 register 退避），outbox 数据保留，绝不无限重试 */
          state.deviceId = null;
          state.deviceToken = null;
          state.registerAttempts += 1;
          state.registerRetryAt = now() + backoffMs(state.registerAttempts, rand);
          state.flushAttempts = 0;
          state.nextRetryAt = 0;
          state.lastFlushResult = "token rejected (" + status + ")";
          persist();
          flushing = false;
          return;
        }
        if (status === 400) {
          /* schema 拒绝：只丢被拒批次（§8）；无法定位被拒批次时丢弃本次发送的全部
             批次（同一客户端 bug 不会因重试自愈），绝不无限循环 */
          var rejectedIds = {};
          var list = (e && e.rejected) || [];
          for (var k = 0; k < list.length; k++) {
            if (list[k] && list[k].batchId) { rejectedIds[list[k].batchId] = true; }
          }
          var sentIds = {};
          for (var m = 0; m < take.length; m++) { sentIds[take[m].batchId] = true; }
          var identifiable = Object.keys(rejectedIds).length > 0;
          state.outbox = state.outbox.filter(function (b) {
            if (!sentIds[b.batchId]) { return true; }
            return identifiable ? !rejectedIds[b.batchId] : false;
          });
          state.currentBucket.counters.telemetry_upload_error =
            (state.currentBucket.counters.telemetry_upload_error || 0) + 1;
          state.currentBucket.meaningfulActionCount += 1;
          state.flushAttempts = 0;
          state.nextRetryAt = state.outbox.length ? (now() + DRAIN_TAIL_DELAY_MS) : 0;
          state.lastFlushResult = "rejected (400)";
          persist();
          flushing = false;
          return;
        }
        state.flushAttempts += 1;
        state.nextRetryAt = now() + backoffMs(state.flushAttempts, rand);
        state.lastFlushResult = status ? ("HTTP " + status) : "network error";
        persist();
        flushing = false;
      });
    }

    function attemptFlush(reason) {
      try {
        if (flushing) { return; }
        var t = now();
        if (!state.deviceId || !state.deviceToken) {
          if (t >= state.registerRetryAt) { registerAndFlush(); }
          return;
        }
        if (!state.outbox.length) { return; }
        var dueRetry = state.nextRetryAt && t >= state.nextRetryAt;
        var intervalOk = (t - state.lastUploadAttemptAt) >= MIN_UPLOAD_INTERVAL_MS;
        if (!intervalOk && !dueRetry) { return; }
        flushNow();
      } catch (e) { /* swallow */ }
    }

    /* ---------------- 生命周期入口 ---------------- */

    function onColdStart() {
      record("app_cold_start");
      attemptFlush("cold-start");
    }

    function onAppResume() {
      record("app_resume");
      try { maybeFreeze(); } catch (e) { /* swallow */ }
      attemptFlush("resume");
    }

    function diagnostics() {
      try {
        var id = state.deviceId;
        return {
          hasDeviceId: !!(id && state.deviceToken),
          deviceIdMasked: maskDeviceId(id),
          outboxCount: state.outbox.length,
          bucketActions: state.currentBucket.meaningfulActionCount,
          lastFlushSuccessAt: state.lastFlushSuccessAt || null,
          nextRetryAt: state.nextRetryAt || null,
          lastFlushResult: state.lastFlushResult || null
        };
      } catch (e) { return null; }
    }

    /* 测试专用：只读快照（不含内存态 query） */
    function stateSnapshot() {
      return JSON.parse(JSON.stringify(state));
    }

    return {
      record: record,
      add: add,
      observeHistogram: observeHistogram,
      observeSearch: observeSearch,
      onColdStart: onColdStart,
      onAppResume: onAppResume,
      attemptFlush: attemptFlush,
      diagnostics: diagnostics,
      stateSnapshot: stateSnapshot
    };
  }

  /* ---------------- 浏览器环境装配（原生缺位 → telemetry 关闭，返回 null） ----------------
     ANDROID_ID 与 filesDir 持久化都来自原生 TelemetryPlugin；浏览器调试（无插件）
     时 telemetry 整体禁用，绝不影响页面。 */
  function createFromEnvironment(options) {
    var opts = options || {};
    var native = null;
    try {
      native = (typeof window !== "undefined" && window.Capacitor &&
        window.Capacitor.Plugins && window.Capacitor.Plugins.Telemetry) || null;
    } catch (e) { native = null; }
    if (!native) { return Promise.resolve(null); }

    var nativeTransport = (typeof window !== "undefined" && window.Capacitor &&
      window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;

    /* 传输层：CapacitorHttp 优先（与样本链路同源）；非 2xx 时附带解析后的
       rejected 明细（§8 的 400 处理需要） */
    function transportPost(url, bodyObj, timeoutMs) {
      if (nativeTransport && typeof nativeTransport.request === "function") {
        return nativeTransport.request({
          url: url, method: "POST",
          headers: { "Content-Type": "application/json" },
          data: bodyObj,
          connectTimeout: timeoutMs || 15000, readTimeout: timeoutMs || 15000
        }).then(function (resp) {
          var status = (resp && resp.status) || 0;
          if (status < 200 || status >= 300) {
            var err = new Error("HTTP " + status);
            err.status = status;
            if (resp && resp.data && typeof resp.data === "object" && resp.data.rejected) {
              err.rejected = resp.data.rejected;
            }
            throw err;
          }
          return (resp && resp.data !== undefined) ? resp.data : null;
        }, function (e) {
          throw new Error(String((e && e.message) || e).slice(0, 80));
        });
      }
      if (typeof fetch !== "function") {
        return Promise.reject(new Error("无可用 HTTP 通道"));
      }
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj)
      }).then(function (resp) {
        return resp.text().then(function (tx) {
          var status = resp.status;
          if (status < 200 || status >= 300) {
            var err = new Error("HTTP " + status);
            err.status = status;
            try {
              var parsed = tx ? JSON.parse(tx) : null;
              if (parsed && parsed.rejected) { err.rejected = parsed.rejected; }
            } catch (e) { /* 非 JSON 错误体 */ }
            throw err;
          }
          try { return tx ? JSON.parse(tx) : null; } catch (e) { return tx; }
        });
      });
    }

    var storage = {
      load: function () {
        try {
          var raw = window.localStorage.getItem(STATE_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      },
      save: function (state) {
        try { window.localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { }
      }
    };

    /* 原生持久化可用时优先（filesDir，与 SampleQueue 同级可靠性） */
    if (typeof native.loadState === "function" && typeof native.saveState === "function") {
      return Promise.resolve(native.loadState()).then(function (res) {
        var loaded = null;
        try {
          loaded = (res && typeof res.stateJson === "string" && res.stateJson)
            ? JSON.parse(res.stateJson) : null;
        } catch (e) { loaded = null; }
        var storageNative = {
          load: function () { return loaded; },
          save: function (state) {
            try {
              native.saveState({ stateJson: JSON.stringify(state) }).then(null, function () { });
            } catch (e) { /* swallow */ }
          }
        };
        return buildController(storageNative);
      }, function () {
        return buildController(storage);
      });
    }
    return Promise.resolve(buildController(storage));

    function buildController(storageImpl) {
      return createController({
        storage: storageImpl,
        transport: { post: transportPost },
        native: native,
        serverUrl: String(opts.serverUrl || "").replace(/\/+$/, ""),
        appInfo: opts.appInfo || null
      });
    }
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATE_KEY: STATE_KEY,
    COUNTERS: COUNTERS,
    HISTOGRAM_EDGES: HISTOGRAM_EDGES,
    BACKOFF_SCHEDULE_MS: BACKOFF_SCHEDULE_MS,
    MIN_UPLOAD_INTERVAL_MS: MIN_UPLOAD_INTERVAL_MS,
    SEARCH_IDLE_MS: SEARCH_IDLE_MS,
    FREEZE_ACTION_THRESHOLD: FREEZE_ACTION_THRESHOLD,
    FREEZE_AGE_MS: FREEZE_AGE_MS,
    OUTBOX_MAX_BATCHES: OUTBOX_MAX_BATCHES,
    MAX_BATCHES_PER_POST: MAX_BATCHES_PER_POST,
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    localDayString: localDayString,
    bucketize: bucketize,
    backoffMs: backoffMs,
    maskDeviceId: maskDeviceId,
    uuidV4: uuidV4,
    createController: createController,
    createFromEnvironment: createFromEnvironment
  };
});
