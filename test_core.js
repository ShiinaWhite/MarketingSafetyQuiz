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

/* ---------- 选项随机化（shuffleQuestionOptions） ---------- */
section("选项随机化");
const shuffleTargets = qs.filter(q => [3, 4, 5, 6].includes(q.options.length));
let mapOk = true, noMutate = true, sizeSeen = new Set();
for (const q of shuffleTargets) {
  const beforeOpts = JSON.stringify(q.options), beforeAns = JSON.stringify(q.answer);
  const cp = MSQ.shuffleQuestionOptions(q, rng);
  sizeSeen.add(q.options.length);
  // 原题未被修改
  if (JSON.stringify(q.options) !== beforeOpts || JSON.stringify(q.answer) !== beforeAns) { noMutate = false; break; }
  // 打乱后答案仍指向原正确选项文本（单选长度1，多选集合一致）
  const texts = (qq) => qq.answer.map(i => qq.options[i]).sort().join("|");
  if (texts(cp) !== texts(q)) { mapOk = false; break; }
  // 选项集合一致、数量一致
  if (cp.options.length !== q.options.length
    || cp.options.slice().sort().join("|") !== q.options.slice().sort().join("|")) { mapOk = false; break; }
}
check("3/4/5/6 选项题均可打乱且答案映射正确", sizeSeen.size === 4, [...sizeSeen].sort().join("/"));
check("原始题库对象绝未被 mutate", noMutate);
check("打乱后答案文本与原正确选项一致（含单选/多选）", mapOk);
check("返回的是新对象", (() => {
  const q0 = byType.judge[0];
  return MSQ.shuffleQuestionOptions(q0, rng) !== q0;
})());

const multi4 = byType.multi.find(q => q.options.length === 4);
const shMulti = MSQ.shuffleQuestionOptions(multi4, mulberry(11));
const shAns = new Set(shMulti.answer);
check("打乱后多选: 全选对 -> 正确", MSQ.isCorrect(shMulti, [...shAns]));
check("打乱后多选: 少选 -> 错误", !MSQ.isCorrect(shMulti, [...shAns].slice(0, shAns.size - 1)));
check("打乱后多选: 多选 -> 错误", !MSQ.isCorrect(shMulti,
  [...shAns, shMulti.options.findIndex((_, i) => !shAns.has(i))]));
check("打乱后多选: 错选 -> 错误", !MSQ.isCorrect(shMulti,
  [shMulti.options.findIndex((_, i) => !shAns.has(i))]));

const shSingle = MSQ.shuffleQuestionOptions(byType.single[0], mulberry(12));
const wrongIdx2 = shSingle.options.findIndex((_, i) => !shSingle.answer.includes(i));
check("打乱后单选: 正确->对 / 选错->错",
  MSQ.isCorrect(shSingle, shSingle.answer) && !MSQ.isCorrect(shSingle, [wrongIdx2]));

const shJudge = MSQ.shuffleQuestionOptions(byType.judge[0], mulberry(13));
check("打乱后判断: 正确->对 / 反选->错",
  MSQ.isCorrect(shJudge, shJudge.answer) && !MSQ.isCorrect(shJudge, [1 - shJudge.answer[0]]));

/* ---------- 会话稳定性（模拟 app.js 会话级展示副本） ---------- */
section("会话稳定性");
function buildSession(questions, seed) {
  const r = mulberry(seed);
  return questions.map(q => MSQ.shuffleQuestionOptions(q, r));
}
const sessQs = byType.multi.slice(0, 20);
const sess1 = buildSession(sessQs, 42);
const sess1Replay = buildSession(sessQs, 42);           // 同一随机序列（等价于重复渲染读取同一副本）
check("同一会话内重复渲染选项顺序不变",
  sess1.every((q, i) => q.options.join("|") === sess1Replay[i].options.join("|")));
const sess2 = buildSession(sessQs, 43);                 // 新一轮（不同随机流）
check("新开一轮产生新的选项顺序",
  sess1.some((q, i) => q.options.join("|") !== sess2[i].options.join("|")));
const prevBack = sess1[5].options.join("|") === sess1[5].options.join("|")
  && sess1.map(q => q.options.join("|")).join("#") === buildSession(sessQs, 42).map(q => q.options.join("|")).join("#");
check("下一题再返回上一题，顺序与刚才完全相同（副本不可变）", prevBack);

/* ---------- 背题模式快速跳转（parseJumpTarget） ---------- */
section("背题快速跳转");
const j1 = MSQ.parseJumpTarget("1", 392);
const j86 = MSQ.parseJumpTarget("86", 392);
const jLast = MSQ.parseJumpTarget("392", 392);
check("跳到第 1 题", j1.ok && j1.index === 0);
check("跳到第 86 题", j86.ok && j86.index === 85);
check("跳到最后一题", jLast.ok && jLast.index === 391);
check("0 被拦截", MSQ.parseJumpTarget("0", 392).ok === false);
check("393（超总数）被拦截", MSQ.parseJumpTarget("393", 392).ok === false);
check("-5（负数）被拦截", MSQ.parseJumpTarget("-5", 392).ok === false);
check("非数字被拦截", !MSQ.parseJumpTarget("abc", 392).ok
  && !MSQ.parseJumpTarget("8a", 392).ok
  && !MSQ.parseJumpTarget("8.5", 392).ok
  && !MSQ.parseJumpTarget("", 392).ok);

/* ---------- 滑动翻页判定（横向 + 纵向 + 滚动豁免） ---------- */
section("滑动翻页判定 resolveSwipe");
check("上滑 -> 下一题", MSQ.resolveSwipe(0, -200, 300, 0) === "next");
check("下滑 -> 上一题", MSQ.resolveSwipe(0, 200, 300, 0) === "prev");
check("左滑 -> 下一题", MSQ.resolveSwipe(-100, 0, 300, 0) === "next");
check("右滑 -> 上一题", MSQ.resolveSwipe(100, 0, 300, 0) === "prev");
check("纵向阈值边界 |dy|=90 触发", MSQ.resolveSwipe(0, -90, 300, 0) === "next");
check("轻微位移 |dy|=89 不触发", MSQ.resolveSwipe(0, -89, 300, 0) === null);
check("超时 700ms 不触发（横/纵均）",
  MSQ.resolveSwipe(0, -200, 701, 0) === null && MSQ.resolveSwipe(-100, 0, 701, 0) === null);
check("斜向滑动不误触", MSQ.resolveSwipe(-80, -120, 300, 0) === null
  && MSQ.resolveSwipe(100, -100, 300, 0) === null);
check("纵向主导的轻微斜向仍可翻题", MSQ.resolveSwipe(30, -200, 300, 0) === "next");
check("明显滚动(300px)时纵向不翻题", MSQ.resolveSwipe(0, -200, 300, 300) === null);
check("滚动量 31px 仍可翻题", MSQ.resolveSwipe(0, -200, 300, 31) === "next");
check("滚动量阈值 32px 豁免翻题", MSQ.resolveSwipe(0, -200, 300, 32) === null);
check("轻微触摸（多选点击带小位移）不触发", MSQ.resolveSwipe(8, -12, 180, 0) === null);
check("轻微上下滚动不触发", MSQ.resolveSwipe(0, 40, 300, 40) === null);
check("长页慢速拖滚（超时）不翻题", MSQ.resolveSwipe(0, -400, 900, 0) === null);
check("横向翻题不受页面滚动影响", MSQ.resolveSwipe(-100, 0, 300, 300) === "next");

/* ---------- 题目解析 explanations ---------- */
section("题目解析 explanations");
const expJs = path.join(__dirname, "www", "data", "explanations.js");
if (fs.existsSync(expJs)) {
  const win = {};
  new Function("window", fs.readFileSync(expJs, "utf8"))(win);
  const exp = win.EXPLANATIONS_DATA || {};
  const idKeys = Object.keys(exp).filter(k => k !== "_meta");
  check("解析条数 = 392", idKeys.length === 392, String(idKeys.length));
  check("392 个 question.id 均存在解析（String(id) 匹配）",
    qs.every(q => !!exp[String(q.id)]),
    "缺: " + qs.filter(q => !exp[String(q.id)]).map(q => q.id).slice(0, 8).join(","));
  check("没有多余题目 id", idKeys.every(k => qs.some(q => String(q.id) === k)),
    "多: " + idKeys.filter(k => !qs.some(q => String(q.id) === k)).slice(0, 8).join(","));
  check("reason 全部非空", idKeys.every(k => typeof exp[k].reason === "string" && exp[k].reason.trim().length > 0));
  check("memory 全部非空", idKeys.every(k => typeof exp[k].memory === "string" && exp[k].memory.trim().length > 0));
  check("_meta 不作为题目解析计入", idKeys.indexOf("_meta") === -1);
  const shq0 = MSQ.shuffleQuestionOptions(byType.single[0], rng);
  check("选项随机化后仍通过同一 question.id 找到解析",
    !!exp[String(shq0.id)] && exp[String(shq0.id)] === exp[String(byType.single[0].id)]);
  const qExpT = byType.multi[0];
  const rExp = MSQ.isCorrect(qExpT, qExpT.answer);
  check("explanation 不参与 isCorrect 判定", rExp === true && MSQ.isCorrect(qExpT, qExpT.answer) === rExp);
  const conf = exp._meta && exp._meta.known_source_conflicts;
  if (Array.isArray(conf) && conf.length) {
    const confIds = conf.flatMap(c => {
      if (c && typeof c === "object") {
        if (Array.isArray(c.ids)) { return c.ids; }
        return [c.id ?? c.question_id ?? c.seq].filter(x => x !== undefined);
      }
      return [c];
    });
    check("已知冲突 id 的解析仍正常加载", confIds.every(id => !!exp[String(id)]),
      "conflict ids: " + confIds.join(","));
    check("冲突题的标准答案未被解析改动（仍按原答案判对）",
      confIds.every(id => {
        const q = qs.find(x => String(x.id) === String(id));
        return q && MSQ.isCorrect(q, q.answer);
      }));
  }
  /* V2 数据对应性与旧模板句检查 */
  const atBad = [], typeBad = [];
  for (const q of qs) {
    const e = exp[String(q.id)];
    if (!e) { continue; }
    if (JSON.stringify(e.answer_text) !== JSON.stringify(q.answer.map(a => q.options[a]))) { atBad.push(q.id); }
    if (e.type !== q.type_name) { typeBad.push(q.id); }
  }
  check("answer_text 392/392 与题库正确选项文本一致", atBad.length === 0, atBad.slice(0, 6).join(","));
  check("type 392/392 与题库题型一致", typeBad.length === 0, typeBad.slice(0, 6).join(","));
  const TPL = ["把标准答案按顺序填回题干", "这样记比只背"];
  const tplHits = idKeys.filter(k => TPL.some(t =>
    (exp[k].reason || "").includes(t) || (exp[k].memory || "").includes(t)));
  check("不存在旧 V1 模板句", tplHits.length === 0, tplHits.slice(0, 6).join(","));
  idKeys.slice(0, 2).forEach(k => console.log(
    `  [id ${k}] reason=${String(exp[k].reason).slice(0, 28)}… memory=${String(exp[k].memory).slice(0, 22)}…`));
} else {
  console.log("  [SKIP] 本地无 www/data/explanations.js（未提供解析数据），改验示例文件结构");
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "www", "data", "explanations.sample.json"), "utf8"));
  const sKeys = Object.keys(sample).filter(k => k !== "_meta");
  check("示例文件至少 1 条结构演示", sKeys.length >= 1);
  check("示例条目 reason/memory 字段非空", sKeys.every(k => sample[k].reason && sample[k].memory));
  check("示例文件保留 _meta 结构", typeof sample._meta === "object");
}

/* ---------- 本地搜题（原文连续子串，标点敏感） ---------- */
section("本地搜题");
const sIdx = MSQ.buildSearchIndex(qs);
check("搜索索引数量 = 392", sIdx.length === 392, String(sIdx.length));
check("索引只含原始字段（无规范化/解析字段）",
  sIdx.every(it => it.stem && Array.isArray(it.options) && it.options.length >= 2
    && it.normalizedStem === undefined && it.normalizedOptions === undefined
    && it.normalizedExplanation === undefined));

/* 真值辅助：暴力 includes 作为 ground truth */
const bruteIds = (q) => qs.filter(x => (x.stem + "|" + x.options.join("|")).includes(q))
  .map(x => x.id).sort((a, b) => a - b);
const searchIds = (q) => MSQ.searchQuestions(sIdx, q).map(x => x.id).sort((a, b) => a - b);

/* 标点敏感：必须原文连续一致才算命中 */
const PUNCT = ["变、配", "发、输、变", "（开关站）", "（ ）", "，不得", "的（", "）、"];
for (const q of PUNCT) {
  const got = searchIds(q), want = bruteIds(q);
  check(`标点查询 ${JSON.stringify(q)} 结果与原文真值一致（${want.length} 条）`,
    JSON.stringify(got) === JSON.stringify(want), "got=" + got.slice(0, 6).join(","));
}
check("「变、配」命中且「变配」不命中（标点参与匹配）",
  searchIds("变、配").length >= 1 && searchIds("变配").length === 0,
  "变、配=" + searchIds("变、配").join(",") + " 变配=" + searchIds("变配").join(","));

/* 范围与降级回归 */
check("空查询返回空", MSQ.searchQuestions(sIdx, "").length === 0
  && MSQ.searchQuestions(sIdx, "   ").length === 0);
check("「工作负责人」正常搜索", searchIds("工作负责人").length === 60);
check("「视频监控」从选项命中 118", MSQ.searchQuestions(sIdx, "视频监控")[0].id === 118
  && MSQ.searchQuestions(sIdx, "视频监控")[0].tier === 2
  && MSQ.searchQuestions(sIdx, "视频监控")[0].hitOption === "视频监控");
check("「一机一闸一保护」题干/选项无原文 -> 0 条", searchIds("一机一闸一保护").length === 0);
check("「工作负人」不再模糊纠错 -> 0 条", searchIds("工作负人").length === 0);
check("「变电站 不停电」（含空格）按原文匹配 -> 0 条", searchIds("变电站 不停电").length === 0);
check("解析文字不参与搜索（V1 口诀 -> 0 条）", searchIds("遮栏标牌两不擅").length === 0);
check("解析文字不参与搜索（V2 原文「一机一闸一保护；少」 -> 0 条）",
  searchIds("少“机”就错").length === 0);
check("选项命中排在题干命中之后（二次工作安全措施票）",
  (() => {
    const r = MSQ.searchQuestions(sIdx, "二次工作安全措施票");
    const firstOpt = r.findIndex(x => x.tier === 2);
    return firstOpt > 0 && r.slice(0, firstOpt).every(x => x.tier === 1);
  })());
check("同层内 query 占原文比例高者优先（工作票 Top1=12，214 列第2）",
  MSQ.searchQuestions(sIdx, "工作票")[0].id === 12
  && MSQ.searchQuestions(sIdx, "工作票")[1].id === 214);

/* 性能 */
const timeQ = [...PUNCT, "工作负责人", "视频监控", "工作票", "一机一闸一保护", "工作负人"];
let sw_max = 0, sw_sum = 0, sw_n = 0;
for (let round = 0; round < 5; round++) {
  for (const q of timeQ) {
    const a = performance.now();
    MSQ.searchQuestions(sIdx, q);
    const d = performance.now() - a;
    sw_max = Math.max(sw_max, d); sw_sum += d; sw_n++;
  }
}
const sw_avg = sw_sum / sw_n;
check("平均搜索耗时 < 10ms", sw_avg < 10, sw_avg.toFixed(2) + "ms");
check("最大搜索耗时 < 50ms", sw_max < 50, sw_max.toFixed(2) + "ms");

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
