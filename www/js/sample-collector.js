/* sample-collector.js —— 局域网真实样本采集旁路（纯逻辑 + 传输层，无 DOM 依赖）
   依赖 core.js 的 pageAnswerText（候选答案格式化），浏览器端须在 core.js 之后加载。
   设计约束：
   - 只读取 matcher 已算出的结果（Top3/bankId/answer/confidence），绝不重复实现匹配；
   - buildRunManifest / buildUploadPayload 是纯函数，绝不改动传入的 out/lines；
   - photoDataUrl 原样透传，不二次压缩（capture.jpg 必须等于当次送 OCR 的 JPEG 字节）；
   - 采集失败绝不影响正常搜题：这里没有任何入口向调用方抛出未捕获异常，
     网络错误一律规整为带短消息的 rejected Promise，由 app 层展示状态。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    var msq = typeof require === "function" ? require("./core.js") : null;
    module.exports = factory(msq);
  } else { root.MSQSample = factory(root.MSQ); }
})(typeof self !== "undefined" ? self : this, function (MSQ) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var SETTINGS_KEY = "msq.sampleCollection.v1";
  var SAMPLE_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;
  var JPEG_DATAURL_PREFIX = "data:image/jpeg;base64,";

  /* ---------------- 设置（store 可注入，便于 Node 自检） ---------------- */

  function normalizeSettings(raw) {
    var s = (raw && typeof raw === "object") ? raw : {};
    var url = typeof s.serverUrl === "string" ? s.serverUrl.trim() : "";
    if (!/^https?:\/\//i.test(url)) { url = ""; }
    while (url.length > 0 && url.charAt(url.length - 1) === "/") { url = url.slice(0, -1); }
    return { enabled: s.enabled === true, serverUrl: url };
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

  /* 自动上传总开关：必须显式开启且已配置服务器地址（默认永远 OFF） */
  function shouldCollect(settings) {
    var s = normalizeSettings(settings);
    return s.enabled === true && !!s.serverUrl;
  }

  /* ---------------- sampleId：YYYYMMDD_HHMMSS_xxxxxx（6 位小写 hex） ---------------- */

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function makeSampleId(now, randHex) {
    var d = (now instanceof Date) ? now : new Date();
    var rand = (typeof randHex === "string" && /^[0-9a-f]{6}$/.test(randHex)) ? randHex : "";
    if (!rand) {
      for (var i = 0; i < 6; i++) {
        rand += "0123456789abcdef".charAt(Math.floor(Math.random() * 16));
      }
    }
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + "_" + rand;
  }

  function joinUrl(base, path) {
    return String(base || "").replace(/\/+$/, "") + path;
  }

  /* ---------------- run.json manifest（纯观测：只序列化既有结果） ---------------- */

  function numOrNull(v) {
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }

  function formatAnswer(item) {
    if (MSQ && typeof MSQ.pageAnswerText === "function") { return MSQ.pageAnswerText(item); }
    return "?";
  }

  /* Top3 候选：直接来自 block.matches（matcher 已按分数排好序），附题库答案文本 */
  function blockCandidates(b, bankById) {
    var ms = (b && b.matches) || [];
    var out = [];
    for (var i = 0; i < ms.length && i < 3; i++) {
      var m = ms[i];
      var item = bankById ? bankById[m.id] : null;
      out.push({
        rank: i + 1,
        bankId: m.id !== undefined ? m.id : null,
        score: m.score !== undefined ? m.score : null,
        typeName: m.type_name || m.type || null,
        answer: item ? formatAnswer(item) : null,
        stem: m.stem || ""
      });
    }
    return out;
  }

  function blockToSample(b, bankById) {
    return {
      screenNumber: (b && b.screenNumber != null) ? String(b.screenNumber) : null,
      rawScreenNumber: (b && b.rawScreenNumber != null) ? String(b.rawScreenNumber) : null,
      numberSource: (b && b.numberSource) || "ocr",
      type: (b && b.type) || null,
      label: (b && b.label) || null,
      stemText: (b && b.stemText) || "",
      optionsText: (b && b.optionsText) || "",
      rawText: (b && b.rawText) || "",
      geometry: {
        top: numOrNull(b && b.top),
        bottom: numOrNull(b && b.bottom)
      },
      finalBankId: (b && b.bankId !== undefined) ? b.bankId : null,
      finalAnswer: (b && b.answer !== undefined) ? b.answer : null,
      confidence: (b && b.confidence) || "none",
      matchedByOptions: !!(b && b.matches && b.matches.assistedByOptions),
      candidates: blockCandidates(b, bankById)
    };
  }

  /* 纯函数：多次调用同一输入得到同一 manifest，且不改写 p.out / p.lines / p.bankById */
  function buildRunManifest(p) {
    var input = p || {};
    var lines = Array.isArray(input.lines) ? input.lines : [];
    var blocks = (input.out && input.out.blocks) || [];
    var timing = input.timing || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      sampleId: input.sampleId || null,
      capturedAt: input.capturedAt || new Date().toISOString(),
      /* pageType = 最终实际用于展示答案的题型（AUTO 判定结果或用户手动选择）。
         以下 pageType* 诊断为可选增量字段，旧 collector 原样透传，不影响 schemaVersion=1。 */
      pageType: input.pageType || null,
      pageTypeMode: input.pageTypeMode || undefined,                       /* auto | manual */
      resolvedPageType: input.resolvedPageType || undefined,               /* single|multi|judge */
      pageTypeResolutionMethod: input.pageTypeResolutionMethod || undefined, /* section-heading|match-quality|previous-page|manual */
      autoTypeConfidence: input.autoTypeConfidence || undefined,           /* strong|medium|ambiguous */
      /* bytes/sha256/width/height 由 collector 保存时补充；
         ocr.width/height 是 ML Kit 实际解码位图的尺寸（OcrPlugin 返回值） */
      image: { filename: "capture.jpg" },
      ocr: {
        text: input.text || "",
        width: numOrNull(input.ocrWidth),
        height: numOrNull(input.ocrHeight),
        lines: lines.map(function (l) {
          return {
            text: (l && l.text != null) ? String(l.text) : "",
            left: numOrNull(l && l.left),
            top: numOrNull(l && l.top),
            right: numOrNull(l && l.right),
            bottom: numOrNull(l && l.bottom)
          };
        })
      },
      blocks: blocks.map(function (b) { return blockToSample(b, input.bankById); }),
      timing: {
        ocrMs: numOrNull(timing.ocrMs),
        splitMs: numOrNull(timing.splitMs),
        matchMs: numOrNull(timing.matchMs),
        totalMs: numOrNull(timing.totalMs)
      }
    };
  }

  /* 上传 payload：photoDataUrl 与送进 Ocr.recognizeText 的是同一个字符串（同一份字节） */
  function buildUploadPayload(p) {
    var input = p || {};
    var dataUrl = input.photoDataUrl;
    if (typeof dataUrl !== "string" || dataUrl.indexOf(JPEG_DATAURL_PREFIX) !== 0) {
      throw new Error("photoDataUrl 必须是 image/jpeg data URL");
    }
    return {
      sampleId: input.sampleId,
      photoDataUrl: dataUrl,
      manifest: buildRunManifest(input)
    };
  }

  /* ---------------- 传输层 ----------------
     优先 CapacitorHttp（原生 OkHttp）：WebView 页面源是 https://localhost，
     从 https 页面 fetch 局域网 http 会被当作混合内容拦截，原生请求不受此限制，
     只受平台明文策略约束（debug 构建通过 manifest overlay 允许）。
     无 CapacitorHttp 时退回 fetch（PC 浏览器调试用）。 */

  function nativeHttp() {
    if (typeof window !== "undefined" && window.Capacitor &&
        window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp &&
        typeof window.Capacitor.Plugins.CapacitorHttp.request === "function") {
      return window.Capacitor.Plugins.CapacitorHttp;
    }
    return null;
  }

  function shortMessage(e) {
    var m = String((e && e.message) || e || "error").replace(/\s+/g, " ").trim();
    return m.length > 80 ? m.slice(0, 80) : m;
  }

  function requestJSON(method, url, bodyObj, timeoutMs) {
    var t = timeoutMs || 15000;
    var native = nativeHttp();
    if (native) {
      return native.request({
        url: url,
        method: method,
        headers: { "Content-Type": "application/json" },
        data: bodyObj === undefined ? undefined : bodyObj,
        connectTimeout: t,
        readTimeout: t
      }).then(function (resp) {
        var status = (resp && resp.status) || 0;
        if (status < 200 || status >= 300) {
          var err = new Error("HTTP " + status);
          err.status = status;
          throw err;
        }
        return (resp && resp.data !== undefined) ? resp.data : null;
      }, function (e) {
        throw new Error(shortMessage(e));
      });
    }
    if (typeof fetch !== "function") {
      return Promise.reject(new Error("无可用 HTTP 通道"));
    }
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    var timer = null;
    if (ctrl) { timer = setTimeout(function () { ctrl.abort(); }, t); }
    var cleanup = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (resp) {
      return resp.text().then(function (tx) {
        cleanup();
        var status = resp.status;
        if (status < 200 || status >= 300) {
          var err = new Error("HTTP " + status);
          err.status = status;
          throw err;
        }
        try { return tx ? JSON.parse(tx) : null; } catch (e) { return tx; }
      });
    }, function (e) {
      cleanup();
      throw new Error(shortMessage(e));
    });
  }

  function getJSON(url, timeoutMs) { return requestJSON("GET", url, undefined, timeoutMs); }
  function postJSON(url, bodyObj, timeoutMs) { return requestJSON("POST", url, bodyObj, timeoutMs); }

  /* 测试连接：永不 reject，返回 { ok, message }（不向用户暴露异常堆栈） */
  function testConnection(serverUrl, timeoutMs) {
    var okMsg = "已连接到样本接收器";
    var failMsg = "无法连接到样本接收器，请确认电脑和手机在同一局域网且接收器已启动";
    return getJSON(joinUrl(serverUrl, "/health"), timeoutMs || 5000).then(function (data) {
      var ok = !!(data && typeof data === "object" && data.ok === true &&
        data.service === "msq-sample-collector");
      return {
        ok: ok,
        message: ok ? okMsg : "该地址有响应，但不是样本接收器（/health 格式不符）"
      };
    }, function () {
      return { ok: false, message: failMsg };
    });
  }

  /* ---------------- 反馈（REAL_SAMPLE_FEEDBACK_V2，纯函数） ----------------
     页面级反馈 = "这一整页存在结构性问题"；题目级反馈 = "这一题最终答案错了"。
     状态绑定 sampleId（每个 sample 一份，不跨 sample 残留）；服务器 /api/feedback
     为幂等 upsert（set 全量替换 / remove 删除）。 */

  var FEEDBACK_PAGE_ISSUES = [
    { type: "missing_question", label: "漏题" },
    { type: "wrong_screen_number", label: "题号异常" },
    { type: "wrong_page_type", label: "题型判断错误" },
    { type: "other", label: "其他" }
  ];
  var FEEDBACK_BLOCK_ISSUES = ["wrong_answer"];

  function feedbackInitialState() {
    return { pageTypes: [], blocks: {} };
  }

  function isValidFeedbackOp(op) {
    if (!op || typeof op !== "object") { return false; }
    if (op.action !== "set" && op.action !== "remove") { return false; }
    if (op.scope !== "page" && op.scope !== "block") { return false; }
    if (typeof op.sampleId !== "string" || !op.sampleId) { return false; }
    if (op.scope === "page") {
      if (op.action === "set") {
        if (!Array.isArray(op.issueTypes) || op.issueTypes.length === 0 ||
            op.issueTypes.length > FEEDBACK_PAGE_ISSUES.length) { return false; }
        var known = {};
        FEEDBACK_PAGE_ISSUES.forEach(function (i) { known[i.type] = true; });
        for (var i = 0; i < op.issueTypes.length; i++) {
          if (!known[op.issueTypes[i]]) { return false; }
        }
      }
      return true;
    }
    /* block */
    if (FEEDBACK_BLOCK_ISSUES.indexOf(op.issue) < 0) { return false; }
    if (typeof op.blockIndex !== "number" || op.blockIndex < 0 ||
        Math.floor(op.blockIndex) !== op.blockIndex || op.blockIndex > 999) { return false; }
    if (op.action === "set" && (!op.block || typeof op.block !== "object")) { return false; }
    return true;
  }

  function buildPageFeedbackRequest(sampleId, issueTypes) {
    return { sampleId: sampleId, action: "set", scope: "page", issueTypes: issueTypes.slice() };
  }

  function buildPageClearRequest(sampleId) {
    return { sampleId: sampleId, action: "remove", scope: "page" };
  }

  /* 只提取稳定定位字段（不猜正确答案；不重跑 matcher，直接用当前结果页已有 block） */
  function buildBlockFeedbackRequest(sampleId, action, blockIndex, block) {
    var b = block || {};
    var req = {
      sampleId: sampleId,
      action: action === "remove" ? "remove" : "set",
      scope: "block",
      issue: "wrong_answer",
      blockIndex: blockIndex
    };
    if (req.action === "set") {
      req.block = {
        screenNumber: (b.screenNumber != null) ? String(b.screenNumber) : null,
        rawScreenNumber: (b.rawScreenNumber != null) ? String(b.rawScreenNumber) : null,
        numberSource: b.numberSource || "ocr",
        type: b.type || null,
        finalAnswer: (b.answer !== undefined) ? b.answer : null,
        confidence: b.confidence || "none",
        finalBankId: (b.bankId !== undefined) ? b.bankId : null,
        matchedByOptions: !!(b.matches && b.matches.assistedByOptions)
      };
    }
    return req;
  }

  /* 纯函数：把 op 应用到反馈状态，返回新状态（绝不改写入参）。FB-P 系列语义锚点。 */
  function applyFeedbackToState(state, op) {
    var next = { pageTypes: (state && state.pageTypes ? state.pageTypes : []).slice(), blocks: {} };
    var k;
    var oldBlocks = (state && state.blocks) || {};
    for (k in oldBlocks) {
      if (Object.prototype.hasOwnProperty.call(oldBlocks, k)) { next.blocks[k] = oldBlocks[k]; }
    }
    if (!isValidFeedbackOp(op)) { return next; }
    if (op.scope === "page") {
      if (op.action === "set") {
        next.pageTypes = op.issueTypes.slice().sort();
      } else {
        next.pageTypes = [];
      }
      return next;
    }
    var key = String(op.blockIndex) + ":" + op.issue;
    if (op.action === "set") { next.blocks[key] = true; }
    else { delete next.blocks[key]; }
    return next;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SETTINGS_KEY: SETTINGS_KEY,
    SAMPLE_ID_RE: SAMPLE_ID_RE,
    FEEDBACK_PAGE_ISSUES: FEEDBACK_PAGE_ISSUES,
    FEEDBACK_BLOCK_ISSUES: FEEDBACK_BLOCK_ISSUES,
    normalizeSettings: normalizeSettings,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    shouldCollect: shouldCollect,
    makeSampleId: makeSampleId,
    joinUrl: joinUrl,
    buildRunManifest: buildRunManifest,
    buildUploadPayload: buildUploadPayload,
    feedbackInitialState: feedbackInitialState,
    isValidFeedbackOp: isValidFeedbackOp,
    buildPageFeedbackRequest: buildPageFeedbackRequest,
    buildPageClearRequest: buildPageClearRequest,
    buildBlockFeedbackRequest: buildBlockFeedbackRequest,
    applyFeedbackToState: applyFeedbackToState,
    requestJSON: requestJSON,
    getJSON: getJSON,
    postJSON: postJSON,
    testConnection: testConnection
  };
});
