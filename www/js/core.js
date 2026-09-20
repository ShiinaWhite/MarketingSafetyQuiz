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

  /* ---------------- 本地搜题（原文连续子串，标点敏感，无模糊/无解析） ---------------- */

  /* 轻量索引：仅保留原始字段，不做任何规范化。 */
  function buildSearchIndex(questions) {
    return (questions || []).map(function (q) {
      return {
        id: q.id,
        type: q.type,
        type_name: q.type_name,
        stem: q.stem,
        options: q.options
      };
    });
  }

  /* 原文连续子串搜索：查询只做 trim，内部字符（标点/空格/括号等）原样参与匹配。
     Tier 1 = 题干原文命中（排最前）；Tier 2 = 选项原文命中。
     同层内：query 占原文比例高者优先 -> 题干短者优先 -> 题号排序。 */
  function searchQuestions(index, query) {
    var q = String(query == null ? "" : query).trim();
    if (!q) { return []; }
    var results = [];
    for (var i = 0; i < index.length; i++) {
      var it = index[i];
      if (it.stem.indexOf(q) >= 0) {
        results.push({ id: it.id, type: it.type, type_name: it.type_name,
          stem: it.stem, options: it.options, tier: 1, hitOption: null,
          score: q.length / Math.max(it.stem.length, 1) });
        continue;
      }
      var hit = null;
      for (var oi = 0; oi < it.options.length; oi++) {
        if (it.options[oi].indexOf(q) >= 0) { hit = it.options[oi]; break; }
      }
      if (hit !== null) {
        results.push({ id: it.id, type: it.type, type_name: it.type_name,
          stem: it.stem, options: it.options, tier: 2, hitOption: hit,
          score: q.length / Math.max(hit.length, 1) });
      }
    }
    results.sort(function (a, b) {
      return a.tier - b.tier || b.score - a.score ||
             a.stem.length - b.stem.length || a.id - b.id;
    });
    return results;
  }

  /* ---------------- 拍照搜题（OCR 匹配，独立于手动搜索） ---------------- */

  /* OCR 文本规范化：NFKC + 小写；标点/符号转为空格（保留词边界供拆短语）；
     去除行首/词首 A./B./F. 这类识别出的选项标签。只供拍照搜题使用，
     手动搜索（searchQuestions，原文连续子串、标点敏感）完全不受影响。 */
  function normalizeOcrText(text) {
    var s = String(text == null ? "" : text).normalize("NFKC").toLowerCase();
    s = s.replace(/(^|[^\p{L}\p{N}])[a-f][.、．]\s*/gu, "$1");
    s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return s.replace(/\s+/g, " ");
  }

  /* 拍照搜题索引：预生成 OCR 规范化题干/选项（题库加载后一次性构建）。 */
  function buildOcrIndex(questions) {
    return (questions || []).map(function (q) {
      return {
        id: q.id,
        type: q.type,
        type_name: q.type_name,
        stem: q.stem,
        options: q.options,
        ocrStem: normalizeOcrText(q.stem),
        ocrOptions: (q.options || []).map(normalizeOcrText)
      };
    });
  }

  function gramCount(s) {
    var g = {};
    var n = 0;
    if (s.length < 2) { if (s) { g[s] = true; n = 1; } return { g: g, n: n }; }
    for (var i = 0; i < s.length - 1; i++) {
      var b = s.slice(i, i + 2);
      if (!g[b]) { g[b] = true; n++; }
    }
    return { g: g, n: n };
  }

  /* 查询 bigram 在目标中的包含率（容忍 OCR 少量错字/漏字）。
     可传入预计算的查询 grams（同一查询对 392 题复用，避免重复构建）。 */
  function bigramRatio(query, target, precomputed) {
    var qg = precomputed || gramCount(query);
    if (!qg.n) { return 0; }
    var tg = gramCount(target).g;
    var hit = 0;
    for (var b in qg.g) { if (tg[b]) { hit++; } }
    return hit / qg.n;
  }

  /* 在 phrase 中找最长的 8~20 字连续窗口，使其完整出现在 target 中（层1核心）。
     先用 bigram 粗筛跳过明显不相关的 phrase，避免全量窗口扫描。 */
  function longestRunIn(phrase, target) {
    if (phrase.length < 8) { return target.indexOf(phrase) >= 0 ? phrase.length : 0; }
    if (bigramRatio(phrase, target) < 0.35) { return 0; }
    var maxLen = Math.min(20, phrase.length);
    for (var len = maxLen; len >= 8; len--) {
      for (var start = 0; start + len <= phrase.length; start++) {
        if (target.indexOf(phrase.substr(start, len)) >= 0) { return len; }
      }
    }
    return 0;
  }

  /* OCR 匹配（与手动搜索完全分离）。
     层1：较长连续片段直接命中题干（8~20 字，越长分越高）
     层2：多个 OCR 短语共同命中同一题（短语覆盖计数）
     层3：最长短语的 bigram 包含率容错（OCR 错字）
     辅助：选项低权重加分，避免选项常见词反超题干命中。 */
  function searchQuestionsByOcr(ocrIndex, ocrText) {
    var norm = normalizeOcrText(ocrText);
    if (!norm) { return []; }
    var seen = {};
    var phrases = [];
    norm.split(" ").forEach(function (p) {
      if (p.length >= 4 && !seen[p]) { seen[p] = true; phrases.push(p); }
    });
    if (!phrases.length) { return []; }
    phrases.sort(function (a, b) { return b.length - a.length; });
    var longest = phrases[0];
    var longestGrams = gramCount(longest);

    /* IDF：套话短语（如"根据营销安规规定"，几乎每题都有）判别力低，
       罕见短语命中权重高。df 在本次查询内统计。 */
    var N = ocrIndex.length;
    var idf = phrases.map(function (p) {
      var df = 0;
      for (var d = 0; d < N; d++) {
        if (ocrIndex[d].ocrStem.indexOf(p) >= 0) { df++; }
      }
      return Math.max(0.5, Math.log((N + 1) / (df + 1)) * 2);
    });

    var results = [];
    for (var i = 0; i < ocrIndex.length; i++) {
      var it = ocrIndex[i];
      var bestRun = 0, bestRunIdf = 0, fullHitIdf = 0, weightedHits = 0, optHits = 0;
      for (var pi = 0; pi < phrases.length; pi++) {
        var p = phrases[pi];
        if (it.ocrStem.indexOf(p) >= 0) {
          weightedHits += idf[pi];
          fullHitIdf += idf[pi];
          if (p.length > bestRun) { bestRun = p.length; bestRunIdf = idf[pi]; }
          continue;
        }
        var run = longestRunIn(p, it.ocrStem);
        if (run / p.length >= 0.6) { weightedHits += idf[pi] * 0.5; }
        if (run > bestRun) { bestRun = run; bestRunIdf = idf[pi]; }
        for (var oi = 0; oi < it.ocrOptions.length; oi++) {
          if (it.ocrOptions[oi].indexOf(p) >= 0) { optHits += idf[pi] * 0.5; break; }
        }
      }
      /* 稀有长连续段是主判别力：run 同时乘自身 IDF；
         完整短语命中的 IDF 单独加分（真源通常完整包含多个短语）。 */
      var sim = 0;
      if (bestRun >= 6 || weightedHits > 0 || optHits > 0) {
        var ratio = bigramRatio(longest, it.ocrStem, longestGrams);
        if (ratio >= 0.55) { sim = ratio; }
      }
      var score = Math.round(bestRun * (100 + bestRunIdf * 10))
        + Math.round(fullHitIdf * 20) + Math.round(weightedHits * 10)
        + Math.round(bestRun / Math.max(it.ocrStem.length, 1) * 400)
        + Math.round(sim * 300) + Math.round(optHits * 30);
      if (score > 0) {
        results.push({ id: it.id, type: it.type, type_name: it.type_name,
          stem: it.stem, options: it.options, score: score,
          bestRun: bestRun, phraseHits: Math.round(weightedHits * 10) / 10,
          sim: sim, optHits: Math.round(optHits * 10) / 10 });
      }
    }
    results.sort(function (a, b) {
      return b.score - a.score || a.stem.length - b.stem.length || a.id - b.id;
    });
    return results;
  }

  /* 置信度：不要把低分结果冒充确定答案。
     非常确定 = Top1 分数足够高且明显领先 Top2；否则给出候选列表。 */
  function ocrConfidence(matches) {
    if (!matches || !matches.length) { return { level: "none", matches: [] }; }
    var t1 = matches[0];
    if (matches.length === 1) {
      return { level: t1.score >= 60 ? "confident" : "candidates", matches: matches };
    }
    var t2 = matches[1];
    var lead = t2.score > 0 ? t1.score / t2.score : 2;
    var ok = t1.score >= 60 && lead >= 1.25;
    return { level: ok ? "confident" : "candidates", matches: matches };
  }

  return {
    LETTERS: LETTERS, TYPE_ORDER: TYPE_ORDER, TYPE_NAMES: TYPE_NAMES,
    DEFAULT_EXAM_CONFIG: DEFAULT_EXAM_CONFIG,
    COUNT_KEYS: COUNT_KEYS, SCORE_KEYS: SCORE_KEYS,
    normalizeConfig: normalizeConfig, indexByType: indexByType,
    isCorrect: isCorrect, answerText: answerText, shuffled: shuffled,
    shuffleQuestionOptions: shuffleQuestionOptions, parseJumpTarget: parseJumpTarget,
    resolveSwipe: resolveSwipe,
    buildSearchIndex: buildSearchIndex, searchQuestions: searchQuestions,
    normalizeOcrText: normalizeOcrText, buildOcrIndex: buildOcrIndex,
    searchQuestionsByOcr: searchQuestionsByOcr, ocrConfidence: ocrConfidence,
    generateExam: generateExam, scoreExam: scoreExam
  };
});
