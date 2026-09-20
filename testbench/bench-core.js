/* bench-core.js —— 仿真考试页 / Batch OCR Test Bench 的核心逻辑（纯函数，无 DOM 依赖）。
   既可在浏览器里用 <script> 引入（window.Bench），也可在 Node 里 require() 做单元测试。
   与正式 App（www/js/core.js）完全独立：不引用、不修改 App 的任何代码。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Bench = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LETTERS = "ABCDEFGH";
  var TYPE_NAMES = { single: "单选题", multi: "多选题", judge: "判断题" };
  var SECTION_TITLES = {
    single: "一、单项选择题（每题1分，共40分）",
    multi: "二、多项选择题（每题2分，共30分）",
    judge: "三、判断题（每题1分，共30分）"
  };
  var MODES = {
    "normal": "普通页（单一题型）",
    "single-multi": "单选 → 多选 跨块",
    "multi-judge": "多选 → 判断 跨块"
  };

  /* 确定性随机：同一 seed 永远生成同一页（mulberry32） */
  function mulberry32(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function intOr(v, def) {
    var n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  }
  function clampInt(v, lo, hi, def) {
    var n = intOr(v, def);
    return Math.min(hi, Math.max(lo, n));
  }

  /* 答案归一：支持 [2,3] / ["B","C"] / "BC" / 判断题的 [0]/[1]、"√"/"×"、"正确"/"错误" */
  function normalizeAnswer(q) {
    var type = q.type;
    var a = q.answer;
    if (type === "judge") {
      if (Array.isArray(a)) {
        if (a.length && typeof a[0] === "number") { return [a[0] === 0 ? 0 : 1]; }
        a = a[0];
      }
      var s = String(a == null ? "" : a).trim();
      if (s === "√" || s === "对" || s === "正确" || s === "A" || s === "0") { return [0]; }
      if (s === "×" || s === "错" || s === "错误" || s === "B" || s === "1") { return [1]; }
      return [];
    }
    var list = [];
    if (Array.isArray(a)) {
      a.forEach(function (x) {
        if (typeof x === "number") { list.push(x); }
        else { String(x).toUpperCase().split("").forEach(function (c) { var i = LETTERS.indexOf(c); if (i >= 0) { list.push(i); } }); }
      });
    } else {
      String(a == null ? "" : a).toUpperCase().split("").forEach(function (c) {
        var i = LETTERS.indexOf(c); if (i >= 0) { list.push(i); }
      });
    }
    var uniq = [];
    list.sort(function (x, y) { return x - y; }).forEach(function (x) {
      if (x >= 0 && uniq.indexOf(x) < 0) { uniq.push(x); }
    });
    return uniq;
  }

  /* 兼容两种题库结构：[...] 与 {questions:[...]}；字段缺失/多余都不影响使用 */
  function normalizeQuestions(raw) {
    var list = Array.isArray(raw) ? raw : ((raw && raw.questions) || []);
    var out = [];
    list.forEach(function (q, i) {
      if (!q) { return; }
      var type = (q.type === "single" || q.type === "multi" || q.type === "judge") ? q.type : "single";
      var stem = String(q.stem == null ? "" : q.stem).trim();
      var options = (q.options || []).map(function (o) { return String(o); });
      var answer = normalizeAnswer({ type: type, answer: q.answer });
      if (!stem || options.length < 2 || !answer.length) { return; }
      if (type === "judge" && options.length < 2) { options = ["正确", "错误"]; }
      out.push({
        id: q.id === undefined || q.id === null ? ("mock-" + (i + 1)) : q.id,
        type: type, type_name: TYPE_NAMES[type],
        stem: stem, options: options, answer: answer,
        tag: q.tag || ""
      });
    });
    return out;
  }

  function answerText(q) {
    if (!q || !q.answer || !q.answer.length) { return "?"; }
    if (q.type === "judge") { return q.answer[0] === 0 ? "√" : "×"; }
    return q.answer.slice().sort(function (a, b) { return a - b; })
      .map(function (i) { return LETTERS[i]; }).join("");
  }

  /* 分块计划：真实考试同一大块连续，一页最多在中间换一次大块 */
  function planSections(mode, type, count, splitAt) {
    if (mode === "single-multi") {
      var a = clampInt(splitAt, 1, count - 1, Math.ceil(count / 2));
      return [{ type: "single", count: a }, { type: "multi", count: count - a }];
    }
    if (mode === "multi-judge") {
      var b = clampInt(splitAt, 1, count - 1, Math.ceil(count / 2));
      return [{ type: "multi", count: b }, { type: "judge", count: count - b }];
    }
    return [{ type: type || "single", count: count }];
  }

  function pickPool(data, type, pool) {
    var all = data.filter(function (q) { return q.type === type; });
    if (!pool || pool === "all") { return all; }
    var tagged = all.filter(function (q) { return q.tag === pool; });
    return tagged.length ? tagged : all;
  }

  /* 确定性抽题：洗牌后取 n 个；题库不够时循环取，避免同页相邻重复 */
  function takeFrom(pool, n, rand) {
    var arr = pool.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    var out = [];
    if (!arr.length) { return out; }
    for (var k = 0; k < n; k++) { out.push(arr[k % arr.length]); }
    return out;
  }

  /* 生成一页：题目 + 大块结构 + Ground Truth（三者同源，保证一致） */
  function buildPage(spec) {
    var s = spec || {};
    var data = normalizeQuestions(s.data);
    var seed = clampInt(s.seed, 0, 2147483647, 1);
    var rand = mulberry32(seed);
    var count = clampInt(s.count, 1, 20, 5);
    var start = clampInt(s.startNumber, 1, 999, 1);
    var mode = MODES[s.mode] ? s.mode : "normal";
    var pool = s.pool || "all";
    var sections = planSections(mode, s.type, count, s.splitAt);
    var questions = [];
    var secMeta = [];
    var num = start;
    var usedFallback = false;
    sections.forEach(function (sec) {
      var p = pickPool(data, sec.type, pool);
      if (pool !== "all" && !data.filter(function (q) { return q.type === sec.type && q.tag === pool; }).length) {
        usedFallback = true;
      }
      var picked = takeFrom(p, sec.count, rand);
      var firstIndex = questions.length;
      picked.forEach(function (q) {
        questions.push({
          screenNumber: num++,
          bankId: q.id,
          type: sec.type,
          type_name: TYPE_NAMES[sec.type],
          answer: answerText(q),
          stem: q.stem,
          options: q.options.slice()
        });
      });
      secMeta.push({
        type: sec.type, type_name: TYPE_NAMES[sec.type],
        title: SECTION_TITLES[sec.type],
        count: picked.length, firstIndex: firstIndex,
        startNumber: firstIndex === 0 ? start : questions[firstIndex].screenNumber
      });
    });
    return {
      seed: seed,
      mode: mode,
      modeName: MODES[mode],
      type: sections[0].type,
      count: questions.length,
      startNumber: start,
      pool: pool,
      poolFallback: usedFallback,
      sections: secMeta,
      questions: questions
    };
  }

  /* Ground Truth：与页面同源；导出用，不含任何用户信息 */
  function buildGroundTruth(page, spec) {
    var s = spec || {};
    return {
      seed: page.seed,
      mode: page.mode,
      source: s.source || "mock",
      count: page.count,
      startNumber: page.startNumber,
      pool: page.pool,
      benchmark: s.benchmark || null,
      display: s.display ? JSON.parse(JSON.stringify(s.display)) : null,
      questions: page.questions.map(function (q) {
        return {
          screenNumber: q.screenNumber, bankId: q.bankId, type: q.type,
          answer: q.answer, stem: q.stem
        };
      })
    };
  }

  /* 与 App 结果自动比对（预留给以后真机对接；第一版只做纯函数）
     appResult: [{ screenNumber, matchedId, type, answer }, ...] */
  function compareBatchResult(appResult, groundTruth) {
    var gt = (groundTruth && groundTruth.questions) ? groundTruth.questions : (groundTruth || []);
    var app = appResult || [];
    var byScreen = {};
    app.forEach(function (r) {
      if (r && r.screenNumber !== undefined && r.screenNumber !== null) {
        byScreen[String(r.screenNumber)] = r;
      }
    });
    var out = {
      total: gt.length, screenNumberCorrect: 0, typeCorrect: 0,
      top1Correct: 0, answerCorrect: 0,
      answerCorrectStrict: 0, orderCorrect: 0, pageSplitCountCorrect: app.length === gt.length,
      missing: [], extra: [], details: []
    };
    var seen = {};
    gt.forEach(function (g, i) {
      var r = byScreen[String(g.screenNumber)];
      if (r) { seen[String(g.screenNumber)] = true; }
      var rec = {
        screenNumber: g.screenNumber, expectedType: g.type, expectedBankId: g.bankId,
        expectedAnswer: g.answer, gotType: r ? r.type : null,
        gotBankId: r ? r.matchedId : null, gotAnswer: r ? r.answer : null,
        screenNumberOk: !!r, typeOk: !!(r && r.type === g.type),
        top1Ok: !!(r && String(r.matchedId) === String(g.bankId)),
        answerOk: !!(r && r.answer === g.answer)
      };
      if (r) {
        out.screenNumberCorrect++;
        if (rec.typeOk) { out.typeCorrect++; }
        if (rec.top1Ok) { out.top1Correct++; }
        if (rec.answerOk) { out.answerCorrect++; }
        if (rec.top1Ok && rec.answerOk) { out.answerCorrectStrict++; }
        if (app[i] === r) { out.orderCorrect++; }
      } else {
        out.missing.push(g.screenNumber);
      }
      out.details.push(rec);
    });
    app.forEach(function (r) {
      if (r && !seen[String(r.screenNumber)]) { out.extra.push(r.screenNumber); }
    });
    return out;
  }

  /* ---------------- 固定基准（seed 与显示配置全部固化，便于复测） ---------------- */
  var DISPLAY_DEFAULT = {
    fontSize: "md", lineHeight: "normal", pageWidth: "normal",
    spacing: "normal", indent: true, headerStyle: "standard", zoom: 100, noise: false
  };

  var BENCHMARKS = [
    { id: "B01", name: "标准单选5题", seed: 20260901, config: { type: "single", count: 5, startNumber: 1, mode: "normal" },
      display: {} },
    { id: "B02", name: "标准多选5题", seed: 20260902, config: { type: "multi", count: 5, startNumber: 51, mode: "normal" },
      display: {} },
    { id: "B03", name: "标准判断8题", seed: 20260903, config: { type: "judge", count: 8, startNumber: 66, mode: "normal" },
      display: {} },
    { id: "B04", name: "单选10题密集", seed: 20260904, config: { type: "single", count: 10, startNumber: 31, mode: "normal" },
      display: { fontSize: "sm", lineHeight: "tight", spacing: "tight", indent: false } },
    { id: "B05", name: "长题干换行", seed: 20260905, config: { type: "single", count: 5, startNumber: 11, mode: "normal", pool: "long-stem" },
      display: {} },
    { id: "B06", name: "长选项换行", seed: 20260906, config: { type: "single", count: 5, startNumber: 21, mode: "normal", pool: "long-option" },
      display: { indent: true } },
    { id: "B07", name: "单选→多选跨块", seed: 20260907, config: { type: "single", count: 8, startNumber: 38, mode: "single-multi", splitAt: 4 },
      display: {} },
    { id: "B08", name: "多选→判断跨块", seed: 20260908, config: { type: "multi", count: 8, startNumber: 58, mode: "multi-judge", splitAt: 4 },
      display: {} },
    { id: "B09", name: "导航干扰页", seed: 20260909, config: { type: "single", count: 8, startNumber: 71, mode: "normal" },
      display: { noise: true, fontSize: "sm" } }
  ];

  function findBenchmark(id) {
    var key = String(id || "").toUpperCase();
    for (var i = 0; i < BENCHMARKS.length; i++) {
      if (BENCHMARKS[i].id === key) { return BENCHMARKS[i]; }
    }
    return null;
  }

  /* 把基准 + 覆盖项合并成完整配置 */
  function resolveConfig(benchId, overrides) {
    var b = findBenchmark(benchId);
    var cfg = {
      benchmark: b ? b.id : null,
      source: "mock", type: "single", count: 5, startNumber: 1, mode: "normal",
      splitAt: null, pool: "all", seed: 20260920
    };
    var display = {};
    Object.keys(DISPLAY_DEFAULT).forEach(function (k) { display[k] = DISPLAY_DEFAULT[k]; });
    if (b) {
      Object.keys(b.config).forEach(function (k) { cfg[k] = b.config[k]; });
      cfg.seed = b.seed;
      Object.keys(b.display).forEach(function (k) { display[k] = b.display[k]; });
    }
    var o = overrides || {};
    Object.keys(cfg).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== "") { cfg[k] = o[k]; } });
    if (o.display) { Object.keys(o.display).forEach(function (k) { if (o.display[k] !== undefined) { display[k] = o.display[k]; } }); }
    cfg.seed = clampInt(cfg.seed, 0, 2147483647, 20260920);
    cfg.display = display;
    return cfg;
  }

  return {
    LETTERS: LETTERS, TYPE_NAMES: TYPE_NAMES, SECTION_TITLES: SECTION_TITLES, MODES: MODES,
    DISPLAY_DEFAULT: DISPLAY_DEFAULT, BENCHMARKS: BENCHMARKS,
    mulberry32: mulberry32, normalizeAnswer: normalizeAnswer, normalizeQuestions: normalizeQuestions,
    answerText: answerText, planSections: planSections, buildPage: buildPage,
    buildGroundTruth: buildGroundTruth, compareBatchResult: compareBatchResult,
    findBenchmark: findBenchmark, resolveConfig: resolveConfig
  };
});
