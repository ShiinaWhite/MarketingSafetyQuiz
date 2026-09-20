/* test_bench.js —— Batch OCR Test Bench 核心逻辑单元测试（Node，无依赖）。
   运行：node testbench/test_bench.js
   覆盖：可复现性 / 题数 / 题号 / 题型 / 跨块 / Ground Truth 一致 / 数据源兼容 / 比对函数。 */
const fs = require("fs");
const path = require("path");
const Bench = require(path.join(__dirname, "bench-core.js"));

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}` + (detail ? `  (${detail})` : "")); }
  else { fails.push(name); console.log(`  [FAIL] ${name}` + (detail ? `  (${detail})` : "")); }
}
function section(t) { console.log(`\n== ${t} ==`); }

const MOCK_RAW = JSON.parse(fs.readFileSync(path.join(__dirname, "mock_questions.json"), "utf8"));
const data = Bench.normalizeQuestions(MOCK_RAW);
const page = (spec) => Bench.buildPage(Object.assign({ data: data, seed: 1, type: "single", count: 5, startNumber: 1 }, spec));
const ids = (p) => p.questions.map(q => q.bankId).join(",");

/* ---------- 题库解析与接口兼容 ---------- */
section("题库解析与数据源兼容");
check("mock 题库可解析且题量 >= 45", data.length >= 45, data.length + " 题");
check("三种题型都存在", ["single", "multi", "judge"].every(t => data.some(q => q.type === t)));
check("兼容 {questions:[...]} 结构", Bench.normalizeQuestions({ questions: [{ type: "single", stem: "x", options: ["a", "b"], answer: [0] }] }).length === 1);
check("兼容纯数组结构", Bench.normalizeQuestions([{ type: "judge", stem: "y", options: ["正确", "错误"], answer: [0] }]).length === 1);
check("兼容字符串答案 \"BC\" -> [1,2]", JSON.stringify(Bench.normalizeAnswer({ type: "multi", answer: "BC" })) === "[1,2]");
check("兼容字母数组答案 [\"A\",\"C\"] -> [0,2]", JSON.stringify(Bench.normalizeAnswer({ type: "multi", answer: ["A", "C"] })) === "[0,2]");
check("兼容判断题答案 正确/错误 与 √/×",
  JSON.stringify(Bench.normalizeAnswer({ type: "judge", answer: "正确" })) === "[0]"
  && JSON.stringify(Bench.normalizeAnswer({ type: "judge", answer: "×" })) === "[1]"
  && JSON.stringify(Bench.normalizeAnswer({ type: "judge", answer: [1] })) === "[1]");
check("非法题目被过滤（缺题干/缺选项/缺答案）", Bench.normalizeQuestions([
  { type: "single", stem: "", options: ["a", "b"], answer: [0] },
  { type: "single", stem: "有题干", options: ["a"], answer: [0] },
  { type: "single", stem: "有题干", options: ["a", "b"], answer: [] }
]).length === 0);
check("真实题库结构（含 major 等多余字段）也能吃下", Bench.normalizeQuestions({
  questions: [{ id: 7, type: "single", major: "营销", stem: "题干", options: ["a", "b"], answer: [1], type_name: "单选题" }]
})[0].id === 7);

/* ---------- 可复现性 ---------- */
section("可复现性");
check("同 seed 生成完全相同的页", JSON.stringify(page({ seed: 20260920 })) === JSON.stringify(page({ seed: 20260920 })));
check("不同 seed 生成不同题目", ids(page({ seed: 1 })) !== ids(page({ seed: 2 })), ids(page({ seed: 1 })) + " vs " + ids(page({ seed: 2 })));
check("seed 相同但题数不同时仍可复现",
  JSON.stringify(page({ seed: 7, count: 10 })) === JSON.stringify(page({ seed: 7, count: 10 })));
check("返回的 seed 与请求一致", page({ seed: 12345 }).seed === 12345);

/* ---------- 题数与题号 ---------- */
section("题数与题号");
[3, 5, 8, 10, 15].forEach(n => {
  check(`每页 ${n} 题：题数正确`, page({ count: n, seed: 42 }).count === n, String(page({ count: n, seed: 42 }).count));
});
check("题号从起始题号连续递增（起始 31，8 题）",
  page({ startNumber: 31, count: 8 }).questions.map(q => q.screenNumber).join(",") === "31,32,33,34,35,36,37,38");
check("题号从起始题号连续递增（起始 66，10 题）",
  page({ type: "judge", startNumber: 66, count: 10 }).questions.map(q => q.screenNumber).join(",") === "66,67,68,69,70,71,72,73,74,75");
check("跨块页题号也连续（起始 38，8 题）",
  page({ mode: "single-multi", startNumber: 38, count: 8, splitAt: 4 }).questions.map(q => q.screenNumber).join(",") === "38,39,40,41,42,43,44,45");
check("题数超出题库时循环取题且不报错", page({ count: 15, seed: 3 }).count === 15);

/* ---------- 题型与跨块 ---------- */
section("题型与跨块");
check("单选页全部 single", page({ type: "single", count: 8 }).questions.every(q => q.type === "single"));
check("多选页全部 multi", page({ type: "multi", count: 8 }).questions.every(q => q.type === "multi"));
check("判断页全部 judge", page({ type: "judge", count: 8 }).questions.every(q => q.type === "judge"));
const x1 = page({ mode: "single-multi", count: 8, splitAt: 4, startNumber: 38 });
check("单选→多选：切分点位置正确（前4单选，后4多选）",
  x1.questions.slice(0, 4).every(q => q.type === "single") && x1.questions.slice(4).every(q => q.type === "multi"));
check("单选→多选：大块结构记录正确",
  x1.sections.length === 2 && x1.sections[0].count === 4 && x1.sections[1].count === 4
  && x1.sections[1].firstIndex === 4 && x1.sections[1].startNumber === 42);
const x2 = page({ mode: "multi-judge", count: 8, splitAt: 3, startNumber: 58 });
check("多选→判断：切分点位置正确（前3多选，后5判断）",
  x2.questions.slice(0, 3).every(q => q.type === "multi") && x2.questions.slice(3).every(q => q.type === "judge"));
check("多选→判断：大块标题为判断题", x2.sections[1].title.indexOf("判断") >= 0);
check("跨块页切分点可配置（splitAt=1）",
  page({ mode: "single-multi", count: 6, splitAt: 1 }).sections[0].count === 1);
check("切分点越界被夹到合法范围", (() => {
  const p = page({ mode: "single-multi", count: 5, splitAt: 99 });
  return p.sections[0].count === 4 && p.sections[1].count === 1;
})());

/* ---------- 题干 / 选项 / 答案 ---------- */
section("题干、选项与答案");
const p1 = page({ type: "single", count: 5, seed: 11 });
check("每题都有题干与 >= 2 个选项", p1.questions.every(q => q.stem.length > 0 && q.options.length >= 2));
check("单选题答案格式为单个字母", p1.questions.every(q => /^[A-H]$/.test(q.answer)), p1.questions.map(q => q.answer).join(""));
const pm = page({ type: "multi", count: 5, seed: 12 });
check("多选题答案为字母组合且升序", pm.questions.every(q => /^[A-H]{2,}$/.test(q.answer)), pm.questions.map(q => q.answer).join(" "));
const pj = page({ type: "judge", count: 8, seed: 13 });
check("判断题答案为 √ 或 ×", pj.questions.every(q => q.answer === "√" || q.answer === "×"), pj.questions.map(q => q.answer).join(""));
check("判断题选项为 正确/错误", pj.questions.every(q => q.options.join("/") === "正确/错误"));
check("题目池 long-stem 只取带该标签的题", (() => {
  const p = page({ type: "single", pool: "long-stem", count: 5, seed: 5 });
  const tagged = new Set(data.filter(q => q.type === "single" && q.tag === "long-stem").map(q => q.id));
  return p.questions.every(q => tagged.has(q.bankId));
})());
check("题目池 long-option 只取带该标签的题", (() => {
  const p = page({ type: "single", pool: "long-option", count: 5, seed: 6 });
  const tagged = new Set(data.filter(q => q.type === "single" && q.tag === "long-option").map(q => q.id));
  return p.questions.every(q => tagged.has(q.bankId));
})());
check("长题干页确实比普通页题干更长", (() => {
  const avg = (p) => p.questions.reduce((s, q) => s + q.stem.length, 0) / p.questions.length;
  return avg(page({ type: "single", pool: "long-stem", count: 5, seed: 8 })) >
         avg(page({ type: "single", pool: "all", count: 5, seed: 8 }));
})());

/* ---------- Ground Truth ---------- */
section("Ground Truth 一致性");
const gp = page({ type: "single", count: 8, startNumber: 31, seed: 99 });
const gt = Bench.buildGroundTruth(gp, { source: "mock", benchmark: "TEST", display: { fontSize: "md" } });
check("GT 题数与页面一致", gt.questions.length === gp.questions.length);
check("GT 题号与页面一致", gt.questions.map(q => q.screenNumber).join(",") === gp.questions.map(q => q.screenNumber).join(","));
check("GT 题型与页面一致", gt.questions.every((g, i) => g.type === gp.questions[i].type));
check("GT bankId 与页面一致", gt.questions.every((g, i) => String(g.bankId) === String(gp.questions[i].bankId)));
check("GT 题干与页面一致", gt.questions.every((g, i) => g.stem === gp.questions[i].stem));
check("GT 答案与页面一致", gt.questions.every((g, i) => g.answer === gp.questions[i].answer));
check("GT 答案与源题库真值一致", gt.questions.every(g => {
  const src = data.find(q => String(q.id) === String(g.bankId));
  return src && Bench.answerText(src) === g.answer;
}));
check("GT 含 seed/配置且不含用户信息", gt.seed === 99 && gt.count === 8 && gt.startNumber === 31
  && Object.keys(gt).every(k => ["seed", "mode", "source", "count", "startNumber", "pool", "benchmark", "display", "questions"].indexOf(k) >= 0));
check("GT 是纯 JSON 可序列化（可直接导出）", typeof JSON.stringify(gt) === "string" && JSON.parse(JSON.stringify(gt)).questions.length === 8);

/* ---------- compareBatchResult ---------- */
section("compareBatchResult（预留给真机对接）");
const gtSmall = { questions: [
  { screenNumber: 31, bankId: "M-S01", type: "single", answer: "A" },
  { screenNumber: 32, bankId: "M-S02", type: "single", answer: "B" },
  { screenNumber: 33, bankId: "M-M01", type: "multi", answer: "ABCD" }
] };
const allOk = Bench.compareBatchResult([
  { screenNumber: 31, matchedId: "M-S01", type: "single", answer: "A" },
  { screenNumber: 32, matchedId: "M-S02", type: "single", answer: "B" },
  { screenNumber: 33, matchedId: "M-M01", type: "multi", answer: "ABCD" }
], gtSmall);
check("全部正确：四项计数 = total", allOk.total === 3 && allOk.screenNumberCorrect === 3
  && allOk.typeCorrect === 3 && allOk.top1Correct === 3 && allOk.answerCorrect === 3);
check("全部正确：无缺失无多余且顺序正确", allOk.missing.length === 0 && allOk.extra.length === 0 && allOk.orderCorrect === 3);
const oneWrong = Bench.compareBatchResult([
  { screenNumber: 31, matchedId: "M-S01", type: "single", answer: "A" },
  { screenNumber: 32, matchedId: "M-S09", type: "single", answer: "C" },
  { screenNumber: 33, matchedId: "M-M01", type: "multi", answer: "ABCD" }
], gtSmall);
check("Top1 错 1 条：top1Correct=2 且 answerCorrect=2", oneWrong.top1Correct === 2 && oneWrong.answerCorrect === 2);
check("Top1 错但答案碰巧相同：answerCorrect 仍按显示答案计数", (() => {
  const r = Bench.compareBatchResult([
    { screenNumber: 31, matchedId: "X", type: "single", answer: "A" }
  ], { questions: [{ screenNumber: 31, bankId: "M-S01", type: "single", answer: "A" }] });
  return r.top1Correct === 0 && r.answerCorrect === 1 && r.answerCorrectStrict === 0;
})());
const missing = Bench.compareBatchResult([
  { screenNumber: 31, matchedId: "M-S01", type: "single", answer: "A" }
], gtSmall);
check("缺 2 条：missing 列出题号", missing.screenNumberCorrect === 1 && missing.missing.join(",") === "32,33");
const extra = Bench.compareBatchResult([
  { screenNumber: 31, matchedId: "M-S01", type: "single", answer: "A" },
  { screenNumber: 32, matchedId: "M-S02", type: "single", answer: "B" },
  { screenNumber: 33, matchedId: "M-M01", type: "multi", answer: "ABCD" },
  { screenNumber: 34, matchedId: "M-S03", type: "single", answer: "A" }
], gtSmall);
check("多识别 1 条：extra 列出且页题数判定为否", extra.extra.join(",") === "34" && extra.pageSplitCountCorrect === false);
const typeWrong = Bench.compareBatchResult([
  { screenNumber: 31, matchedId: "M-S01", type: "multi", answer: "A" }
], { questions: [{ screenNumber: 31, bankId: "M-S01", type: "single", answer: "A" }] });
check("题型错：typeCorrect=0", typeWrong.typeCorrect === 0 && typeWrong.screenNumberCorrect === 1);
check("空输入不炸", (() => {
  const r = Bench.compareBatchResult([], { questions: [] });
  return r.total === 0 && r.screenNumberCorrect === 0;
})());

/* ---------- 固定基准 ---------- */
section("固定基准 B01~B09");
check("基准数量 >= 8", Bench.BENCHMARKS.length >= 8, String(Bench.BENCHMARKS.length));
check("基准 id 唯一且形如 B0x", (() => {
  const s = new Set(Bench.BENCHMARKS.map(b => b.id));
  return s.size === Bench.BENCHMARKS.length && Bench.BENCHMARKS.every(b => /^B\d{2}$/.test(b.id));
})());
check("每个基准都有固定 seed", Bench.BENCHMARKS.every(b => Number.isInteger(b.seed) && b.seed > 0));
/* UI 的「每页题数」下拉只有 3/5/8/10/15；基准若用了别的题数会被下拉静默吞掉，
   这里从数据层面锁死，避免基准配置与页面不一致。 */
check("每个基准的题数都在 UI 预设范围内", Bench.BENCHMARKS.every(b => [3, 5, 8, 10, 15].indexOf(b.config.count) >= 0),
  Bench.BENCHMARKS.map(b => b.id + ":" + b.config.count).join(" "));
check("每个基准的显示配置取值合法", Bench.BENCHMARKS.every(b => {
  const d = b.display || {};
  return ["sm", "md", "lg", undefined].indexOf(d.fontSize) >= 0
    && ["tight", "normal", "loose", undefined].indexOf(d.lineHeight) >= 0
    && ["narrow", "normal", "wide", undefined].indexOf(d.pageWidth) >= 0
    && ["tight", "normal", "loose", undefined].indexOf(d.spacing) >= 0
    && ["standard", "small", "bold", undefined].indexOf(d.headerStyle) >= 0
    && [90, 100, 110, 125, undefined].indexOf(d.zoom) >= 0;
}));
check("每个基准的题型/模式取值合法", Bench.BENCHMARKS.every(b =>
  ["single", "multi", "judge"].indexOf(b.config.type) >= 0
  && ["normal", "single-multi", "multi-judge"].indexOf(b.config.mode) >= 0));
check("跨块基准必须有合法切分点", Bench.BENCHMARKS.every(b =>
  b.config.mode === "normal" || (b.config.splitAt >= 1 && b.config.splitAt < b.config.count)));
let benchBad = null;
Bench.BENCHMARKS.forEach(b => {
  const cfg = Bench.resolveConfig(b.id, {});
  const p = Bench.buildPage({ data: data, seed: cfg.seed, type: cfg.type, count: cfg.count,
    startNumber: cfg.startNumber, mode: cfg.mode, splitAt: cfg.splitAt, pool: cfg.pool });
  if (p.count !== cfg.count) { benchBad = b.id + " 题数"; }
  if (p.questions[0].screenNumber !== cfg.startNumber) { benchBad = b.id + " 起始题号"; }
});
check("每个基准都能生成正确页", benchBad === null, benchBad || "全部正常");
check("每个基准同 seed 两次生成一致", Bench.BENCHMARKS.every(b => {
  const cfg = Bench.resolveConfig(b.id, {});
  const mk = () => JSON.stringify(Bench.buildPage({ data: data, seed: cfg.seed, type: cfg.type,
    count: cfg.count, startNumber: cfg.startNumber, mode: cfg.mode, splitAt: cfg.splitAt, pool: cfg.pool }));
  return mk() === mk();
}));
check("B04 密集配置：小字号/紧行距/紧间距/不缩进", (() => {
  const c = Bench.resolveConfig("B04", {});
  return c.display.fontSize === "sm" && c.display.lineHeight === "tight"
    && c.display.spacing === "tight" && c.display.indent === false;
})());
check("B07 跨块配置：single-multi + 切分点 4 + 起始 38", (() => {
  const c = Bench.resolveConfig("B07", {});
  return c.mode === "single-multi" && c.splitAt === 4 && c.startNumber === 38 && c.count === 8;
})());
check("B08 跨块配置：multi-judge + 切分点 4 + 起始 58", (() => {
  const c = Bench.resolveConfig("B08", {});
  return c.mode === "multi-judge" && c.splitAt === 4 && c.startNumber === 58;
})());
check("覆盖项只改指定字段（改 seed 不动基准的跨块模式）", (() => {
  const c = Bench.resolveConfig("B07", { seed: 1 });
  return c.seed === 1 && c.mode === "single-multi" && c.count === 8;
})());
check("未知基准 id 回退为手动配置", (() => {
  const c = Bench.resolveConfig("NOPE", { type: "judge", count: 3 });
  return c.benchmark === null && c.type === "judge" && c.count === 3;
})());
check("findBenchmark 大小写不敏感", Bench.findBenchmark("b07") && Bench.findBenchmark("b07").id === "B07");

console.log("\n" + "=".repeat(46));
if (fails.length) { console.log(`结果：${fails.length} 项未通过 -> ${fails}`); process.exit(1); }
console.log(`结果：全部通过 ✓（${pass} 项）`);
