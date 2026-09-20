/* core.js —— 纯业务逻辑（无 DOM 依赖），供 app.js 与 Node 自检共用 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.MSQ = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LETTERS = "ABCDEF";
  var TYPE_ORDER = ["single", "multi", "judge"];
  var TYPE_NAMES = { single: "单选题", multi: "多选题", judge: "判断题" };

  /* 模拟考试默认结构。运行时覆盖顺序：
     www/data/config.js（文件默认值） -> localStorage 用户改动。业务代码不写死。 */
  var DEFAULT_EXAM_CONFIG = {
    single_count: 40, multi_count: 15, judge_count: 30,
    single_score: 1, multi_score: 2, judge_score: 1
  };
  var COUNT_KEYS = { single: "single_count", multi: "multi_count", judge: "judge_count" };
  var SCORE_KEYS = { single: "single_score", multi: "multi_score", judge: "judge_score" };

  function intVal(v, fallback) {
    var n = parseInt(v, 10);
    return (typeof n === "number" && isFinite(n) && n >= 0) ? n : fallback;
  }

  function normalizeConfig(raw) {
    raw = raw || {};
    var cfg = {};
    for (var k in DEFAULT_EXAM_CONFIG) { cfg[k] = intVal(raw[k], DEFAULT_EXAM_CONFIG[k]); }
    return cfg;
  }

  function indexByType(questions) {
    var m = { single: [], multi: [], judge: [] };
    (questions || []).forEach(function (q) { if (m[q.type]) { m[q.type].push(q); } });
    return m;
  }

  /* 多选/单选/判断统一按集合判定：所选集合必须与标准答案集合完全一致 */
  function isCorrect(q, selected) {
    var a = new Set(q.answer || []);
    var s = new Set(selected || []);
    if (a.size !== s.size) { return false; }
    var it = s.values();
    var r = it.next();
    while (!r.done) { if (!a.has(r.value)) { return false; } r = it.next(); }
    return true;
  }

  function answerText(q) {
    return (q.answer || []).slice().sort(function (x, y) { return x - y; })
      .map(function (i) { return LETTERS[i]; }).join("");
  }

  function shuffled(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 按配置从各题型随机抽题（题型内无重复），组卷按 单选->多选->判断 */
  function generateExam(byType, cfg, rng) {
    rng = rng || Math.random;
    var paper = [];
    TYPE_ORDER.forEach(function (t) {
      paper = paper.concat(shuffled(byType[t] || [], rng).slice(0, cfg[COUNT_KEYS[t]]));
    });
    return paper;
  }

  /* answers: {qid: 选项下标数组}。返回 {score, full, detail:{type:[对,错]}, wrong:[qid]} */
  function scoreExam(paper, answers, cfg) {
    var detail = { single: [0, 0], multi: [0, 0], judge: [0, 0] };
    var wrong = [], score = 0, full = 0;
    (paper || []).forEach(function (q) {
      var t = q.type;
      full += cfg[SCORE_KEYS[t]];
      detail[t][1]++;
      if (isCorrect(q, answers[q.id])) { detail[t][0]++; score += cfg[SCORE_KEYS[t]]; }
      else { wrong.push(q.id); }
    });
    return { score: score, full: full, detail: detail, wrong: wrong };
  }

  /* 打乱一道题的选项顺序，并同步重映射答案下标。
     返回全新题对象（含原题所有字段），绝不修改传入的原始题库数据。
     例: options=[甲,乙,丙,丁] answer=[1,3] 打乱为 [丁,甲,乙,丙] 后 answer 自动变为 [0,2]。 */
  function shuffleQuestionOptions(question, rng) {
    rng = rng || Math.random;
    var opts = question.options || [];
    var perm = [];
    for (var i = 0; i < opts.length; i++) { perm.push(i); }
    for (var j = perm.length - 1; j > 0; j--) {
      var k = Math.floor(rng() * (j + 1));
      var t = perm[j]; perm[j] = perm[k]; perm[k] = t;
    }
    var newOpts = perm.map(function (orig) { return opts[orig]; });
    var newAnswer = [];
    for (var p = 0; p < perm.length; p++) {
      if ((question.answer || []).indexOf(perm[p]) >= 0) { newAnswer.push(p); }
    }
    var copy = {};
    for (var key in question) { copy[key] = question[key]; }
    copy.options = newOpts;
    copy.answer = newAnswer;
    return copy;
  }

  /* 解析背题模式跳转输入。raw 为用户输入文本，total 为当前题目总数。
     合法时返回 {ok:true, index: 题号-1}；非法时返回 {ok:false, reason: 提示文案}。 */
  function parseJumpTarget(raw, total) {
    var s = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!/^\d+$/.test(s)) {
      return { ok: false, reason: "请输入整数题号（1 ~ " + total + "）" };
    }
    var n = parseInt(s, 10);
    if (n < 1) { return { ok: false, reason: "题号不能小于 1" }; }
    if (n > total) { return { ok: false, reason: "题号不能超过当前题目总数 " + total }; }
    return { ok: true, index: n - 1 };
  }

  /* 解析滑动翻页手势（横向 + 纵向）。
     dx/dy 为位移，dt 为手势时长(ms)，scrolled 为手势期间页面滚动位移(px)。
     返回 "next" / "prev" / null（null = 不翻页）。
     横向：|dx|>64 且 |dy|<48 且 |dx|>|dy|*2（保持原有行为，不受页面滚动影响）。
     纵向：|dy|>=90 且 |dy|>|dx|*2 且手势期间未发生明显滚动（>=32px 视为滚动，优先滚动），
           防止与长题干页面的正常上下滚动冲突。超时 700ms 一律不触发。 */
  function resolveSwipe(dx, dy, dt, scrolled) {
    var adx = Math.abs(dx), ady = Math.abs(dy);
    if (dt > 700) { return null; }
    if (adx > 64 && ady < 48 && adx > ady * 2) { return dx < 0 ? "next" : "prev"; }
    if (ady >= 90 && ady > adx * 2 && (scrolled || 0) < 32) { return dy < 0 ? "next" : "prev"; }
    return null;
  }

  /* ---------------- 本地搜题 ---------------- */

  /* 搜索规范化：NFKC（全角->半角等） + 小写 + 去除所有非文字/数字字符
     （空格、换行、中英文标点、引号等全部剔除），使
     “工作负责人（监护人）”、工作负责人(监护人)、工作负责人 监护人 归一为 工作负责人监护人。 */
  function normalizeSearchText(text) {
    return String(text == null ? "" : text)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  /* 规范化并保留 原文字符位置 映射（供 UI 高亮，把规范化命中位置映射回原文下标） */
  function normalizeWithMap(text) {
    var s = String(text == null ? "" : text).normalize("NFKC").toLowerCase();
    var out = [], map = [];
    for (var i = 0; i < s.length; i++) {
      if (/[\p{L}\p{N}]/u.test(s[i])) { out.push(s[i]); map.push(i); }
    }
    return { text: out.join(""), map: map };
  }

  /* 一次性构建搜索索引（题库加载后调用，之后每次输入零预处理）。 */
  function buildSearchIndex(questions, explanations) {
    return (questions || []).map(function (q) {
      var item = {
        id: q.id,
        type: q.type,
        type_name: q.type_name,
        stem: q.stem,
        options: q.options,
        normalizedStem: normalizeSearchText(q.stem),
        normalizedOptions: (q.options || []).map(normalizeSearchText),
        normalizedAll: normalizeSearchText(q.stem + "\n" + (q.options || []).join("\n"))
      };
      var exp = explanations ? explanations[String(q.id)] : null;
      item.normalizedExplanation = exp
        ? normalizeSearchText((exp.reason || "") + "\n" + (exp.memory || ""))
        : "";
      return item;
    });
  }

  function gramSet(s) {
    var g = {};
    var n = 0;
    if (s.length < 2) { if (s) { g[s] = true; n = 1; } return { g: g, n: n }; }
    for (var i = 0; i < s.length - 1; i++) {
      var b = s.slice(i, i + 2);
      if (!g[b]) { g[b] = true; n++; }
    }
    return { g: g, n: n };
  }

  /* 查询 bigram 在目标串中的包含率（0~1）。轻量模糊：少打/错打一两个字仍能召回。 */
  function bigramContainment(query, target) {
    var qg = gramSet(query);
    if (!qg.n) { return 0; }
    var tg = gramSet(target).g;
    var hit = 0;
    for (var b in qg.g) { if (tg[b]) { hit++; } }
    return hit / qg.n;
  }

  /* 分层搜题。返回按相关度降序的数组（每项含 score/tier/hitOption）。
     匹配顺序固定：题干精确 > 题干全部关键词 > 题干部分关键词 > 选项 > 模糊 > 解析(最低)。 */
  function searchQuestions(index, query) {
    var qRaw = String(query == null ? "" : query).trim();
    if (!qRaw) { return []; }
    var qNorm = normalizeSearchText(qRaw);
    if (!qNorm) { return []; }
    var kws = qRaw.split(/\s+/).map(normalizeSearchText).filter(function (k) { return k; });
    if (!kws.length) { kws = [qNorm]; }
    var results = [];
    for (var i = 0; i < index.length; i++) {
      var it = index[i];
      var score = 0, tier = 0, hitOption = null;
      if (qNorm.length >= 2 && it.normalizedStem.indexOf(qNorm) >= 0) {
        tier = 1;
        score = 10000 + qNorm.length * 5;
      }
      if (tier === 0 && kws.every(function (k) { return it.normalizedStem.indexOf(k) >= 0; })) {
        tier = 2;
        var kwLen = kws.reduce(function (s, k) { return s + k.length; }, 0);
        score = 8000 + Math.round(kwLen / Math.max(it.normalizedStem.length, 1) * 1000) + kwLen * 5;
      }
      if (tier === 0) {
        var hits = kws.filter(function (k) { return it.normalizedStem.indexOf(k) >= 0; });
        if (hits.length) {
          tier = 3;
          score = 5000 + hits.length * 200 + hits.reduce(function (s, k) { return s + k.length; }, 0);
        }
      }
      if (tier === 0) {
        var inOptions = function (k) {
          return it.normalizedOptions.some(function (o) { return o.indexOf(k) >= 0; });
        };
        var exactOpt = qNorm.length >= 2 && it.normalizedOptions.some(function (o) { return o.indexOf(qNorm) >= 0; });
        if (exactOpt || kws.every(inOptions)) {
          tier = 4;
          score = exactOpt ? 3500 : 3000;
          for (var oi = 0; oi < it.normalizedOptions.length; oi++) {
            var match = qNorm.length >= 2 && it.normalizedOptions[oi].indexOf(qNorm) >= 0;
            if (!match) { match = kws.length && kws.every((function (o) {
              return function (k) { return o.indexOf(k) >= 0; };
            })(it.normalizedOptions[oi])); }
            if (match) { hitOption = it.options[oi]; break; }
          }
        }
      }
      if (tier === 0 && qNorm.length >= 3) {
        var sim = bigramContainment(qNorm, it.normalizedStem);
        if (sim >= 0.5) { tier = 5; score = 1000 + Math.round(sim * 800); }
      }
      if (tier === 0 && it.normalizedExplanation && kws.every(function (k) {
        return it.normalizedExplanation.indexOf(k) >= 0;
      })) {
        tier = 6;
        score = 300;
      }
      if (score > 0) {
        results.push({ id: it.id, type: it.type, type_name: it.type_name,
          stem: it.stem, options: it.options, score: score, tier: tier, hitOption: hitOption });
      }
    }
    results.sort(function (a, b) { return b.score - a.score || a.id - b.id; });
    return results;
  }

  return {
    LETTERS: LETTERS, TYPE_ORDER: TYPE_ORDER, TYPE_NAMES: TYPE_NAMES,
    DEFAULT_EXAM_CONFIG: DEFAULT_EXAM_CONFIG,
    COUNT_KEYS: COUNT_KEYS, SCORE_KEYS: SCORE_KEYS,
    normalizeConfig: normalizeConfig, indexByType: indexByType,
    isCorrect: isCorrect, answerText: answerText, shuffled: shuffled,
    shuffleQuestionOptions: shuffleQuestionOptions, parseJumpTarget: parseJumpTarget,
    resolveSwipe: resolveSwipe,
    normalizeSearchText: normalizeSearchText, normalizeWithMap: normalizeWithMap,
    buildSearchIndex: buildSearchIndex, searchQuestions: searchQuestions,
    generateExam: generateExam, scoreExam: scoreExam
  };
});
