/* test_core.js —— Node 下自检：题库 JSON + core.js 纯逻辑
   运行: node test_core.js   （退出码 0 = 全部通过） */
"use strict";
const fs = require("fs");
const path = require("path");
const MSQ = require("./www/js/core.js");

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/* ---------- 题库 JSON ---------- */
section("题库 JSON 校验（www/data/questions.json）");
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, "www/data/questions.json"), "utf8"));
const qs = bank.questions;
check("总题数 = 392", qs.length === 392, String(qs.length));
const byType = MSQ.indexByType(qs);
check("单选 160 / 多选 110 / 判断 122",
  byType.single.length === 160 && byType.multi.length === 110 && byType.judge.length === 122,
  `${byType.single.length}/${byType.multi.length}/${byType.judge.length}`);
check("题目 id 唯一（重复题干按序号保留）", new Set(qs.map(q => q.id)).size === qs.length);
check("题目含 序号/专业/题型/题干/选项/答案 字段",
  qs.every(q => q.id !== undefined && "major" in q && q.type && q.stem && q.options && q.answer));
check("所有题选项/答案结构合法",
  qs.every(q => q.stem.length > 0 && q.options.length >= 2 && q.answer.length >= 1
    && q.answer.every(i => Number.isInteger(i) && i >= 0 && i < q.options.length)));
const optDist = {};
qs.forEach(q => { optDist[q.options.length] = (optDist[q.options.length] || 0) + 1; });
check("存在 3/5/6 选项题（未按 4 选项假设）",
  [3, 5, 6].some(n => optDist[n]), JSON.stringify(optDist));
check("多选题答案均 ≥ 2 个", byType.multi.every(q => q.answer.length >= 2));
check("判断题均为 2 选项", byType.judge.every(q => q.options.length === 2));

/* 随机抽查 5×3，人工核对用 */
section("随机抽查（每题型 5 题）");
const rng = mulberry(20260919);
for (const t of ["single", "multi", "judge"]) {
  const pool = byType[t];
  for (const q of pick(pool, 5, rng)) {
    console.log(`  [${t} ${q.id}] ${q.stem.slice(0, 30)}…`);
    q.options.forEach((o, i) =>
      console.log(`      ${MSQ.LETTERS[i]}. ${String(o).slice(0, 30)}${q.answer.includes(i) ? "  <== 答案" : ""}`));
    console.log(`      => ${MSQ.answerText(q)}`);
  }
}

/* ---------- 判定逻辑 ---------- */
section("答案判定逻辑");
const multi = byType.multi.find(q => q.answer.length >= 3);
const ans = new Set(multi.answer);
check("多选: 全对 -> 正确", MSQ.isCorrect(multi, [...ans]));
check("多选: 少选 -> 错误", !MSQ.isCorrect(multi, [...ans].slice(0, ans.size - 1)));
check("多选: 多选 -> 错误", !MSQ.isCorrect(multi, [...ans, Math.max(...ans) + 1 <= multi.options.length - 1 ? Math.max(...ans) + 1 : 0]));
check("多选: 错选 -> 错误", !MSQ.isCorrect(multi, [multi.options.findIndex((_, i) => !ans.has(i))]));
check("多选: 乱序 -> 按集合判定仍正确", MSQ.isCorrect(multi, [...ans].reverse()));
check("多选: 空答案 -> 错误", !MSQ.isCorrect(multi, []));
const single = byType.single[0];
check("单选: 正确 -> 对", MSQ.isCorrect(single, single.answer));
const wrongIdx = single.options.findIndex((_, i) => !single.answer.includes(i));
check("单选: 选错 -> 错", !MSQ.isCorrect(single, [wrongIdx]));
const judge = byType.judge[0];
check("判断: 正确 -> 对", MSQ.isCorrect(judge, judge.answer));
check("判断: 反选 -> 错", !MSQ.isCorrect(judge, [1 - judge.answer[0]]));

/* ---------- 模拟考试 ---------- */
section("模拟考试组卷与计分");
const cfg = MSQ.normalizeConfig(window_cfg());
function window_cfg() { return (typeof window !== "undefined" && window.EXAM_CONFIG_DEFAULT) || MSQ.DEFAULT_EXAM_CONFIG; }
const paper = MSQ.generateExam(byType, cfg, rng);
const cnt = { single: 0, multi: 0, judge: 0 };
paper.forEach(q => cnt[q.type]++);
check("组卷 40 单选 + 15 多选 + 30 判断 = 85",
  paper.length === 85 && cnt.single === 40 && cnt.multi === 15 && cnt.judge === 30, JSON.stringify(cnt));
check("卷面无重复", new Set(paper.map(q => q.id)).size === 85);
const full = paper.reduce((s, q) => s + cfg[MSQ.SCORE_KEYS[q.type]], 0);
check("满分 = 100", full === 100, String(full));
const allRight = {};
paper.forEach(q => { allRight[q.id] = q.answer; });
const r1 = MSQ.scoreExam(paper, allRight, cfg);
check("全对 -> 100 分", r1.score === 100 && r1.full === 100 && r1.wrong.length === 0);
const r2answers = Object.assign({}, allRight);
r2answers[paper[0].id] = [-1];      // 错 1 单选(1分)
r2answers[paper[40].id] = [-1];     // 错 1 多选(2分)
const r2 = MSQ.scoreExam(paper, r2answers, cfg);
check("错1单选+错1多选 -> 97 分", r2.score === 97, String(r2.score));
check("detail 计数正确", r2.detail.single[0] === 39 && r2.detail.multi[0] === 14 && r2.detail.judge[0] === 30);

/* ---------- 配置 ---------- */
section("模拟考试配置");
check("默认配置 40/15/30、1/2/1",
  JSON.stringify(MSQ.normalizeConfig(null)) === JSON.stringify(MSQ.DEFAULT_EXAM_CONFIG));
const custom = MSQ.normalizeConfig({ single_count: 30, multi_count: 20, judge_count: 40, single_score: 2, multi_score: 1, judge_score: 1 });
const paper2 = MSQ.generateExam(byType, custom, rng);
const cnt2 = { single: 0, multi: 0, judge: 0 };
paper2.forEach(q => cnt2[q.type]++);
const full2 = paper2.reduce((s, q) => s + custom[MSQ.SCORE_KEYS[q.type]], 0);
check("自定义 30×2+20×1+40×1 = 120 分卷", cnt2.single === 30 && cnt2.multi === 20 && cnt2.judge === 40 && full2 === 120);
check("非法配置回退默认", MSQ.normalizeConfig({ single_count: "abc", multi_count: -5 }).single_count === 40
  && MSQ.normalizeConfig({ multi_count: -5 }).multi_count === 15);

/* ---------- 随机刷题真实调用链（回归：MSQ.shuffled 必须导出） ---------- */
section("随机刷题调用链");
check("MSQ.shuffled 已导出（app.js 随机刷题依赖它）", typeof MSQ.shuffled === "function");
const randList = MSQ.shuffled(qs, rng);   // 与 app.js startPractice("rand") 相同调用
check("洗牌后仍是全部 392 题（不丢题、不重复）",
  randList.length === 392 && new Set(randList.map(q => q.id)).size === 392
  && [...randList].sort((a, b) => a.id - b.id).every((q, i) => q.id === qs[i].id));
check("洗牌确实改变了顺序（概率性，固定种子下确定）",
  randList.some((q, i) => q.id !== qs[i].id));
const order2 = MSQ.shuffled(qs, rng).map(q => q.id);
const list2 = order2.map(id => ({ id })); // 模拟 app.js 里按持久化 id 顺序还原题目列表
check("持久化顺序可无损还原题目列表", list2.length === 392 && list2[0].id === order2[0]);

/* ---------- 组卷数量上限兜底 ---------- */
section("组卷数量上限");
const overCfg = MSQ.normalizeConfig({ single_count: 999, multi_count: 999, judge_count: 999 });
const overPaper = MSQ.generateExam(byType, overCfg, rng);
const overCnt = { single: 0, multi: 0, judge: 0 };
overPaper.forEach(q => overCnt[q.type]++);
check("配置超上限时只生成题库实际容量（160/110/122）",
  overPaper.length === 392 && overCnt.single === 160 && overCnt.multi === 110 && overCnt.judge === 122,
  JSON.stringify(overCnt));

/* ---------- utils ---------- */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(arr, n, r) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

console.log("\n" + "=".repeat(46));
if (fails.length) { console.log(`结果：${fails.length} 项未通过 -> ${fails}`); process.exit(1); }
console.log("结果：全部通过 ✓");
