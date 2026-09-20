/* app.js —— Batch OCR Test Bench 的界面逻辑。
   依赖 bench-core.js（window.Bench）；不使用任何框架与联网资源。
   只负责：读配置 → 生成页面 → 渲染仿真考试页 → 展示/导出 Ground Truth。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var DATA = { mock: null, private: null };
  var state = { config: null, page: null, gt: null, gtVisible: false };

  var COUNT_OPTIONS = [3, 5, 8, 10, 15];

  /* ---------------- 初始化 ---------------- */

  function init() {
    buildBenchmarkOptions();
    bindControls();
    var params = parseParams();
    loadData().then(function () {
      applyParams(params);
      regenerate();
      $("status").textContent = "就绪：seed=" + state.config.seed +
        (state.config.benchmark ? " · 基准 " + state.config.benchmark : "") +
        " · 数据源 " + state.config.source;
    }).catch(function (e) {
      $("status").textContent = "数据加载失败：" + e.message;
    });
  }

  function parseParams() {
    var q = {};
    location.search.replace(/^\?/, "").split("&").forEach(function (kv) {
      if (!kv) { return; }
      var i = kv.indexOf("=");
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
      q[k] = v;
    });
    return q;
  }

  function buildBenchmarkOptions() {
    var sel = $("c-benchmark");
    var opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（不使用基准，手动配置）";
    sel.appendChild(opt);
    Bench.BENCHMARKS.forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.id;
      o.textContent = b.id + " " + b.name + "（seed " + b.seed + "）";
      sel.appendChild(o);
    });
  }

  function loadData() {
    return fetchJSON("mock_questions.json").then(function (d) {
      DATA.mock = Bench.normalizeQuestions(d);
      if (!DATA.mock.length) { throw new Error("mock_questions.json 里没有可用题目"); }
      /* private 为可选：不存在时静默跳过（file:// 下 fetch 失败也走这里） */
      return fetchJSON("private_questions.json").then(function (p) {
        DATA.private = Bench.normalizeQuestions(p);
        if (DATA.private.length) {
          var o = $("opt-private");
          o.disabled = false;
          o.textContent = "private（本机真实题库 " + DATA.private.length + " 题）";
        }
      }, function () { /* 没有私有题库：保持禁用 */ });
    });
  }

  function fetchJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) { throw new Error(url + " HTTP " + r.status); }
      return r.json();
    });
  }

  /* ---------------- 控件 ---------------- */

  function bindControls() {
    var map = {
      "c-benchmark": ["benchmark", "str"], "c-source": ["source", "str"],
      "c-type": ["type", "str"], "c-count": ["count", "int"],
      "c-mode": ["mode", "str"], "c-splitAt": ["splitAt", "int"],
      "c-startNumber": ["startNumber", "int"], "c-seed": ["seed", "int"],
      "c-pool": ["pool", "str"]
    };
    Object.keys(map).forEach(function (id) {
      $(id).addEventListener("change", function () {
        if (id === "c-benchmark") { applyBenchmark($(id).value); }
        regenerate();
      });
    });
    var disp = { "d-fontSize": "fontSize", "d-lineHeight": "lineHeight", "d-pageWidth": "pageWidth",
      "d-spacing": "spacing", "d-headerStyle": "headerStyle", "d-zoom": "zoom" };
    Object.keys(disp).forEach(function (id) {
      $(id).addEventListener("change", regenerate);
    });
    $("d-indent").addEventListener("change", regenerate);
    $("d-noise").addEventListener("change", regenerate);
    $("btn-regen").addEventListener("click", regenerate);
    $("btn-gt").addEventListener("click", function () { toggleGT(!state.gtVisible); });
    $("btn-gt-close").addEventListener("click", function () { toggleGT(false); });
    $("btn-copy").addEventListener("click", copyGT);
    $("btn-download").addEventListener("click", downloadGT);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { toggleGT(false); }
    });
  }

  /* 把值写进 select；若下拉里没有该值（基准配置用了非预设题数）则动态补一个，
     避免静默沿用旧值导致基准与页面不一致。 */
  function setSelect(sel, value) {
    var v = String(value);
    var found = false;
    for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === v) { found = true; break; } }
    if (!found) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v + "（基准预设）";
      sel.appendChild(o);
    }
    sel.value = v;
  }

  function applyBenchmark(id) {
    var b = Bench.findBenchmark(id);
    if (!b) { return; }
    setSelect($("c-type"), b.config.type);
    setSelect($("c-count"), b.config.count);
    setSelect($("c-mode"), b.config.mode);
    if (b.config.splitAt) { $("c-splitAt").value = String(b.config.splitAt); }
    $("c-startNumber").value = String(b.config.startNumber);
    $("c-seed").value = String(b.seed);
    setSelect($("c-pool"), b.config.pool || "all");
    var d = b.display || {};
    setSelect($("d-fontSize"), d.fontSize || "md");
    setSelect($("d-lineHeight"), d.lineHeight || "normal");
    setSelect($("d-pageWidth"), d.pageWidth || "normal");
    setSelect($("d-spacing"), d.spacing || "normal");
    setSelect($("d-headerStyle"), d.headerStyle || "standard");
    setSelect($("d-zoom"), d.zoom || 100);
    $("d-indent").checked = d.indent !== false;
    $("d-noise").checked = !!d.noise;
  }

  function applyParams(q) {
    if (q.benchmark) {
      var b = Bench.findBenchmark(q.benchmark);
      if (b) { $("c-benchmark").value = b.id; applyBenchmark(b.id); }
    }
    if (q.seed) { $("c-seed").value = q.seed; }
    if (q.count && COUNT_OPTIONS.indexOf(parseInt(q.count, 10)) >= 0) { $("c-count").value = q.count; }
    if (q.type) { $("c-type").value = q.type; }
    if (q.start) { $("c-startNumber").value = q.start; }
    if (q.source === "private" && DATA.private && DATA.private.length) { $("c-source").value = "private"; }
    if (q.mode) { $("c-mode").value = q.mode; }
  }

  /* ---------------- 生成与渲染 ---------------- */

  function readConfig() {
    var benchId = $("c-benchmark").value;
    var source = $("c-source").value === "private" ? "private" : "mock";
    var overrides = {
      benchmark: benchId || null,
      source: source,
      type: $("c-type").value,
      count: parseInt($("c-count").value, 10),
      mode: $("c-mode").value,
      splitAt: parseInt($("c-splitAt").value, 10) || null,
      startNumber: parseInt($("c-startNumber").value, 10),
      seed: parseInt($("c-seed").value, 10),
      pool: $("c-pool").value,
      display: {
        fontSize: $("d-fontSize").value, lineHeight: $("d-lineHeight").value,
        pageWidth: $("d-pageWidth").value, spacing: $("d-spacing").value,
        headerStyle: $("d-headerStyle").value, zoom: parseInt($("d-zoom").value, 10),
        indent: $("d-indent").checked, noise: $("d-noise").checked
      }
    };
    return Bench.resolveConfig(benchId, overrides);
  }

  function regenerate() {
    var cfg = readConfig();
    var data = (cfg.source === "private" && DATA.private && DATA.private.length) ? DATA.private : DATA.mock;
    if (!data || !data.length) { return; }
    cfg.source = (cfg.source === "private" && DATA.private && DATA.private.length) ? "private" : "mock";
    var page = Bench.buildPage({
      data: data, seed: cfg.seed, type: cfg.type, count: cfg.count,
      startNumber: cfg.startNumber, mode: cfg.mode, splitAt: cfg.splitAt, pool: cfg.pool
    });
    state.config = cfg;
    state.page = page;
    state.gt = Bench.buildGroundTruth(page, cfg);
    renderExam(page, cfg.display);
    renderGT(state.gt);
    $("l-split").classList.toggle("hidden", cfg.mode === "normal");
    $("status").textContent = "seed=" + page.seed + " ｜ 题数 " + page.count + " ｜ 题号 " +
      page.questions[0].screenNumber + "~" + page.questions[page.questions.length - 1].screenNumber +
      " ｜ " + page.modeName + (cfg.source === "private" ? " ｜ private 真实题库" : " ｜ mock 模拟题") +
      (page.poolFallback ? " ｜ 该题型无此标签题目，已回退全部" : "");
  }

  function renderExam(page, display) {
    var exam = $("exam");
    exam.className = "exam fs-" + display.fontSize + " lh-" + display.lineHeight +
      " sp-" + display.spacing + " pw-" + display.pageWidth;
    exam.style.zoom = (display.zoom || 100) + "%";
    $("exam-type").textContent = "题型：" + (page.sections.length > 1
      ? page.sections.map(function (s) { return s.type_name; }).join(" + ")
      : Bench.TYPE_NAMES[page.type]);
    $("exam-page").textContent = "第 1 / 1 页";
    $("exam-pager").textContent = "1 / 1";
    $("exam-noise-top").classList.toggle("hidden", !display.noise);
    var body = $("exam-body");
    body.innerHTML = "";
    var secIdx = 0;
    page.questions.forEach(function (q, i) {
      /* 大块标题：只在块首渲染；单一题型页也渲染（模拟真实卷面） */
      var sec = page.sections[secIdx];
      if (sec && sec.firstIndex === i) {
        var h = document.createElement("h3");
        h.className = "section-title " + display.headerStyle;
        h.textContent = sec.title;
        body.appendChild(h);
        secIdx++;
      }
      var wrap = document.createElement("div");
      wrap.className = "q";
      var stem = document.createElement("p");
      stem.className = "q-stem";
      var no = document.createElement("span");
      no.className = "q-no";
      no.textContent = q.screenNumber + ".";
      stem.appendChild(no);
      stem.appendChild(document.createTextNode(" " + q.stem));
      wrap.appendChild(stem);
      q.options.forEach(function (opt, oi) {
        var p = document.createElement("p");
        p.className = "q-opt" + (display.indent ? " indent" : "");
        p.textContent = Bench.LETTERS[oi] + ". " + opt;
        wrap.appendChild(p);
      });
      body.appendChild(wrap);
    });
    if (display.noise) {
      var tail = document.createElement("div");
      tail.className = "exam-noise";
      tail.style.borderTop = "1px solid #e6ebf3";
      tail.style.borderBottom = "none";
      tail.textContent = "第 1 页 / 共 1 页 ｜ 本页 " + page.count + " 题 ｜ 试卷代码 2026-MKT-01 ｜ 请勿在试卷上做标记";
      body.appendChild(tail);
    }
  }

  /* ---------------- Ground Truth ---------------- */

  function renderGT(gt) {
    var t = $("gt-table");
    t.innerHTML = "";
    var head = document.createElement("tr");
    ["题号", "题型", "bankId", "答案", "题干"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    });
    t.appendChild(head);
    gt.questions.forEach(function (q) {
      var tr = document.createElement("tr");
      [q.screenNumber, q.type, q.bankId, q.answer, q.stem.slice(0, 18) + (q.stem.length > 18 ? "…" : "")]
        .forEach(function (v, i) {
          var td = document.createElement("td");
          td.textContent = v;
          if (i === 3) { td.className = "ans"; }
          tr.appendChild(td);
        });
      t.appendChild(tr);
    });
    $("gt-json").value = gtJSON();
  }

  function gtJSON() {
    return JSON.stringify(state.gt, null, 2);
  }

  function toggleGT(show) {
    state.gtVisible = show;
    $("gt-panel").classList.toggle("hidden", !show);
    $("btn-gt").textContent = show ? "隐藏标准答案" : "显示标准答案";
  }

  function copyGT() {
    var text = gtJSON();
    var msg = $("copy-msg");
    var done = function (ok) {
      msg.textContent = ok ? "已复制到剪贴板（" + state.gt.questions.length + " 条）"
        : "浏览器不允许自动复制，请在下方 JSON 框里手动全选复制";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = $("gt-json");
      ta.removeAttribute("readonly");
      ta.select();
      var ok = document.execCommand("copy");
      ta.setAttribute("readonly", "readonly");
      return ok;
    } catch (e) { return false; }
  }

  function downloadGT() {
    var blob = new Blob([gtJSON()], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "groundtruth_" + (state.config.benchmark || "custom") + "_seed" + state.gt.seed + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $("copy-msg").textContent = "已下载 " + a.download + "（仅保存在本机）";
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); }
  else { init(); }
})();
