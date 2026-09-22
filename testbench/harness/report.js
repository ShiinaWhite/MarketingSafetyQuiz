/* report.js —— 基准测试的统计与失败分类（harness 代码，纯函数，可单测）。
   不做任何 OCR：只吃 run_benchmark.js 产出的逐页记录，算指标、分类失败、渲染报告。 */
"use strict";

/* ---------- 数值统计 ---------- */
function stats(values) {
  const v = (values || []).filter(x => typeof x === "number" && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) { return { count: 0, mean: 0, min: 0, p50: 0, p90: 0, p95: 0, max: 0, median: 0 }; }
  const at = p => {
    if (v.length === 1) { return v[0]; }
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    count: v.length,
    mean: sum / v.length,
    min: v[0], max: v[v.length - 1],
    median: at(0.5), p50: at(0.5), p90: at(0.9), p95: at(0.95)
  };
}

/* ---------- OCR 文本与期望题干的字符覆盖度 ---------- */
function normalizeForCoverage(s) {
  return String(s == null ? "" : s).replace(/[^\p{L}\p{N}]/gu, "");
}
function charCoverage(expected, actual) {
  const e = normalizeForCoverage(expected);
  const a = normalizeForCoverage(actual);
  if (!e.length) { return 1; }
  const pool = new Map();
  for (const ch of a) { pool.set(ch, (pool.get(ch) || 0) + 1); }
  let hit = 0;
  for (const ch of e) {
    const n = pool.get(ch) || 0;
    if (n > 0) { hit++; pool.set(ch, n - 1); }
  }
  return hit / e.length;
}

/* ---------- 失败分类 ----------
   优先级固定，便于复现：
   OCR_TEXT_ERROR > SPLIT_ERROR > TYPE_ERROR > QUESTION_NUMBER_ERROR >
   MATCH_ERROR > CONFIDENCE_ERROR > ANSWER_UI_ERROR > UNCLASSIFIED
   （注：CONFIDENCE_ERROR 指"匹配对了但因为低置信度没给答案"，属于漏答不属错答） */
const FAILURE_CATEGORIES = ["OCR_TEXT_ERROR", "SPLIT_ERROR", "TYPE_ERROR", "QUESTION_NUMBER_ERROR",
  "MATCH_ERROR", "CONFIDENCE_ERROR", "ANSWER_UI_ERROR", "UNCLASSIFIED"];
const COVERAGE_OK = 0.55;

function classifyFailure(ctx) {
  const { pageOcrOk, splitCountOk, block, expected, page } = ctx;
  if (!pageOcrOk) { return { category: "OCR_TEXT_ERROR", detail: "本页 OCR 无文本或失败" }; }
  if (!block) {
    return { category: splitCountOk ? "UNCLASSIFIED" : "SPLIT_ERROR",
      detail: splitCountOk ? "该位置没有题块" : "题块数量与期望不符（" + page.blocks + " vs " + page.expected + "）" };
  }
  if (block.type !== expected.type) {
    return { category: "TYPE_ERROR", detail: "题型 " + block.type + " ≠ " + expected.type };
  }
  if (!splitCountOk) {
    return { category: "SPLIT_ERROR", detail: "题块数量 " + page.blocks + " ≠ 期望 " + page.expected };
  }
  const cov = charCoverage(expected.stem, block.stemText);
  if (String(block.screenNumber) !== String(expected.screenNumber)) {
    return { category: "QUESTION_NUMBER_ERROR",
      detail: "识别题号 " + block.screenNumber + " ≠ " + expected.screenNumber + "（题干覆盖度 " + cov.toFixed(2) + "）" };
  }
  if (cov < COVERAGE_OK) {
    return { category: "OCR_TEXT_ERROR", detail: "题干字符覆盖度 " + cov.toFixed(2) + " < " + COVERAGE_OK };
  }
  const top1 = (block.matches && block.matches[0]) ? block.matches[0].id : null;
  if (String(top1) !== String(expected.bankId)) {
    return { category: "MATCH_ERROR", detail: "Top1=" + top1 + " ≠ " + expected.bankId + "（覆盖度 " + cov.toFixed(2) + "）" };
  }
  if (block.confidence === "low" || block.confidence === "none") {
    return { category: "CONFIDENCE_ERROR", detail: "匹配正确但置信度 " + block.confidence + "，界面显示 ?" };
  }
  return { category: "ANSWER_UI_ERROR", detail: "Top1 正确但显示答案 " + block.answer + " ≠ " + expected.answer };
}

/* ---------- 汇总 ---------- */
function pct(a, b) { return b ? (a / b * 100) : 0; }

/* records: run_benchmark.js 产出的逐页记录 */
function aggregate(records) {
  const pages = records.length;
  const out = {
    pages: pages,
    questions: 0, pagesOcrOk: 0, pagesSplitOk: 0,
    screenOk: 0, typeOk: 0, top1Ok: 0, top3Ok: 0, answerOk: 0, answerRawOk: 0,
    shown: 0, shownOk: 0,
    confShown: { high: 0, medium: 0, low: 0 }, confShownOk: { high: 0, medium: 0, low: 0 },
    confidence: { high: 0, medium: 0, low: 0, none: 0 },
    confidenceWrong: { high: 0, medium: 0, low: 0, none: 0 },
    confidenceFalseNegative: 0,
    failureCounts: {}, failures: []
  };
  FAILURE_CATEGORIES.forEach(c => { out.failureCounts[c] = 0; });

  records.forEach(r => {
    const ocrOk = !r.ocr.err && String(r.ocr.text || "").trim().length > 0;
    if (ocrOk) { out.pagesOcrOk++; }
    const splitOk = r.blocks.length === r.gt.questions.length;
    if (splitOk) { out.pagesSplitOk++; }
    r.gt.questions.forEach((exp, i) => {
      out.questions++;
      const b = r.blocks[i];
      /* 题号统一按字符串比较：GT 里是数字、分题结果是字符串 */
      if (b && String(b.screenNumber) === String(exp.screenNumber)) { out.screenOk++; }
      if (b && b.type === exp.type) { out.typeOk++; }
      const top1 = (b && b.matches && b.matches[0]) ? b.matches[0].id : null;
      const top3 = (b && b.matches) ? b.matches.map(m => String(m.id)) : [];
      if (String(top1) === String(exp.bankId)) { out.top1Ok++; }
      if (top3.indexOf(String(exp.bankId)) >= 0) { out.top3Ok++; }
      const displayed = b ? b.answerDisplayed : "?";
      const raw = b ? b.answerRaw : "?";
      if (displayed !== "?") {
        out.shown++;
        if (displayed === exp.answer) { out.shownOk++; }
      }
      if (displayed === exp.answer) { out.answerOk++; }
      if (raw === exp.answer) { out.answerRawOk++; }
      const conf = b ? b.confidence : "none";
      out.confidence[conf] = (out.confidence[conf] || 0) + 1;
      if (conf === "none") { out.confShown.none = (out.confShown.none || 0) + 1; }
      if (displayed !== "?") {
        out.confShown[conf]++;
        if (displayed === exp.answer) { out.confShownOk[conf]++; }
      }
      const wrong = displayed !== exp.answer;
      if (wrong) { out.confidenceWrong[conf] = (out.confidenceWrong[conf] || 0) + 1; }
      /* 假阴性：其实匹配对了，却因低置信度把答案藏成 ?（阈值过于保守） */
      if ((conf === "low" || conf === "none") && String(top1) === String(exp.bankId)) {
        out.confidenceFalseNegative++;
      }
      if (wrong) {
        const cls = classifyFailure({
          pageOcrOk: ocrOk, splitCountOk: splitOk, block: b, expected: exp,
          page: { blocks: r.blocks.length, expected: r.gt.questions.length }
        });
        out.failureCounts[cls.category]++;
        out.failures.push({
          pageId: r.pageId, index: i, screenNumber: exp.screenNumber, category: cls.category,
          detail: cls.detail, expectedBankId: exp.bankId, expectedAnswer: exp.answer,
          gotScreenNumber: b ? b.screenNumber : null, gotBankId: top1, gotAnswer: displayed,
          confidence: conf, stemCoverage: b ? Number(charCoverage(exp.stem, b.stemText).toFixed(3)) : 0,
          top3: (b && b.matches ? b.matches.map(m => ({ id: m.id, score: m.score })) : [])
        });
      }
    });
  });

  out.PAGE_OCR_SUCCESS_RATE = pct(out.pagesOcrOk, pages);
  out.PAGE_SPLIT_COUNT_ACCURACY = pct(out.pagesSplitOk, pages);
  out.SCREEN_NUMBER_ACCURACY = pct(out.screenOk, out.questions);
  out.TYPE_ACCURACY = pct(out.typeOk, out.questions);
  out.TOP1_MATCH_ACCURACY = pct(out.top1Ok, out.questions);
  out.TOP3_MATCH_ACCURACY = pct(out.top3Ok, out.questions);
  out.ANSWER_ACCURACY = pct(out.answerOk, out.questions);
  out.ANSWER_ACCURACY_RAW = pct(out.answerRawOk, out.questions);
  out.ANSWER_COVERAGE = pct(out.shown, out.questions);
  out.ANSWERED_PRECISION = pct(out.shownOk, out.shown);
  const lvlPct = (k) => {
    const n = out.confShown[k] || 0, ok = out.confShownOk[k] || 0;
    return n ? pct(ok, n) : null;
  };
  out.HIGH_COUNT = out.confShown.high || 0;
  out.HIGH_CORRECT = out.confShownOk.high || 0;
  out.HIGH_PRECISION = lvlPct("high");
  out.MEDIUM_COUNT = out.confShown.medium || 0;
  out.MEDIUM_CORRECT = out.confShownOk.medium || 0;
  out.MEDIUM_PRECISION = lvlPct("medium");
  out.LOW_COUNT = out.confShown.low || 0;
  out.LOW_CORRECT = out.confShownOk.low || 0;
  out.LOW_PRECISION = lvlPct("low");
  out.NONE_COUNT = out.confidence.none || 0;
  out.OVERALL_DISPLAY_COUNT = out.shown;
  out.OVERALL_DISPLAY_CORRECT = out.shownOk;
  out.OVERALL_DISPLAY_PRECISION = out.ANSWERED_PRECISION;
  out.OVERALL_DISPLAY_COVERAGE = out.ANSWER_COVERAGE;
  out.HIGH_CONFIDENCE_WRONG = out.confidenceWrong.high || 0;
  out.MEDIUM_CONFIDENCE_WRONG = out.confidenceWrong.medium || 0;
  out.LOW_CONFIDENCE_WRONG = out.confidenceWrong.low || 0;
  out.CONFIDENCE_FALSE_NEGATIVE = out.confidenceFalseNegative;
  out.throughput = {
    QUESTIONS_PER_SECOND: out.questions && records.length
      ? out.questions / (records.reduce((s, r) => s + (r.timings.totalMs || 0), 0) / 1000) : 0,
    PAGES_PER_MINUTE: records.length
      ? records.length / (records.reduce((s, r) => s + (r.timings.totalMs || 0), 0) / 60000) : 0
  };
  out.timing = {
    OCR_TIME_MS: stats(records.map(r => r.timings.ocrMs)),
    SPLIT_TIME_MS: stats(records.map(r => r.timings.splitMs)),
    MATCH_TIME_MS: stats(records.map(r => r.timings.matchMs)),
    TOTAL_PIPELINE_MS: stats(records.map(r => r.timings.totalMs))
  };
  out.topFailures = out.failures.slice(0, 10);
  return out;
}

/* ---------- Markdown 报告 ---------- */
function renderMarkdown(meta, agg) {
  const f = (x) => (Math.round(x * 100) / 100).toFixed(2);
  const p = (x) => x.toFixed(2) + "%";
  const L = [];
  L.push("# 整页拍照搜题 · 自动基准测试报告");
  L.push("");
  L.push("## 测试环境");
  L.push("");
  L.push("| 项 | 值 |");
  L.push("| --- | --- |");
  L.push("| baseline commit | `" + meta.baselineCommit + "` |");
  L.push("| 运行环境 | " + meta.runtime + " |");
  L.push("| ML Kit | " + meta.mlkit + " |");
  L.push("| 数据源 | " + meta.source + "（" + meta.bankSize + " 题） |");
  L.push("| Profile | " + meta.profile + " |");
  L.push("| 总页数 | " + agg.pages + " |");
  L.push("| 总题数 | " + agg.questions + " |");
  L.push("| 题库覆盖率 | " + meta.coverage.used + "/" + meta.coverage.total + " |");
  L.push("");
  L.push("## 准确率");
  L.push("");
  L.push("| 指标 | 值 |");
  L.push("| --- | --- |");
  L.push("| PAGE_OCR_SUCCESS_RATE | " + p(agg.PAGE_OCR_SUCCESS_RATE) + " |");
  L.push("| PAGE_SPLIT_COUNT_ACCURACY | " + p(agg.PAGE_SPLIT_COUNT_ACCURACY) + " |");
  L.push("| SCREEN_NUMBER_ACCURACY | " + p(agg.SCREEN_NUMBER_ACCURACY) + " |");
  L.push("| TYPE_ACCURACY | " + p(agg.TYPE_ACCURACY) + " |");
  L.push("| TOP1_MATCH_ACCURACY | " + p(agg.TOP1_MATCH_ACCURACY) + " |");
  L.push("| TOP3_MATCH_ACCURACY | " + p(agg.TOP3_MATCH_ACCURACY) + " |");
  L.push("| ANSWER_ACCURACY（全部题口径） | " + p(agg.ANSWER_ACCURACY) + " |");
  L.push("| ANSWER_ACCURACY_RAW（不看置信度掩码） | " + p(agg.ANSWER_ACCURACY_RAW) + " |");
  L.push("| ANSWER_COVERAGE（给出答案的比例） | " + p(agg.ANSWER_COVERAGE) + " |");
  L.push("| ANSWERED_PRECISION（给出答案中答对比例） | " + p(agg.ANSWERED_PRECISION) + " |");
  L.push("");
  L.push("## 分置信度显示精度（当前绿/橙/红 UI 的真实显示行为）");
  L.push("");
  L.push("| 置信度 | 显示数 | 答对 | 精度 |");
  L.push("| --- | --- | --- | --- |");
  [["high", "高(绿)"], ["medium", "中(橙)"], ["low", "低(红)"]].forEach(([k, name]) => {
    const n = agg.confShown[k] || 0, ok = agg.confShownOk[k] || 0;
    L.push("| " + name + " | " + n + " | " + ok + " | " + (n ? (ok / n * 100).toFixed(2) + "%" : "—") + " |");
  });
  L.push("| none(灰 ?) | " + (agg.confidence.none || 0) + " | — | — |");
  L.push("");
  L.push("- OVERALL_DISPLAY_COUNT = " + agg.OVERALL_DISPLAY_COUNT);
  L.push("- OVERALL_DISPLAY_PRECISION = " + (agg.OVERALL_DISPLAY_PRECISION === null ? "—" : p(agg.OVERALL_DISPLAY_PRECISION)));
  L.push("- OVERALL_DISPLAY_COVERAGE = " + p(agg.OVERALL_DISPLAY_COVERAGE));
  L.push("");
  L.push("## 置信度分布");
  L.push("");
  L.push("| 置信度 | 条数 | 其中答案错 |");
  L.push("| --- | --- | --- |");
  ["high", "medium", "low", "none"].forEach(k => {
    L.push("| " + k + " | " + (agg.confidence[k] || 0) + " | " + (agg.confidenceWrong[k] || 0) + " |");
  });
  L.push("");
  L.push("- HIGH_CONFIDENCE_WRONG = **" + agg.HIGH_CONFIDENCE_WRONG + "**");
  L.push("- MEDIUM_CONFIDENCE_WRONG = " + agg.MEDIUM_CONFIDENCE_WRONG);
  L.push("- LOW_CONFIDENCE_WRONG = " + agg.LOW_CONFIDENCE_WRONG);
  L.push("- CONFIDENCE_FALSE_NEGATIVE（匹配对但显示 ?）= " + agg.CONFIDENCE_FALSE_NEGATIVE);
  L.push("");
  L.push("## 耗时（image-to-answer，不含对焦/快门/Camera 启动）");
  L.push("");
  L.push("| 阶段 | mean | p50 | p90 | p95 | max |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  ["OCR_TIME_MS", "SPLIT_TIME_MS", "MATCH_TIME_MS", "TOTAL_PIPELINE_MS"].forEach(k => {
    const s = agg.timing[k];
    L.push("| " + k + " | " + f(s.mean) + " | " + f(s.p50) + " | " + f(s.p90) + " | " + f(s.p95) + " | " + f(s.max) + " |");
  });
  L.push("");
  L.push("- 吞吐：" + f(agg.throughput.QUESTIONS_PER_SECOND) + " 题/秒 · " +
    f(agg.throughput.PAGES_PER_MINUTE) + " 页/分钟");
  L.push("- 说明：" + meta.timingNote);
  L.push("");
  L.push("## 失败分类");
  L.push("");
  L.push("| 类别 | 数量 |");
  L.push("| --- | --- |");
  FAILURE_CATEGORIES.forEach(c => { L.push("| " + c + " | " + agg.failureCounts[c] + " |"); });
  L.push("");
  L.push("## Top 10 失败样本");
  L.push("");
  if (!agg.topFailures.length) {
    L.push("（无失败样本）");
  } else {
    L.push("| # | 页 | 题号 | 类别 | 说明 | 期望 bankId/答案 | 实得 bankId/答案 | 置信度 |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    agg.topFailures.forEach((x, i) => {
      L.push("| " + (i + 1) + " | " + x.pageId + " | " + x.screenNumber + " | " + x.category + " | " +
        String(x.detail).replace(/\|/g, "/") + " | " + x.expectedBankId + "/" + x.expectedAnswer + " | " +
        (x.gotBankId === null ? "—" : x.gotBankId) + "/" + x.gotAnswer + " | " + x.confidence + " |");
    });
  }
  L.push("");
  L.push("> 失败样本的完整证据（截图路径 / Ground Truth / ML Kit 全文与坐标 / 分题结果 / Top3 分数）" +
    "保存在 `.generated/failures/`。");
  L.push("");
  return L.join("\n");
}

module.exports = { stats, charCoverage, classifyFailure, aggregate, renderMarkdown,
  FAILURE_CATEGORIES, COVERAGE_OK };
