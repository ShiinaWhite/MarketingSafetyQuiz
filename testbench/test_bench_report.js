/* test_bench_report.js —— 基准测试报告层单元测试（Node，无依赖）。
   运行：node testbench/test_bench_report.js
   注意：这里只测统计/分类/汇总/渲染这些纯函数，不涉及 OCR，也不产生任何准确率声明。 */
const report = require("./harness/report.js");

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}` + (detail ? `  (${detail})` : "")); }
  else { fails.push(name); console.log(`  [FAIL] ${name}` + (detail ? `  (${detail})` : "")); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/* ---------- stats ---------- */
section("stats 百分位");
const s1 = report.stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
check("count/mean/min/max", s1.count === 10 && s1.mean === 55 && s1.min === 10 && s1.max === 100);
check("p50 = 中位数", s1.p50 === 55, String(s1.p50));
check("p90 = 91", Math.abs(s1.p90 - 91) < 1e-9, String(s1.p90));
check("p95 = 95.5", Math.abs(s1.p95 - 95.5) < 1e-9, String(s1.p95));
check("单元素数组不炸", report.stats([7]).p95 === 7);
check("空数组返回 0 而不是 NaN", (() => {
  const s = report.stats([]);
  return s.count === 0 && s.mean === 0 && s.p95 === 0 && s.max === 0;
})());
check("忽略非数字/NaN", report.stats([1, NaN, 3, null, undefined, 5]).count === 3);

/* ---------- charCoverage ---------- */
section("charCoverage 字符覆盖度");
check("完全相同 = 1", report.charCoverage("根据营销安规规定", "根据营销安规规定") === 1);
check("标点与空格不参与计算", report.charCoverage("安全带（围栏）", "安全带 围栏") === 1);
check("缺失一半 ≈ 0.5", Math.abs(report.charCoverage("一二三四五六七八", "一二三四") - 0.5) < 1e-9);
check("空期望 = 1（不算失败）", report.charCoverage("", "任意") === 1);
check("重复字符按多重集计算", Math.abs(report.charCoverage("aaab", "ab") - 0.5) < 1e-9);
check("完全无关 ≈ 0", report.charCoverage("一二三四五六七八", "abcdefgh") === 0);

/* ---------- classifyFailure ---------- */
section("classifyFailure 失败分类");
const exp = { screenNumber: 31, type: "single", bankId: 118, answer: "B", stem: "根据营销安规规定，安全带应定期检验。" };
const okBlock = { screenNumber: "31", type: "single", confidence: "high", bankId: 118, answerRaw: "B",
  answerDisplayed: "B", stemText: "根据营销安规规定，安全带应定期检验。", matches: [{ id: 118, score: 900 }] };
const pageOk = { blocks: 1, expected: 1 };
const ctx = (over) => Object.assign({ pageOcrOk: true, splitCountOk: true, block: okBlock, expected: exp, page: pageOk }, over);
check("本页 OCR 失败 -> OCR_TEXT_ERROR", report.classifyFailure(ctx({ pageOcrOk: false })).category === "OCR_TEXT_ERROR");
check("题块数量不符 -> SPLIT_ERROR", report.classifyFailure(ctx({ splitCountOk: false, page: { blocks: 2, expected: 1 } })).category === "SPLIT_ERROR");
check("没有对应题块 -> SPLIT_ERROR/UNCLASSIFIED",
  report.classifyFailure(ctx({ block: null })).category === "UNCLASSIFIED"
  && report.classifyFailure(ctx({ block: null, splitCountOk: false })).category === "SPLIT_ERROR");
check("题型错 -> TYPE_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { type: "multi" }) })).category === "TYPE_ERROR");
check("题号错 -> QUESTION_NUMBER_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { screenNumber: "37" }) })).category === "QUESTION_NUMBER_ERROR");
check("题号数字与字符串不一致不算错（31 vs \"31\"）",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { screenNumber: 31 }) })).category !== "QUESTION_NUMBER_ERROR");
check("题干覆盖度过低 -> OCR_TEXT_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { stemText: "安全带" }) })).category === "OCR_TEXT_ERROR");
check("文本正常但 Top1 错 -> MATCH_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { bankId: 999, matches: [{ id: 999, score: 800 }] }) })).category === "MATCH_ERROR");
check("匹配对但低置信度 -> CONFIDENCE_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { confidence: "low" }) })).category === "CONFIDENCE_ERROR");
check("匹配对、高置信度但答案不符 -> ANSWER_UI_ERROR",
  report.classifyFailure(ctx({ block: Object.assign({}, okBlock, { answerDisplayed: "C" }) })).category === "ANSWER_UI_ERROR");
check("分类优先级：OCR 失败优先于其它",
  report.classifyFailure(ctx({ pageOcrOk: false, block: Object.assign({}, okBlock, { type: "multi" }) })).category === "OCR_TEXT_ERROR");

/* ---------- aggregate ---------- */
section("aggregate 汇总");
function rec(pageId, gtQuestions, blocks, ocrOver, timing) {
  return {
    pageId: pageId, profile: "ceiling",
    ocr: Object.assign({ ms: 100, text: "x", lines: [], err: null }, ocrOver || {}),
    timings: Object.assign({ ocrMs: 100, splitMs: 1, matchMs: 5, totalMs: 106 }, timing || {}),
    blocks: blocks, gt: { questions: gtQuestions }
  };
}
const q = (n, type, id, ans, stem) => ({ screenNumber: n, type: type, bankId: id, answer: ans, stem: stem || "题干内容若干字" });
/* 与真实链路一致：低/无置信度时界面显示 ?（run_benchmark.js 的 batchAnswerDisplay 规则） */
const b = (n, type, id, ans, conf, opts) => Object.assign({
  screenNumber: String(n), type: type, bankId: id, answerRaw: ans,
  answerDisplayed: (conf === "low" || conf === "none") ? "?" : ans,
  confidence: conf, stemText: "题干内容若干字", matches: [{ id: id, score: 900 }, { id: 1, score: 100 }]
}, opts || {});
const recs = [
  rec("P1", [q(31, "single", 118, "B"), q(32, "single", 57, "A")],
    [b(31, "single", 118, "B", "high"), b(32, "single", 57, "A", "medium")]),
  rec("P2", [q(41, "multi", 200, "AC"), q(42, "multi", 201, "B", "题干内容若干字")],
    [b(41, "multi", 999, "BD", "high"), b(42, "multi", 201, "B", "low")]),
  rec("P3", [q(51, "judge", 300, "√")], [], { err: "OCR_FAILED", text: "" })
];
const agg = report.aggregate(recs);
check("总页数/总题数", agg.pages === 3 && agg.questions === 5, agg.pages + " 页 / " + agg.questions + " 题");
check("PAGE_OCR_SUCCESS_RATE = 2/3", Math.abs(agg.PAGE_OCR_SUCCESS_RATE - 66.6667) < 0.01, agg.PAGE_OCR_SUCCESS_RATE.toFixed(2));
check("PAGE_SPLIT_COUNT_ACCURACY = 1/3（P3 空、P2 数量对）",
  Math.abs(agg.PAGE_SPLIT_COUNT_ACCURACY - 66.6667) < 0.01, agg.PAGE_SPLIT_COUNT_ACCURACY.toFixed(2));
check("SCREEN_NUMBER_ACCURACY = 4/5", Math.abs(agg.SCREEN_NUMBER_ACCURACY - 80) < 0.01);
check("TYPE_ACCURACY = 4/5", Math.abs(agg.TYPE_ACCURACY - 80) < 0.01);
check("TOP1 = 3/5", Math.abs(agg.TOP1_MATCH_ACCURACY - 60) < 0.01);
check("TOP3 = 3/5（P2 首题与 P3 无候选）", Math.abs(agg.TOP3_MATCH_ACCURACY - 60) < 0.01, agg.TOP3_MATCH_ACCURACY.toFixed(1));
check("ANSWER_ACCURACY（显示）= 2/5（低置信度被掩码成 ?）", Math.abs(agg.ANSWER_ACCURACY - 40) < 0.01, agg.ANSWER_ACCURACY.toFixed(1));
check("ANSWER_ACCURACY_RAW = 3/5（不看掩码）", Math.abs(agg.ANSWER_ACCURACY_RAW - 60) < 0.01, agg.ANSWER_ACCURACY_RAW.toFixed(1));
check("置信度分布 high2/medium1/low1/none1",
  agg.confidence.high === 2 && agg.confidence.medium === 1 && agg.confidence.low === 1 && agg.confidence.none === 1,
  JSON.stringify(agg.confidence));
check("HIGH_CONFIDENCE_WRONG = 1（P2 那道高置信度但错）", agg.HIGH_CONFIDENCE_WRONG === 1, String(agg.HIGH_CONFIDENCE_WRONG));
check("CONFIDENCE_FALSE_NEGATIVE = 1（匹配对却因低置信度显示 ?）", agg.CONFIDENCE_FALSE_NEGATIVE === 1);
check("失败分类计数（MATCH/OCR/CONFIDENCE 各 1，其余 0）",
  agg.failureCounts.MATCH_ERROR === 1 && agg.failureCounts.OCR_TEXT_ERROR === 1
  && agg.failureCounts.CONFIDENCE_ERROR === 1
  && report.FAILURE_CATEGORIES.filter(c => ["MATCH_ERROR", "OCR_TEXT_ERROR", "CONFIDENCE_ERROR"].indexOf(c) < 0)
       .every(c => agg.failureCounts[c] === 0), JSON.stringify(agg.failureCounts));
check("失败样本带 Top3 与覆盖度", agg.failures.every(x => Array.isArray(x.top3) && typeof x.stemCoverage === "number"));
check("耗时统计四类齐全", ["OCR_TIME_MS", "SPLIT_TIME_MS", "MATCH_TIME_MS", "TOTAL_PIPELINE_MS"]
  .every(k => agg.timing[k] && typeof agg.timing[k].p95 === "number"));
check("吞吐为正数", agg.throughput.QUESTIONS_PER_SECOND > 0 && agg.throughput.PAGES_PER_MINUTE > 0,
  agg.throughput.QUESTIONS_PER_SECOND.toFixed(2) + " 题/秒");
check("空记录不炸", (() => {
  const a = report.aggregate([]);
  return a.pages === 0 && a.questions === 0 && a.TOP1_MATCH_ACCURACY === 0 && a.throughput.PAGES_PER_MINUTE === 0;
})());

/* ---------- renderMarkdown ---------- */
section("renderMarkdown 报告");
const md = report.renderMarkdown({
  baselineCommit: "abc1234", runtime: "test device", mlkit: "mlkit-x", source: "private",
  bankSize: 392, profile: "ceiling", coverage: { used: 392, total: 392 }, timingNote: "note"
}, agg);
["测试环境", "准确率", "置信度分布", "耗时", "失败分类", "Top 10 失败样本",
  "PAGE_SPLIT_COUNT_ACCURACY", "SCREEN_NUMBER_ACCURACY", "TYPE_ACCURACY", "TOP1_MATCH_ACCURACY",
  "TOP3_MATCH_ACCURACY", "ANSWER_ACCURACY", "HIGH_CONFIDENCE_WRONG", "OCR_TIME_MS",
  "TOTAL_PIPELINE_MS", "abc1234"].forEach(k => {
  check("报告含「" + k + "」", md.indexOf(k) >= 0);
});
check("报告列出失败样本行", md.indexOf("| 1 | P2 |") >= 0);
check("失败样本里的竖线被转义（不破坏表格）", md.split("\n").filter(l => l.indexOf("| 1 | P2 |") >= 0)[0].split("|").length >= 9);

console.log("\n" + "=".repeat(46));
if (fails.length) { console.log(`结果：${fails.length} 项未通过 -> ${fails}`); process.exit(1); }
console.log(`结果：全部通过 ✓（${pass} 项）`);
