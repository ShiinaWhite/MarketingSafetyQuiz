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

  /* 文字搜题题型筛选：在 searchQuestions 已排好序的结果上做一次 Array.filter，
     只按 type 摘取，不重新搜索、不重新排序，原相关度顺序原样保留。
     type 为 "all"/空/未知 时原样返回同一数组（不因取值异常把结果清空）。 */
  function filterSearchResults(results, type) {
    var list = results || [];
    if (type !== "single" && type !== "multi" && type !== "judge") { return list; }
    return list.filter(function (r) { return r.type === type; });
  }

  /* 按题型统计原始搜索结果数量（筛选按钮上的数字与提示文案共用同一份真实计数）。 */
  function countSearchResultsByType(results) {
    var c = { all: 0, single: 0, multi: 0, judge: 0 };
    var list = results || [];
    for (var i = 0; i < list.length; i++) {
      c.all++;
      if (c[list[i].type] != null) { c[list[i].type]++; }
    }
    return c;
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
  function bigramRatio(query, target, precomputed, targetGrams) {
    var qg = precomputed || gramCount(query);
    if (!qg.n) { return 0; }
    var tg = targetGrams || gramCount(target).g;
    var hit = 0;
    for (var b in qg.g) { if (tg[b]) { hit++; } }
    return hit / qg.n;
  }

  /* 在 phrase 中找最长的 8~20 字连续窗口，使其完整出现在 target 中（层1核心）。
     先用 bigram 粗筛跳过明显不相关的 phrase，避免全量窗口扫描。 */
  function longestRunIn(phrase, target, minRun, targetGrams) {
    var mr = minRun || 8;
    if (phrase.length < mr) { return target.indexOf(phrase) >= 0 ? phrase.length : 0; }
    if (bigramRatio(phrase, target, null, targetGrams) < 0.35) { return 0; }
    var maxLen = Math.min(20, phrase.length);
    for (var len = maxLen; len >= mr; len--) {
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
     辅助：选项低权重加分，避免选项常见词反超题干命中。
     candidates 为候选集合：单题拍照传入全部 392 题，整页模式传入题型过滤后的子集，
     评分公式完全一致，IDF 在候选集合内统计。 */
  function matchOcrCandidates(candidates, ocrText, options) {
    var opts = options || {};
    var MIN_RUN = opts.minRun || 8;
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
    var N = candidates.length;
    var idf = phrases.map(function (p) {
      var df = 0;
      for (var d = 0; d < N; d++) {
        if (candidates[d].ocrStem.indexOf(p) >= 0) { df++; }
      }
      return Math.max(0.5, Math.log((N + 1) / (df + 1)) * 2);
    });

    var results = [];
    for (var i = 0; i < candidates.length; i++) {
      var it = candidates[i];
      /* 候选题干的 bigram 集合按题缓存一次（纯函数结果，不改变任何计算） */
      var stemGrams = it.ocrStemGrams || (it.ocrStemGrams = gramCount(it.ocrStem).g);
      var bestRun = 0, bestRunIdf = 0, fullHitIdf = 0, weightedHits = 0, optHits = 0;
      for (var pi = 0; pi < phrases.length; pi++) {
        var p = phrases[pi];
        if (it.ocrStem.indexOf(p) >= 0) {
          weightedHits += idf[pi];
          fullHitIdf += idf[pi];
          if (p.length > bestRun) { bestRun = p.length; bestRunIdf = idf[pi]; }
          continue;
        }
        var run = longestRunIn(p, it.ocrStem, MIN_RUN, stemGrams);
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
        var ratio = bigramRatio(longest, it.ocrStem, longestGrams, stemGrams);
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

  /* 单题拍照搜题入口：候选为全部题目，行为与历史版本完全一致。 */
  function searchQuestionsByOcr(ocrIndex, ocrText) {
    return matchOcrCandidates(ocrIndex, ocrText);
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

  /* ---------------- 整页拍照搜题（分题 + 题型强约束批量匹配） ----------------
     考试页面结构固定：单选/多选/判断各自连续成块，只可能在一页中间换一次大块。
     因此整页模式不做"逐题猜题型"，而是：用户选当前大块题型 → 页内大块标题可中途切换 →
     每道题只在对应题型的题库子集中匹配。 */

  function toCoord(v) {
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }

  /* 行排序：先按 top 分行（容忍半个行高的抖动），行内按 left；无坐标时保持原顺序。 */
  function sortOcrLines(lines) {
    var arr = (lines || []).map(function (l, i) {
      var o = l || {};
      return { text: String(o.text == null ? "" : o.text),
        left: toCoord(o.left), top: toCoord(o.top),
        right: toCoord(o.right), bottom: toCoord(o.bottom), i: i };
    });
    if (arr.length < 2) { return arr; }
    var hasCoords = false;
    for (var k = 0; k < arr.length; k++) { if (arr[k].top !== null) { hasCoords = true; break; } }
    if (!hasCoords) { return arr; }
    arr.sort(function (a, b) {
      return (a.top === null ? 0 : a.top) - (b.top === null ? 0 : b.top) || a.i - b.i;
    });
    var out = [];
    var p = 0;
    while (p < arr.length) {
      var rowTop = arr[p].top === null ? 0 : arr[p].top;
      var row = [];
      while (p < arr.length) {
        var l = arr[p];
        var h = (l.top !== null && l.bottom !== null) ? (l.bottom - l.top) : 0;
        var tol = Math.max(8, Math.round(h / 2));
        if ((l.top === null ? 0 : l.top) - rowTop > tol) { break; }
        row.push(l); p++;
      }
      row.sort(function (a, b) {
        return (a.left === null ? 0 : a.left) - (b.left === null ? 0 : b.left);
      });
      out = out.concat(row);
    }
    return out;
  }

  /* 大块标题：单选题/单项选择题/多选题/多项选择题/判断题（允许"二、"这类大题编号与
     尾部计分说明）。真实 ML Kit 会把标题识出错字（多项选择题→多项选挥题），
     故在严格匹配外追加"等长+少量字符差异"的形近匹配；题干行较长不会命中。 */
  function pageSectionType(line) {
    var s = String(line == null ? "" : line).normalize("NFKC").trim();
    if (!s || s.length > 20) { return null; }
    s = s.replace(/^[（(【\[]?\s*(?:[一二三四五六七八九十]+|\d{1,2})\s*[)）】\]]?\s*[、.．:：]?\s*/, "");
    s = s.replace(/[（(【\[].*$/, "").trim();
    s = s.replace(/[\s.．、:：,，;；]+$/, "");
    if (s === "单项选择题" || s === "单选题" || s === "单选") { return "single"; }
    if (s === "多项选择题" || s === "多选题" || s === "多选") { return "multi"; }
    if (s === "判断题" || s === "判断") { return "judge"; }
    var EXACT = { "单项选择题": "single", "单选题": "single", "多项选择题": "multi",
      "多选题": "multi", "判断题": "judge" };
    for (var k in EXACT) {
      if (k.length !== s.length) { continue; }
      var diff = 0;
      for (var i = 0; i < k.length; i++) { if (k.charAt(i) !== s.charAt(i)) { diff++; } }
      if (diff <= 1) { return EXACT[k]; }
    }
    return null;
  }

  /* 题号识别：1. / 1．/ 1、/ 1) / （1）/ 第1题 / "31 题干"。
     只认行首题号；数字位允许少量 OCR 形近字母（3l -> 31），但必须至少含一个真数字，
     避免把选项行 "B. 停电" 误判成题号。 */
  var PAGE_NUM_CHARS = "0-9OoQlIiSsABZG";
  var PAGE_NUM_MAP = { O: "0", o: "0", Q: "0", l: "1", I: "1", i: "1", S: "5", s: "5",
    B: "8", A: "4", Z: "2", G: "6" };
  var PAGE_QNUM_PATTERNS = [
    new RegExp("^[（(]\\s*([" + PAGE_NUM_CHARS + "]{1,3})\\s*[)）]\\s*"),
    new RegExp("^第\\s*([" + PAGE_NUM_CHARS + "]{1,3})\\s*题\\s*[.．、:：]?\\s*"),
    new RegExp("^([" + PAGE_NUM_CHARS + "]{1,3})\\s*[.．、,，:：)）]\\s*(?!\\d)"),
    new RegExp("^([" + PAGE_NUM_CHARS + "]{1,3})\\s+(?=[\\u4e00-\\u9fa5])")
  ];

  function pageNumberValue(token) {
    if (!/\d/.test(token)) { return null; }
    var s = "";
    for (var i = 0; i < token.length; i++) {
      var c = token.charAt(i);
      s += PAGE_NUM_MAP[c] != null ? PAGE_NUM_MAP[c] : c;
    }
    if (!/^\d+$/.test(s)) { return null; }
    var n = parseInt(s, 10);
    return (n >= 1 && n <= 999) ? n : null;
  }

  function pageQuestionNumber(line) {
    /* 直接在原串上匹配（不 NFKC）：题号前缀的正则已同时覆盖全角/半角分隔符，
       这样 rest 保留 OCR 原文（全角标点不被改成半角）。 */
    var s = String(line == null ? "" : line).trim();
    if (!s) { return null; }
    for (var i = 0; i < PAGE_QNUM_PATTERNS.length; i++) {
      var m = s.match(PAGE_QNUM_PATTERNS[i]);
      if (!m) { continue; }
      var n = pageNumberValue(m[1]);
      if (n === null) { continue; }
      return { number: String(n), rest: s.slice(m[0].length).trim(), raw: String(m[1]) };
    }
    return null;
  }

  /* 选项行：A. / A、/ （A）/ A．/ A: 开头。 */
  function isPageOptionLine(text) {
    return /^[（(【\[]?\s*[A-Fa-f]\s*[)）】\]]?\s*[.、．:：]\s*\S/.test(String(text == null ? "" : text).trim());
  }

  /* 页码/导航/分隔线：不参与匹配文本。 */
  function isPageNoiseLine(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) { return true; }
    if (/^\d{1,3}\s*\/\s*\d{1,3}$/.test(s)) { return true; }
    if (/^第\s*\d{1,3}\s*页/.test(s) || /共\s*\d{1,3}\s*页/.test(s)) { return true; }
    if (/^[-—–_=·\s\d]{1,12}$/.test(s)) { return true; }
    if (/^[^\p{L}\p{N}]+$/u.test(s)) { return true; }
    return false;
  }

  /* 按题号分题：新题号 = 上一题块结束、下一题块开始。
     题干换行、A/B/C/D 选项都不拆题；大块标题只切题型、不属于任何题块。 */
  function splitPageOcrLines(lines, defaultType) {
    var def = defaultType || "single";
    var sorted = sortOcrLines(lines);
    var blocks = [];
    var cur = null;
    var curType = def;
    var headers = [];
    var curOpts = {};      /* 当前块已出现的选项字母（用于选项重启检测） */
    var curLast = "";      /* 最近一次出现的选项字母：A~D 完整走完后应为 D */
    for (var i = 0; i < sorted.length; i++) {
      var ln = sorted[i];
      var text = String(ln.text == null ? "" : ln.text).trim();
      if (!text) { continue; }
      var sec = pageSectionType(text);
      if (sec) {
        curType = sec;
        cur = null;
        headers.push({ text: text, type: sec, top: ln.top, bottom: ln.bottom });
        continue;
      }
      var qn = pageQuestionNumber(text);
      if (qn) {
        cur = { pageIndex: blocks.length, screenNumber: qn.number, rawScreenNumber: qn.raw,
          numberSource: "ocr", type: curType,
          lines: [], top: ln.top, bottom: ln.bottom };
        blocks.push(cur);
        curOpts = {};
        if (qn.rest) {
          cur.lines.push({ text: qn.rest, top: ln.top, left: ln.left, right: ln.right, bottom: ln.bottom });
        }
        continue;
      }
      /* 选项重启二次分题：OCR 漏读某题的题号行时，两道题会并进一个块，表现为
         A~D 选项后又出现一个 A 选项行。此时在第二个 A 处把块拆开，新块题号未知，
         由 normalizePageQuestionSequence 依据前后邻块推断（numberSource=inferred）。
         要求当前块已见到 >=3 个不同选项字母，避免误拆。 */
      if (cur && curOpts && Object.keys(curOpts).length >= 3 && cur.lines.length >= 6 &&
          /^[（(【\[]?\s*Aa?\s*[)）】\]]?\s*[.、．:：]/.test(text)) {
        /* 上一块"最后一个选项行之后"的散行（漏号题的题干）归属新块 */
        var carry = [];
        while (cur.lines.length &&
               !isPageOptionLine(cur.lines[cur.lines.length - 1].text)) {
          carry.unshift(cur.lines.pop());
        }
        cur = { pageIndex: blocks.length, screenNumber: null, rawScreenNumber: null,
          numberSource: "unknown", type: curType,
          lines: carry, top: carry.length ? carry[0].top : ln.top,
          left: carry.length ? carry[0].left : ln.left,
          bottom: ln.bottom };
        blocks.push(cur);
        curOpts = {};
      }
      if (cur) {
        cur.lines.push({ text: text, top: ln.top, left: ln.left, right: ln.right, bottom: ln.bottom });
        cur.bottom = ln.bottom;
        var om = text.match(/^[（(【\[]?\s*([A-Fa-f])\s*[)）】\]]?\s*[.、．:：]/);
        if (om) { var ol = om[1].toUpperCase(); curOpts[ol] = true; curLast = ol; }
      }
    }
    blocks.forEach(function (b) {
      var stem = [], opts = [];
      b.lines.forEach(function (l) {
        var t = l.text.trim();
        if (!t || isPageNoiseLine(t)) { return; }
        if (isPageOptionLine(t)) { opts.push(t); return; }
        stem.push(t);
      });
      b.stemText = stem.join("");
      b.optionsText = opts.join(" ");
      b.rawText = b.lines.map(function (l) { return l.text; }).join("\n");
      b.label = b.screenNumber ? b.screenNumber : ("本页第" + (b.pageIndex + 1) + "题");
      if (b.bottom === null || b.bottom === undefined) { b.bottom = b.top; }
    });
    return blocks;
  }

  /* ---------------- 整页题号序列校正（独立纯函数，不参与匹配打分） ----------------
     真机发现：ML Kit 可能把 24 识成 14、33 识成 3l，且块顺序不稳定，结果页会出现
     23/14/22/21/20 这类乱序。这里只做三件事：
       1) 保留 OCR 原始题号（rawScreenNumber 永不改写，方便排查）
       2) 页内主连续段分析，仅在强证据下校正异常题号（numberSource = repaired）
       3) 按校正后的题号升序返回
     绝不改动 bankId / matches / confidence / answer；漏题造成的缺口（20 21 23 24）原样保留。 */

  var SEQ_CLUSTER_MAX_GAP = 2;  /* 簇内允许的最大缺号数：20 与 23 仍算同一簇（中间漏一题） */
  var SEQ_MAX_REPAIRS = 2;      /* 一页最多校正 2 个题号；再多有更多未知，宁可不动 */

  function seqNum(block) {
    var n = parseInt(block && block.screenNumber, 10);
    return isNaN(n) ? null : n;
  }

  function seqRaw(block) {
    if (block && block.rawScreenNumber != null) { return String(block.rawScreenNumber); }
    if (block && block.screenNumber != null) { return String(block.screenNumber); }
    return "";
  }

  /* OCR 原始题号与目标数字的差异：位数相同才可比（返回不同字符数），位数不同返回 -1 */
  function seqDigitDiff(raw, target) {
    var a = String(raw == null ? "" : raw).replace(/[^0-9A-Za-z]/g, "");
    var b = String(target);
    if (a.length !== b.length) { return -1; }
    var diff = 0;
    for (var i = 0; i < b.length; i++) {
      if (a.charAt(i) !== b.charAt(i)) { diff++; }
    }
    return diff;
  }

  function seqMaxDiff(len) { return len <= 3 ? 1 : 2; }

  /* 形近判定：位数相同且只有少量字符不同；或 OCR 掉了一位，剩余数字正好是目标的前/后缀 */
  function seqLooksLike(raw, target) {
    var a = String(raw == null ? "" : raw).replace(/[^0-9A-Za-z]/g, "");
    var b = String(target);
    var d = seqDigitDiff(a, b);
    if (d >= 0 && d <= seqMaxDiff(a.length)) { return true; }
    if (a.length > 0 && a.length < b.length) {
      return b.slice(0, a.length) === a || b.slice(b.length - a.length) === a;
    }
    return false;
  }

  /* 近连续簇：排序后相邻两值相差 ≤ maxGap+1 视为同簇（允许漏题造成的小缺口） */
  function seqClusters(values, maxGap) {
    var clusters = [];
    var cur = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (cur && v - cur.end <= maxGap + 1) { cur.end = v; cur.values.push(v); }
      else { cur = { start: v, end: v, values: [v] }; clusters.push(cur); }
    }
    return clusters;
  }

  function normalizePageQuestionSequence(blocks) {
    var list = (blocks || []).map(function (b, i) {
      if (b.originalPageIndex === undefined) { b.originalPageIndex = i; }
      return b;
    });
    /* 空间顺序：优先 top（像素位置），没有坐标时退回输入顺序 */
    var order = list.map(function (b, i) { return i; }).sort(function (x, y) {
      var a = list[x], b = list[y];
      var at = (a && typeof a.top === "number") ? a.top : a.originalPageIndex;
      var bt = (b && typeof b.top === "number") ? b.top : b.originalPageIndex;
      return at - bt;
    });
    var pos = new Array(list.length);
    order.forEach(function (idx, k) { pos[idx] = k; });
    var posOf = function (b) { return pos[list.indexOf(b)]; };
    var blockWithNumber = function (n) {
      for (var i = 0; i < list.length; i++) { if (seqNum(list[i]) === n) { return list[i]; } }
      return null;
    };
    var repair = function (b, target) {
      b.screenNumber = String(target);
      b.numberSource = "repaired";
    };

    var numbered = list.filter(function (b) { return seqNum(b) !== null; });
    list.forEach(function (b) { if (seqNum(b) === null) { b.numberSource = "unknown"; } });
    var repairs = 0;
    var seen = {};
    var taken = {};
    numbered.forEach(function (b) { seen[seqNum(b)] = true; });

    if (numbered.length >= 3) {
      var values = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
      var clusters = seqClusters(values, SEQ_CLUSTER_MAX_GAP);
      clusters.sort(function (a, b) {
        return b.values.length - a.values.length ||
          (b.end - b.start) - (a.end - a.start) || a.start - b.start;
      });
      var main = clusters[0];
      var inMain = {};
      main.values.forEach(function (v) { inMain[v] = true; });

      var missing = [];
      for (var v = main.start; v <= main.end; v++) { if (!seen[v]) { missing.push(v); } }
      var byNum = {};
      numbered.forEach(function (b) { (byNum[seqNum(b)] = byNum[seqNum(b)] || []).push(b); });

      /* 1) 同页重复题号：恰重复一对 + 主簇恰好缺一个号 + 其中一块空间上正落在缺口里
        （如 31 32 3l 34 35：3l 被形近恢复成 31，与真 31 重复，缺口 33 正是它的位置） */
      if (missing.length === 1) {
        Object.keys(byNum).forEach(function (k) {
          if (repairs >= SEQ_MAX_REPAIRS) { return; }
          var grp = byNum[k];
          if (grp.length !== 2 || !inMain[Number(k)]) { return; }
          var m = missing[0];
          var prev = blockWithNumber(m - 1), next = blockWithNumber(m + 1);
          if (!prev || !next) { return; }
          var odd = grp.filter(function (b) {
            return posOf(b) > posOf(prev) && posOf(b) < posOf(next);
          });
          if (odd.length === 1 && !seen[m]) { repair(odd[0], m); taken[m] = true; repairs++; }
        });
      }

      /* 2) 孤立异常值：必须空间位置紧贴主簇端点/缺口，且原题号与目标只差少量字符。
        绝不因为“不连续”就批量改号。 */
      var outliers = numbered.filter(function (b) {
        return !inMain[seqNum(b)] && b.numberSource !== "repaired";
      }).sort(function (a, b) { return posOf(a) - posOf(b); });
      for (var oi = 0; oi < outliers.length && repairs < SEQ_MAX_REPAIRS; oi++) {
        var o = outliers[oi];
        var target = null;
        var tail = blockWithNumber(main.end), head = blockWithNumber(main.start);
        if (!seen[main.end + 1] && posOf(o) > posOf(tail)) {
          target = main.end + 1;                       /* 尾部顺延：…23 + [14] → 24 */
        } else if (main.start - 1 >= 1 && !seen[main.start - 1] && posOf(o) < posOf(head)) {
          target = main.start - 1;                     /* 头部顺延 */
        } else {
          for (var g = main.start; g <= main.end; g++) {
            if (!seen[g] && seen[g - 1] && seen[g + 1]) {
              var pg = blockWithNumber(g - 1), ng = blockWithNumber(g + 1);
              if (posOf(o) > posOf(pg) && posOf(o) < posOf(ng)) { target = g; break; }
            }
          }
        }
        if (target !== null && !seen[target] && !taken[target] && seqLooksLike(seqRaw(o), target)) {
          repair(o, target);
          taken[target] = true;
          repairs++;
        }
      }
    }

    /* 无题号块推断：双邻证据（恰夹在 n 与 n+2 之间且 n+1 未占用）才编号，
       需要至少 2 个带号块；这不是对 1~2 个题号页做激进序列推断。 */
    if (numbered.length >= 2) {
      list.filter(function (b) { return seqNum(b) === null; }).forEach(function (ub) {
        if (repairs >= SEQ_MAX_REPAIRS) { return; }
        var up = posOf(ub), prevN = null, nextN = null;
        for (var k = 0; k < order.length && nextN === null; k++) {
          var nb = list[order[k]];
          var nn = seqNum(nb);
          if (nn === null || nb === ub) { continue; }
          if (posOf(nb) < up) { prevN = nn; }
          else { nextN = nn; break; }
        }
        if (prevN !== null && nextN !== null && nextN - prevN === 2 &&
            !seen[prevN + 1] && !taken[prevN + 1]) {
          ub.screenNumber = String(prevN + 1);
          ub.numberSource = "inferred";
          seen[prevN + 1] = true;
          taken[prevN + 1] = true;
          repairs++;
        }
      });
    }

    list.forEach(function (b) {
      if (!b.numberSource) { b.numberSource = "ocr"; }
      if (seqNum(b) !== null) { b.label = String(seqNum(b)); }
    });
    /* 最终给用户看的顺序：校正后的题号升序；无题号的块按原位置排在最后 */
    return list.slice().sort(function (a, b) {
      var an = seqNum(a), bn = seqNum(b);
      if (an === null && bn === null) { return a.originalPageIndex - b.originalPageIndex; }
      if (an === null) { return 1; }
      if (bn === null) { return -1; }
      return an - bn || a.originalPageIndex - b.originalPageIndex;
    });
  }

  /* 整页匹配索引：在单题 OCR 索引基础上补上答案字段（不改动单题路径）。 */
  function buildBatchOcrIndex(questions) {
    var byId = {};
    (questions || []).forEach(function (q) { byId[q.id] = q; });
    return buildOcrIndex(questions).map(function (it) {
      it.answer = byId[it.id] ? (byId[it.id].answer || []) : [];
      return it;
    });
  }

  /* 答案显示：单选 "B"，多选 "ACD"，判断 "√" / "×"。 */
  function pageAnswerText(item) {
    if (!item || !item.answer || !item.answer.length) { return "?"; }
    if (item.type === "judge") { return item.answer[0] === 0 ? "√" : "×"; }
    return item.answer.slice().sort(function (x, y) { return x - y; })
      .map(function (i) { return LETTERS[i]; }).join("");
  }

  /* 人工框选（整页拍照）：归一化裁剪矩形的默认值与钳制（纯函数，可 Node 单测）。
     矩形用 { x, y, w, h }（0~1，相对照片显示方向），默认四周留 margin 边距，
     最小尺寸 minSize 防止误操作成几像素宽。只描述选区，不参与 OCR/匹配。 */
  function pageCropClamp(rect, minSize) {
    var ms = minSize == null ? 0.05 : minSize;
    var w = Math.min(Math.max(rect.w, ms), 1);
    var h = Math.min(Math.max(rect.h, ms), 1);
    var x = Math.min(Math.max(rect.x, 0), 1 - w);
    var y = Math.min(Math.max(rect.y, 0), 1 - h);
    return { x: x, y: y, w: w, h: h };
  }

  function pageCropDefault(margin) {
    var m = margin == null ? 0.04 : margin;
    return pageCropClamp({ x: m, y: m, w: 1 - 2 * m, h: 1 - 2 * m }, 0.05);
  }

  /* 自动题目区域定位（仅用于拍摄后的默认框建议，不做匹配、不出答案）。
     输入 OCR lines + 图片尺寸；输出：
       crop: {x,y,w,h} 归一化（找不到可靠结构时为 null，调用方保持默认框）
       confidence: "strong" | "none"
       anchors: { questionNumbers, optionLines }
       reason: no_lines / no_quiz_structure / ok / ok_single_question
     规则（保守，绝不乱缩）：
       - 锚点 = 行首题号（pageQuestionNumber）+ 选项行（A./B./…）；
       - 题号按行序聚成“递增连续段”（n 递增且步长 ≤30，容忍漏号），
         取最大段为主块；段内行 + 段尾之后连续的选项/普通文本行都算主体
         （容忍漏题号导致的合并）；遇到新的题号行即停；
       - 水平范围取锚点行最小 left（浏览器左侧导航窄行不会拉宽/拉偏），
         最大 right 取主体行（滚动条窄行影响有限），四周加 1.5 行高 padding。 */
  function suggestQuizCrop(lines, imageWidth, imageHeight) {
    var out = { crop: null, confidence: "none",
      anchors: { questionNumbers: 0, optionLines: 0 }, reason: "no_lines" };
    var W = imageWidth || 0, H = imageHeight || 0;
    if (W <= 0 || H <= 0) { return out; }
    var L = [];
    (lines || []).forEach(function (l) {
      var t = String(l.text == null ? "" : l.text).trim();
      if (!t) { return; }
      L.push({ text: t, top: l.top || 0,
        bottom: l.bottom == null ? (l.top || 0) + 40 : l.bottom,
        left: l.left || 0, right: l.right == null ? (l.left || 0) + 200 : l.right });
    });
    if (!L.length) { return out; }
    L.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
    var hList = L.map(function (l) { return Math.max(1, l.bottom - l.top); })
      .sort(function (a, b) { return a - b; });
    var lineH = hList[Math.floor(hList.length / 2)] || 40;

    var qAnchors = [], optCount = 0;
    L.forEach(function (l, i) {
      var qn = pageQuestionNumber(l.text);
      if (qn) { qAnchors.push({ i: i, n: parseInt(qn.number, 10), line: l }); }
      if (isPageOptionLine(l.text)) { optCount++; }
    });
    out.anchors = { questionNumbers: qAnchors.length, optionLines: optCount };

    var runs = [];
    qAnchors.forEach(function (q) {
      var n = q.n;
      var cur = runs.length ? runs[runs.length - 1] : null;
      if (cur && n > cur.lastN && n - cur.lastN <= 30) { cur.items.push(q); cur.lastN = n; }
      else { runs.push({ lastN: n, items: [q] }); }
    });
    runs.sort(function (a, b) {
      return b.items.length - a.items.length ||
        (b.lastN - b.items[0].n) - (a.lastN - a.items[0].n);
    });
    var best = runs.length ? runs[0] : null;
    var enough = (best && best.items.length >= 2) || (qAnchors.length === 1 && optCount >= 4);
    if (!best || !enough) { out.reason = "no_quiz_structure"; return out; }

    var firstIdx = best.items[0].i;
    var lastAnchor = best.items[best.items.length - 1];
    var bottomPx = lastAnchor.line.bottom;
    var prevBottom = bottomPx;
    var endIdx = lastAnchor.i;
    var gapLimit = lineH * 3.5;
    for (var i = lastAnchor.i + 1; i < L.length; i++) {
      var l = L[i];
      if (l.top - prevBottom > gapLimit) { break; }
      if (pageQuestionNumber(l.text)) { break; }   /* 新题号 = 主体结束 */
      endIdx = i;
      bottomPx = Math.max(bottomPx, l.bottom);
      prevBottom = l.bottom;
    }
    var minLeft = W, maxRight = 0;
    best.items.forEach(function (q) {
      minLeft = Math.min(minLeft, q.line.left);      /* 左界取锚点行：左侧导航窄行不拉偏 */
      maxRight = Math.max(maxRight, q.line.right);
    });
    for (var k = firstIdx; k <= endIdx; k++) {
      maxRight = Math.max(maxRight, L[k].right);     /* 右界可含题干长行 */
    }
    var padY = lineH * 1.5, padX = lineH * 0.5;
    var x0 = Math.max(0, minLeft - padX), x1 = Math.min(W, maxRight + padX);
    var y0 = Math.max(0, best.items[0].line.top - padY);
    var y1 = Math.min(H, bottomPx + padY);
    var crop = pageCropClamp({ x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }, 0.05);
    if (crop.w <= 0.05 || crop.h <= 0.05) { out.reason = "degenerate_crop"; return out; }
    out.crop = crop;
    out.confidence = "strong";
    out.reason = best.items.length >= 2 ? "ok" : "ok_single_question";
    return out;
  }

  /* 整页结果展示门控（纯展示层）：置信度只通过颜色表达，不再隐藏答案。
     high=绿色 / medium=橙色 / low=红色（只要有候选答案就显示原答案）；
     none 或真无候选 = 显示 ?。返回 { text, cls }，cls 对应结果行答案的颜色类。
     本函数只做展示决策，不参与置信度计算与匹配。 */
  function pageAnswerDisplay(confidence, answer) {
    var has = answer != null && answer !== "" && answer !== "?";
    if (confidence === "none" || !has) { return { text: "?", cls: "none" }; }
    var cls = confidence === "medium" ? "mid" : (confidence === "low" ? "low" : "high");
    return { text: String(answer), cls: cls };
  }

  /* 领先度：Top1 相对 Top2 的倍数（只有一个候选时视为 2）。 */
  function pageMatchLead(matches) {
    if (!matches || !matches.length) { return { top1: 0, lead: 0 }; }
    var t1 = matches[0];
    var t2 = matches.length > 1 ? matches[1] : null;
    return { top1: t1.score, lead: (t2 && t2.score > 0) ? t1.score / t2.score : 2 };
  }

  /* 题型是强约束：先把候选缩小到该题型，再在子集内评分（IDF 也按子集统计）。
     题干优先；只有题干匹配不够确定（分数低/领先不足/题干太短）时才做第二遍让选项
     以低权重辅助，且仅当第二遍得分更高才采用——选项辅助不会推翻题干的长连续片段。 */
  function matchPageQuestionBlock(ocrIndex, block, options) {
    var opts = options || {};
    var type = (block && block.type) || opts.type || "single";
    var limit = opts.limit || 3;
    var minRun = opts.minRun || 5;
    var pool = [];
    for (var i = 0; i < ocrIndex.length; i++) {
      if (ocrIndex[i].type === type) { pool.push(ocrIndex[i]); }
    }
    var stemText = (block && block.stemText) || "";
    var matches = matchOcrCandidates(pool, stemText, { minRun: minRun }).slice(0, limit);
    var lead = pageMatchLead(matches);
    var weak = !matches.length || normalizeOcrText(stemText).length < 6 ||
      lead.top1 < 900 || lead.lead < 1.6;
    if (weak && opts.assistOptions !== false && (block && block.optionsText)) {
      var assisted = matchOcrCandidates(pool, stemText + " " + block.optionsText,
        { minRun: minRun }).slice(0, limit);
      if (assisted.length && (!matches.length || assisted[0].score > matches[0].score)) {
        matches = assisted;
        matches.assistedByOptions = true;
      }
    }
    return matches;
  }

  /* 置信度：高分且明显领先才算 high；领先不足是 medium；文本太少或候选接近是 low。 */
  function pageBlockConfidence(matches, block) {
    if (!matches || !matches.length) { return "none"; }
    var textLen = normalizeOcrText((block && block.stemText) || "").length;
    var lead = pageMatchLead(matches);
    if (textLen < 8) { return "low"; }
    if (lead.top1 >= 900 && lead.lead >= 1.6) { return "high"; }
    if (lead.top1 >= 250 && lead.lead >= 1.25) { return "medium"; }
    return "low";
  }

  /* 整页入口：lines -> 分题 -> 每题题型约束匹配 -> 答案。 */
  function searchPageQuestionsByOcr(ocrIndex, lines, defaultType, options) {
    var opts = options || {};
    var byId = {};
    for (var i = 0; i < ocrIndex.length; i++) { byId[ocrIndex[i].id] = ocrIndex[i]; }
    var blocks = splitPageOcrLines(lines, defaultType);
    var limit = opts.limit || 3;
    var answered = 0;
    blocks.forEach(function (b) {
      b.matches = matchPageQuestionBlock(ocrIndex, b, { limit: limit });
      b.confidence = pageBlockConfidence(b.matches, b);
      b.bankId = b.matches.length ? b.matches[0].id : null;
      b.answerItem = b.bankId === null ? null : (byId[b.bankId] || null);
      b.answer = b.answerItem ? pageAnswerText(b.answerItem) : "?";
      if (b.answer !== "?") { answered++; }
      /* 编号来源不干净（拆出/推断/修复）的块证据较弱，置信度封顶 medium：
         保证"高置信度"永远来自题号原文可靠的块 */
      if (b.confidence === "high" && b.numberSource !== "ocr") { b.confidence = "medium"; }
      /* 选项辅助匹配成功的块证据同样较弱（题干不足/严重 garble），不宣称高置信 */
      if (b.confidence === "high" && b.matches && b.matches.assistedByOptions) { b.confidence = "medium"; }
    });
    /* 题号校正 + 升序：只调整 screenNumber/label/numberSource 与块顺序，
       不改写 bankId/matches/confidence/answer（匹配结果与题号无关） */
    var ordered = normalizePageQuestionSequence(blocks);
    return { blocks: ordered, answered: answered };
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
    filterSearchResults: filterSearchResults, countSearchResultsByType: countSearchResultsByType,
    normalizeOcrText: normalizeOcrText, buildOcrIndex: buildOcrIndex,
    searchQuestionsByOcr: searchQuestionsByOcr, ocrConfidence: ocrConfidence,
    buildBatchOcrIndex: buildBatchOcrIndex, splitPageOcrLines: splitPageOcrLines,
    normalizePageQuestionSequence: normalizePageQuestionSequence,
    pageSectionType: pageSectionType, pageQuestionNumber: pageQuestionNumber,
    matchPageQuestionBlock: matchPageQuestionBlock, pageBlockConfidence: pageBlockConfidence,
    pageAnswerText: pageAnswerText, pageAnswerDisplay: pageAnswerDisplay,
    pageCropClamp: pageCropClamp, pageCropDefault: pageCropDefault, suggestQuizCrop: suggestQuizCrop, searchPageQuestionsByOcr: searchPageQuestionsByOcr,
    generateExam: generateExam, scoreExam: scoreExam
  };
});
