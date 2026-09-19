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

  return {
    LETTERS: LETTERS, TYPE_ORDER: TYPE_ORDER, TYPE_NAMES: TYPE_NAMES,
    DEFAULT_EXAM_CONFIG: DEFAULT_EXAM_CONFIG,
    COUNT_KEYS: COUNT_KEYS, SCORE_KEYS: SCORE_KEYS,
    normalizeConfig: normalizeConfig, indexByType: indexByType,
    isCorrect: isCorrect, answerText: answerText, shuffled: shuffled,
    shuffleQuestionOptions: shuffleQuestionOptions, parseJumpTarget: parseJumpTarget,
    generateExam: generateExam, scoreExam: scoreExam
  };
});
