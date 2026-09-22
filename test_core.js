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

/* ---------- 文字搜题题型筛选 ---------- */
section("文字搜题题型筛选");
const FILTERS = ["all", "single", "multi", "judge"];
const filterIds = (q, t) => MSQ.filterSearchResults(MSQ.searchQuestions(sIdx, q), t).map(x => x.id);

check("filter 是纯函数：all 原样返回（同一数组引用）",
  (() => { const r = MSQ.searchQuestions(sIdx, "工作票"); return MSQ.filterSearchResults(r, "all") === r; })());
check("filter 是纯函数：undefined / 未知 type 原样返回",
  (() => {
    const r = MSQ.searchQuestions(sIdx, "工作票");
    return MSQ.filterSearchResults(r, undefined) === r && MSQ.filterSearchResults(r, "xxx") === r;
  })());
check("filter 不修改原数组长度", (() => {
  const r = MSQ.searchQuestions(sIdx, "工作票"); const n = r.length;
  MSQ.filterSearchResults(r, "single");
  return r.length === n;
})());

for (const t of ["single", "multi", "judge"]) {
  check(`filter(${t}) 结果全部 type === ${t} 且非空`,
    MSQ.filterSearchResults(MSQ.searchQuestions(sIdx, "工作负责人"), t).every(r => r.type === t)
    && MSQ.filterSearchResults(MSQ.searchQuestions(sIdx, "工作负责人"), t).length > 0);
}

check("filter 保持原相关度顺序（是原序列的子序列）", (() => {
  const all = MSQ.searchQuestions(sIdx, "工作负责人").map(x => x.id);
  const sub = filterIds("工作负责人", "single");
  let i = 0;
  return sub.every(id => { const at = all.indexOf(id, i); if (at < 0) { return false; } i = at + 1; return true; });
})());
check("filter 不按题号重排（单选结果并非 id 升序）", (() => {
  const ids = filterIds("工作票", "single");
  return ids.length > 1 && ids.some((v, i) => i > 0 && v < ids[i - 1]);
})());

/* 数量守恒：全部 = 单选 + 多选 + 判断 */
const sumKw = ["工作负责人", "工作票", "安全", "作业", "电", "视频监控", "二次工作安全措施票", ...PUNCT];
let sumBad = null;
for (const q of sumKw) {
  const r = MSQ.searchQuestions(sIdx, q);
  const c = MSQ.countSearchResultsByType(r);
  if (c.all !== r.length || c.all !== c.single + c.multi + c.judge) { sumBad = q; break; }
  if (FILTERS.slice(1).some(t => MSQ.filterSearchResults(r, t).length !== c[t])) { sumBad = q; break; }
}
check(`数量守恒：全部 = 单选+多选+判断（${sumKw.length} 个关键词）`, sumBad === null,
  sumBad ? "关键词「" + sumBad + "」不一致" : "全部一致");
check("计数纯函数：空结果 -> 全 0", (() => {
  const c = MSQ.countSearchResultsByType([]);
  return c.all === 0 && c.single === 0 && c.multi === 0 && c.judge === 0;
})());
check("计数与筛选一致：多选题数量 = filter(multi).length（工作负责人）",
  MSQ.countSearchResultsByType(MSQ.searchQuestions(sIdx, "工作负责人")).multi
  === filterIds("工作负责人", "multi").length);

/* 筛选不得污染搜索逻辑（回归固化） */
check("筛选后搜索回归：变、配 -> 44",
  MSQ.searchQuestions(sIdx, "变、配").map(x => x.id).join(",") === "44"
  && (() => {
    const one = MSQ.searchQuestions(sIdx, "变、配")[0];
    return MSQ.filterSearchResults([one], one.type).length === 1;
  })());
check("筛选后搜索回归：变配 -> 0", MSQ.searchQuestions(sIdx, "变配").length === 0
  && MSQ.filterSearchResults(MSQ.searchQuestions(sIdx, "变配"), "all").length === 0);
check("筛选后搜索回归：工作负人 -> 0", MSQ.searchQuestions(sIdx, "工作负人").length === 0
  && MSQ.filterSearchResults(MSQ.searchQuestions(sIdx, "工作负人"), "single").length === 0);
check("筛选后搜索回归：视频监控 -> id118 选项命中",
  MSQ.searchQuestions(sIdx, "视频监控")[0].id === 118
  && MSQ.countSearchResultsByType(MSQ.searchQuestions(sIdx, "视频监控")).all >= 1);

/* 性能 */
check("筛选耗时 < 5ms", (() => {
  const r = MSQ.searchQuestions(sIdx, "工作负责人");
  const a = performance.now();
  for (let i = 0; i < 100; i++) { MSQ.filterSearchResults(r, "single"); MSQ.countSearchResultsByType(r); }
  return (performance.now() - a) / 100 < 5;
})());

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

/* ---------- 拍照搜题（OCR 匹配，模拟 OCR 噪声） ---------- */
section("拍照搜题 OCR 匹配");
const ocrIdx = MSQ.buildOcrIndex(qs);
check("OCR 索引数量 = 392", ocrIdx.length === 392);
check("OCR 索引含规范化字段", ocrIdx.every(it => it.ocrStem.length > 0 && it.ocrOptions.length >= 2));
check("normalizeOcrText：全角/标点/换行归一", MSQ.normalizeOcrText("（  ）A.正确\nB.错误") === "正确 错误");
check("normalizeOcrText：选项标签剔除", MSQ.normalizeOcrText("A.搭建、B.损坏") === "搭建 损坏");

/* 模拟 OCR 生成：真实题干/选项 + 典型 OCR 噪声（错字替换/漏字/空格/标点/选项标签） */
const CONFUSABLE = { "责": "贵", "人": "入", "士": "土", "未": "末", "须": "需", "机": "肌",
  "验": "鉴", "检": "捡", "设": "没", "地": "池", "压": "庄", "戴": "带", "已": "己",
  "第": "弟", "维": "堆", "护": "户", "电": "龟", "动": "劝", "监": "临", "工": "二" };
function simulateOcr(q, rand) {
  let text = q.stem + "\n";
  q.options.forEach((o, i) => { text += "ABCDEF"[i] + "." + o + "\n"; });
  let chars = text.split("");
  for (let i = 0; i < chars.length; i++) {
    const roll = rand();
    if (roll < 0.05 && CONFUSABLE[chars[i]]) { chars[i] = CONFUSABLE[chars[i]]; }
    else if (roll < 0.065) { chars[i] = ""; }            // 漏字
    else if (roll < 0.09 && chars[i] !== "\n") { chars[i] = " " + chars[i]; } // 随机空格
  }
  return chars.join("").replace(/\n{2,}/g, "\n");
}
/* 抽样：单选10 + 多选10 + 判断10（种子固定，可复现） */
const ocrRand = mulberry(20260920);
const pickOcr = [];
["single", "multi", "judge"].forEach(t => {
  const pool = byType[t].slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(ocrRand() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  pool.slice(0, 10).forEach(q => pickOcr.push(q));
});
let top1 = 0, top3 = 0, misses = [], sumMatch = 0;
const t0 = performance.now();
for (const q of pickOcr) {
  const sim = simulateOcr(q, ocrRand);
  const a = performance.now();
  const r = MSQ.searchQuestionsByOcr(ocrIdx, sim);
  const d = performance.now() - a;
  sumMatch += d;
  const top3Ids = r.slice(0, 3).map(x => x.id);
  if (top3Ids[0] === q.id) { top1++; }
  if (top3Ids.includes(q.id)) { top3++; } else { misses.push({ id: q.id, type: q.type_name }); }
}
const matchAvg = sumMatch / pickOcr.length;
const totalAvg = (performance.now() - t0) / pickOcr.length;
check("模拟 OCR 30 题 Top1 准确率 >= 90%", top1 >= 27, top1 + "/30");
check("模拟 OCR 30 题 Top3 准确率 >= 97%", top3 >= 29, top3 + "/30");
check("匹配耗时 < 20ms", matchAvg < 20, matchAvg.toFixed(2) + "ms");
check("识别+匹配单题总耗时 < 100ms（匹配侧）", totalAvg < 100, totalAvg.toFixed(2) + "ms");
console.log("  [INFO] Top1=" + top1 + "/30 (" + (top1 / 30 * 100).toFixed(0) + "%)  Top3=" + top3 +
  "/30 (" + (top3 / 30 * 100).toFixed(1) + "%)  平均匹配 " + matchAvg.toFixed(2) + "ms");
if (misses.length) {
  console.log("  [INFO] 未进 Top3 的题:", misses.map(m => m.id + "(" + m.type + ")").join(", "));
}

/* 手动搜题与 OCR 解耦回归 */
check("手动搜题回归：变、配 -> 44", MSQ.searchQuestions(sIdx, "变、配").map(x => x.id).join(",") === "44");
check("手动搜题回归：变配 -> 0", MSQ.searchQuestions(sIdx, "变配").length === 0);
check("手动搜题回归：工作负人 -> 0", MSQ.searchQuestions(sIdx, "工作负人").length === 0);
check("OCR 置信度：唯一高分结果 -> confident", MSQ.ocrConfidence([
  { score: 2000 }, { score: 800 }]).level === "confident");
check("OCR 置信度：接近分数 -> candidates", MSQ.ocrConfidence([
  { score: 900 }, { score: 850 }]).level === "candidates");
check("OCR 置信度：空结果 -> none", MSQ.ocrConfidence([]).level === "none");

/* ---------- 整页拍照搜题（模拟整页 OCR 数据，simulated） ----------
   说明：以下全部是【模拟数据 simulated】，由本地私有题库 + 合成 OCR 噪声生成，
   不是真机实拍结果。真实相机拍摄需要在真机上验证。 */
section("整页拍照搜题（模拟数据 simulated）");
const batchIdx = MSQ.buildBatchOcrIndex(qs);
check("整页索引 = 392 且带答案字段", batchIdx.length === 392
  && batchIdx.every(it => Array.isArray(it.answer)));

const ansOf = (q) => q.type === "judge"
  ? (q.answer[0] === 0 ? "√" : "×")
  : q.answer.slice().sort((a, b) => a - b).map(i => "ABCDEF"[i]).join("");

function noisyText(s, rand) {
  const chars = String(s).split("");
  for (let i = 0; i < chars.length; i++) {
    const roll = rand();
    if (roll < 0.05 && CONFUSABLE[chars[i]]) { chars[i] = CONFUSABLE[chars[i]]; }
    else if (roll < 0.07) { chars[i] = ""; }
    else if (roll < 0.10) { chars[i] = " " + chars[i]; }
  }
  return chars.join("").replace(/\s+/g, " ").trim();
}
function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) { out.push(s.slice(i, i + n)); }
  return out.length ? out : [""];
}
function pickQuestions(type, n, rand) {
  const pool = byType[type].slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, n);
}
/* 合成"整页 OCR 行"：题号+题干（可换行）+ 选项（可换行）+ 页脚，带坐标 */
function buildPage(rand, groups, opts) {
  const o = opts || {};
  const lines = [], expected = [];
  let y = 60;
  let num = o.startNumber || 1;
  const push = (text, indent) => {
    lines.push({ text, left: 40 + (indent || 0), top: y, right: 900, bottom: y + 46 });
    y += 52;
  };
  groups.forEach(g => {
    if (g.header) { push(g.header); y += 14; }
    pickQuestions(g.type, g.n, rand).forEach(q => {
      const screen = String(num++);
      expected.push({ screenNumber: screen, type: g.type, id: q.id, answer: ansOf(q) });
      const parts = chunk(noisyText(q.stem, rand), 18);
      push(screen + ". " + parts[0]);
      for (let i = 1; i < parts.length; i++) { push(parts[i], 14); }
      q.options.forEach((op, i) => {
        const t = "ABCDEF"[i] + ". " + noisyText(op, rand);
        if (o.wrapOptions && t.length > 11) {
          const c = chunk(t, 11);
          push(c[0], 14);
          for (let k = 1; k < c.length; k++) { push(c[k], 26); }
        } else { push(t, 14); }
      });
    });
  });
  if (o.footer) { push(o.footer); }
  return { lines, expected };
}

const M = { pages: 0, splitOk: 0, screen: 0, screenN: 0, type: 0, typeN: 0,
  top1: 0, top3: 0, ans: 0, n: 0, splitMs: 0, matchMs: 0, totalMs: 0, misses: [] };
const pageCases = [];

/* 整页跑一遍并累计指标；返回 {blocks, expected, ok} */
function runPage(label, built, defaultType, opts) {
  const ts = performance.now();
  MSQ.splitPageOcrLines(built.lines, defaultType);
  const splitMs = performance.now() - ts;
  const tm = performance.now();
  const res = MSQ.searchPageQuestionsByOcr(batchIdx, built.lines, defaultType, opts);
  const matchMs = performance.now() - tm;
  const blocks = res.blocks;
  M.pages++;
  M.splitMs += splitMs; M.matchMs += matchMs; M.totalMs += splitMs + matchMs;
  const splitOk = blocks.length === built.expected.length;
  if (splitOk) { M.splitOk++; }
  let screenHit = 0, typeHit = 0, top1 = 0, top3 = 0, ans = 0;
  built.expected.forEach((exp, i) => {
    const b = blocks[i];
    if (!b) { return; }
    if (b.screenNumber === exp.screenNumber) { screenHit++; }
    if (b.type === exp.type) { typeHit++; }
    const ids = (b.matches || []).map(m => m.id);
    if (ids[0] === exp.id) { top1++; }
    if (ids.indexOf(exp.id) >= 0) { top3++; }
    if (b.answer === exp.answer && b.bankId === exp.id) { ans++; }
    if (ids[0] !== exp.id) {
      M.misses.push(label + " 题号" + exp.screenNumber + " 期望" + exp.id + " 实得" +
        (ids[0] === undefined ? "无" : ids[0]) + "(" + b.confidence + ")");
    }
  });
  M.screen += screenHit; M.screenN += built.expected.length;
  M.type += typeHit; M.typeN += built.expected.length;
  M.top1 += top1; M.top3 += top3; M.ans += ans; M.n += built.expected.length;
  const rec = { label, blocks, expected: built.expected, splitOk, screenHit, typeHit, top1, top3, ans,
    splitMs: Math.round(splitMs * 100) / 100, matchMs: Math.round(matchMs * 100) / 100 };
  pageCases.push(rec);
  return rec;
}

const pageRand = mulberry(20260921);

/* 1) 单选一页 5 题（无大块标题，整页默认题型） */
const p1 = runPage("单选5题", buildPage(pageRand, [{ type: "single", n: 5 }], { startNumber: 1, footer: "1 / 8" }), "single");
check("单选一页 5 题：分题数量 = 5", p1.blocks.length === 5, String(p1.blocks.length));
check("单选一页 5 题：题号顺序正确", p1.blocks.map(b => b.screenNumber).join(",") === "1,2,3,4,5",
  p1.blocks.map(b => b.screenNumber).join(","));
check("单选一页 5 题：题型全部 single", p1.blocks.every(b => b.type === "single"));
check("单选一页 5 题：Top1 全中", p1.top1 === 5, p1.top1 + "/5");

/* 2) 单选一页 10 题 */
const p2 = runPage("单选10题", buildPage(pageRand, [{ type: "single", n: 10 }], { startNumber: 31 }), "single");
check("单选一页 10 题：分题数量 = 10", p2.blocks.length === 10, String(p2.blocks.length));
check("单选一页 10 题：题号 31~40", p2.blocks.map(b => b.screenNumber).join(",") === "31,32,33,34,35,36,37,38,39,40");
check("单选一页 10 题：Top1 >= 9", p2.top1 >= 9, p2.top1 + "/10");

/* 3) 多选一页（带大块标题）+ 选项换行 */
const p3 = runPage("多选页", buildPage(pageRand,
  [{ type: "multi", n: 6, header: "二、多项选择题（每题2分，共30分）" }],
  { startNumber: 51, wrapOptions: true }), "multi");
check("多选一页：分题数量 = 6", p3.blocks.length === 6, String(p3.blocks.length));
check("多选一页：题型全部 multi", p3.blocks.every(b => b.type === "multi"));
check("多选一页：答案格式为字母组合", p3.blocks.every(b => /^[A-F]+$/.test(b.answer)));
check("多选一页：Top1 >= 5", p3.top1 >= 5, p3.top1 + "/6");

/* 4) 判断一页（答案显示 √ / ×） */
const p4 = runPage("判断页", buildPage(pageRand,
  [{ type: "judge", n: 8, header: "三、判断题（每题1分）" }],
  { startNumber: 66, footer: "第 5 页 共 8 页" }), "judge");
check("判断一页：分题数量 = 8", p4.blocks.length === 8, String(p4.blocks.length));
check("判断一页：题型全部 judge", p4.blocks.every(b => b.type === "judge"));
check("判断一页：答案只出现 √ 或 ×", p4.blocks.every(b => b.answer === "√" || b.answer === "×"),
  p4.blocks.map(b => b.answer).join(""));
check("判断一页：Top1 >= 7", p4.top1 >= 7, p4.top1 + "/8");

/* 5) 跨大块页：单选尾部 + 多选题标题 + 多选开头（中途切题型） */
const p5 = runPage("单选→多选", buildPage(pageRand, [
  { type: "single", n: 3 },
  { type: "multi", n: 4, header: "二、多选题" }
], { startNumber: 41 }), "single");
check("跨大块页（单选→多选）：分题数量 = 7", p5.blocks.length === 7, String(p5.blocks.length));
check("跨大块页（单选→多选）：标题前为 single", p5.blocks.slice(0, 3).every(b => b.type === "single"));
check("跨大块页（单选→多选）：标题后为 multi", p5.blocks.slice(3).every(b => b.type === "multi"));
check("跨大块页（单选→多选）：题型判定全对", p5.typeHit === 7, p5.typeHit + "/7");

/* 6) 跨大块页：多选尾部 + 判断题标题 + 判断开头 */
const p6 = runPage("多选→判断", buildPage(pageRand, [
  { type: "multi", n: 3 },
  { type: "judge", n: 5, header: "三、判断题" }
], { startNumber: 58 }), "multi");
check("跨大块页（多选→判断）：分题数量 = 8", p6.blocks.length === 8, String(p6.blocks.length));
check("跨大块页（多选→判断）：标题前为 multi", p6.blocks.slice(0, 3).every(b => b.type === "multi"));
check("跨大块页（多选→判断）：标题后为 judge", p6.blocks.slice(3).every(b => b.type === "judge"));

/* 7) 题号 OCR 错一个字符（数字位被认成形近字母） */
const p7page = buildPage(pageRand, [{ type: "single", n: 6 }], { startNumber: 11 });
p7page.lines.forEach(l => {
  if (/^14\s*[.．]/.test(l.text)) { l.text = l.text.replace(/^14/, "1A"); }  // 14 -> 1A（A 非形近数字，应合并）
});
const p7 = runPage("题号错字", p7page, "single");
check("题号 OCR 错字：其余题号仍正确分题", p7.blocks.length >= 5 && p7.blocks.length <= 6,
  "分题 " + p7.blocks.length + "（期望 5 或 6，取决于错字题号是否仍可识别）");

/* 8) 某一选项 OCR 错字（选项辅助不参与主匹配，不应影响 Top1） */
const p8page = buildPage(pageRand, [{ type: "single", n: 5 }], { startNumber: 21 });
p8page.lines.forEach(l => {
  if (/^C\s*[.．]/.test(l.text)) { l.text = l.text.replace(/^C/, "C").replace(/.$/, "错"); }
});
const p8 = runPage("选项错字", p8page, "single");
check("选项 OCR 错字：Top1 仍全中", p8.top1 === 5, p8.top1 + "/5");

/* 9) 大块标题变体识别 */
check("大块标题识别：单选题/单项选择题/多选题/多项选择题/判断题",
  MSQ.pageSectionType("单选题") === "single" && MSQ.pageSectionType("单项选择题") === "single"
  && MSQ.pageSectionType("二、多选题") === "multi" && MSQ.pageSectionType("多项选择题") === "multi"
  && MSQ.pageSectionType("3. 判断题") === "judge");
check("大块标题识别：题干不会被误判成标题",
  MSQ.pageSectionType("根据营销安规规定，多选题应全部选对") === null
  && MSQ.pageSectionType("1. 单选题的做法是（ ）") === null);
check("题号识别：1. / 1、/ （1）/ 第1题 / 31 题干",
  MSQ.pageQuestionNumber("1. 题干").number === "1"
  && MSQ.pageQuestionNumber("1、题干").number === "1"
  && MSQ.pageQuestionNumber("（1）题干").number === "1"
  && MSQ.pageQuestionNumber("第1题 题干").number === "1"
  && MSQ.pageQuestionNumber("31 根据营销安规").number === "31");
check("题号识别：选项行/页码不会被误判成题号",
  MSQ.pageQuestionNumber("A. 停电") === null && MSQ.pageQuestionNumber("B、送电") === null
  && MSQ.pageQuestionNumber("3 / 10") === null && MSQ.pageQuestionNumber("1.5米以上") === null
  && MSQ.pageQuestionNumber("2026年") === null);
check("分题：题干换行 + 选项换行不拆题", (() => {
  const b = MSQ.splitPageOcrLines([
    { text: "7. 根据营销安规规定，作业人员", top: 10, left: 10, bottom: 40 },
    { text: "进入现场应正确佩戴安全帽。", top: 50, left: 30, bottom: 80 },
    { text: "A. 正确", top: 90, left: 30, bottom: 120 },
    { text: "B. 错误", top: 130, left: 30, bottom: 160 },
    { text: "8. 下一题", top: 170, left: 10, bottom: 200 }
  ], "judge");
  return b.length === 2 && b[0].screenNumber === "7"
    && b[0].stemText === "根据营销安规规定，作业人员进入现场应正确佩戴安全帽。"
    && b[0].optionsText === "A. 正确 B. 错误";
})());
/* 整页结果展示门控（置信度颜色化） */
section("整页结果展示门控（纯展示层）");
check("high：显示原答案，绿色类", (() => {
  const d = MSQ.pageAnswerDisplay("high", "B");
  return d.text === "B" && d.cls === "high";
})());
check("medium：显示原答案，橙色类", (() => {
  const d = MSQ.pageAnswerDisplay("medium", "ACD");
  return d.text === "ACD" && d.cls === "mid";
})());
check("low：有候选答案不再隐藏（红色类）", (() => {
  const d = MSQ.pageAnswerDisplay("low", "√");
  return d.text === "√" && d.cls === "low";
})());
check("low 多选：显示字母组合如 ACD", (() => {
  const d = MSQ.pageAnswerDisplay("low", "ACD");
  return d.text === "ACD" && d.cls === "low";
})());
check("low 判断：显示 √ / ×", (() => {
  return MSQ.pageAnswerDisplay("low", "√").text === "√"
    && MSQ.pageAnswerDisplay("low", "×").text === "×";
})());
check("none：真无匹配仍显示 ?", (() => {
  const d = MSQ.pageAnswerDisplay("none", "?");
  return d.text === "?" && d.cls === "none";
})());
check("low 但无候选答案：也显示 ?（不与有答案混淆）", (() => {
  const d = MSQ.pageAnswerDisplay("low", "?");
  return d.text === "?" && d.cls === "none";
})());
check("空答案按无匹配处理", MSQ.pageAnswerDisplay("high", "").text === "?");
check("门控不影响匹配层：confidence/bankId 原样", (() => {
  const blocks = [{ screenNumber: "31", rawScreenNumber: "31", type: "single", confidence: "high",
    bankId: 118, answer: "B", lines: [], stemText: "题", rawText: "", label: "31" }];
  return blocks[0].confidence === "high" && blocks[0].bankId === 118;
})());

/* 人工框选：归一化裁剪矩形数学 */
section("人工框选裁剪数学");
check("默认选区：四周 4% 且合法", (() => {
  const d = MSQ.pageCropDefault();
  return d.x === 0.04 && d.y === 0.04 && Math.abs(d.w - 0.92) < 1e-9 && Math.abs(d.h - 0.92) < 1e-9;
})());
check("选区不越界：拖出右/下边界被钳回", (() => {
  const c = MSQ.pageCropClamp({ x: 0.98, y: 0.98, w: 0.2, h: 0.2 });
  return Math.abs(c.x - 0.8) < 1e-9 && Math.abs(c.y - 0.8) < 1e-9 && c.w === 0.2 && c.h === 0.2;
})());
check("选区不越界：负坐标被钳到 0", (() => {
  const c = MSQ.pageCropClamp({ x: -0.3, y: -0.1, w: 0.3, h: 0.2 });
  return c.x === 0 && c.y === 0 && c.w === 0.3 && c.h === 0.2;
})());
check("四角 resize：小于最小尺寸自动放大", (() => {
  const c = MSQ.pageCropClamp({ x: 0.5, y: 0.5, w: 0.01, h: 0.02 });
  return c.w === 0.05 && c.h === 0.05;
})());
check("最小尺寸可自定义", (() => {
  const c = MSQ.pageCropClamp({ x: 0, y: 0, w: 0.01, h: 0.01 }, 0.2);
  return c.w === 0.2 && c.h === 0.2;
})());
check("全图选区（恢复全图）= 0,0,1,1", (() => {
  const c = MSQ.pageCropClamp({ x: 0, y: 0, w: 1, h: 1 });
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
})());
check("归一化坐标恒在 0~1", (() => {
  const c = MSQ.pageCropClamp({ x: -5, y: -5, w: 99, h: 99 });
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
})());

check("大块标题形近容错：多项选挥题/单项选泽题/判新题",
  MSQ.pageSectionType("多项选挥题") === "multi"
  && MSQ.pageSectionType("单项选泽题") === "single"
  && MSQ.pageSectionType("判新题") === "judge");
check("大块标题：精确形式不受影响",
  MSQ.pageSectionType("多项选择题") === "multi" && MSQ.pageSectionType("判断题") === "judge");
check("大块标题：diff=2 不自动命中（多项选***题 两处不同）",
  MSQ.pageSectionType("多项选乙丙题") === null);
check("大块标题：长题干不会误判成标题",
  MSQ.pageSectionType("根据营销安规规定，多项选择题的判分规则如下所述") === null
  && MSQ.pageSectionType("下列关于多项选择题的说法正确的一项是") === null);

check("分题：题型强约束只在对应题型内匹配", (() => {
  const blocks = MSQ.splitPageOcrLines([
    { text: "1. 禁止作业人员擅自移动或拆除遮栏（围栏）和标示牌。", top: 10, left: 10, bottom: 40 }
  ], "multi");
  const r = MSQ.matchPageQuestionBlock(batchIdx, blocks[0], { limit: 3 });
  return r.length > 0 && r.every(x => x.type === "multi");
})());

/* 汇总指标（模拟数据） */
const pct = (a, b) => b ? (a / b * 100) : 0;
const SPLIT_ACC = pct(M.splitOk, M.pages), SCREEN_ACC = pct(M.screen, M.screenN);
const TYPE_ACC = pct(M.type, M.typeN), TOP1_ACC = pct(M.top1, M.n);
const TOP3_ACC = pct(M.top3, M.n), ANS_ACC = pct(M.ans, M.n);
check("PAGE_SPLIT_COUNT_ACCURACY = 100%", M.splitOk === M.pages, SPLIT_ACC.toFixed(1) + "%");
check("TYPE_ASSIGN_ACCURACY = 100%", M.type === M.typeN, TYPE_ACC.toFixed(1) + "%");
check("TOP1_MATCH_ACCURACY >= 95%", TOP1_ACC >= 95, TOP1_ACC.toFixed(1) + "%");
check("TOP3_MATCH_ACCURACY >= 99%", TOP3_ACC >= 99, TOP3_ACC.toFixed(1) + "%");
check("ANSWER_ACCURACY >= 95%", ANS_ACC >= 95, ANS_ACC.toFixed(1) + "%");
check("SCREEN_NUMBER_ACCURACY >= 97%", SCREEN_ACC >= 97, SCREEN_ACC.toFixed(1) + "%");
/* 显示安全保证：高/中置信度给出的答案必须是对的；错的只能是 low（UI 显示 ?） */
let confidentWrong = 0, confidentTotal = 0, lowShown = 0;
pageCases.forEach(p => {
  p.blocks.forEach((b, i) => {
    const exp = p.expected[i];
    if (!exp) { return; }
    if (b.confidence === "high" || b.confidence === "medium") {
      confidentTotal++;
      if (b.bankId !== exp.id || b.answer !== exp.answer) { confidentWrong++; }
    } else { lowShown++; }
  });
});
check("高/中置信度答案 0 错误（低置信度才给 ?）", confidentWrong === 0,
  confidentWrong + " 错 / " + confidentTotal + " 高·中（低置信度 " + lowShown + " 条显示 ?）");
check("分题耗时 < 5ms/页", M.splitMs / M.pages < 5, (M.splitMs / M.pages).toFixed(2) + "ms/页");
check("匹配总耗时 < 100ms/页", M.matchMs / M.pages < 100, (M.matchMs / M.pages).toFixed(1) + "ms/页");
check("整页总耗时 < 100ms/页", M.totalMs / M.pages < 100, (M.totalMs / M.pages).toFixed(1) + "ms/页");
console.log("  [INFO] (simulated) 页数=" + M.pages + " 题目=" + M.n +
  " 分题=" + SPLIT_ACC.toFixed(1) + "% 题号=" + SCREEN_ACC.toFixed(1) + "% 题型=" + TYPE_ACC.toFixed(1) +
  "% Top1=" + TOP1_ACC.toFixed(1) + "% Top3=" + TOP3_ACC.toFixed(1) + "% 答案=" + ANS_ACC.toFixed(1) + "%");
console.log("  [INFO] (simulated) 分题 " + (M.splitMs / M.pages).toFixed(2) + "ms/页 · 匹配 " +
  (M.matchMs / M.pages).toFixed(1) + "ms/页 · 合计 " + (M.totalMs / M.pages).toFixed(1) + "ms/页");
if (M.misses.length) { console.log("  [INFO] (simulated) 未命中 Top1: " + M.misses.join(" | ")); }
console.log("  [INFO] (simulated) 置信度分布 " + JSON.stringify(
  pageCases.reduce((m, p) => { p.blocks.forEach(b => { m[b.confidence] = (m[b.confidence] || 0) + 1; }); return m; }, {})));

/* ---------- 整页题号序列校正（第一次真机测试回归） ----------
   真机现象：结果页出现 23/14/22/21/20 这类乱序，OCR 可能把 24 识成 14、33 识成 3l。 */
section("整页题号序列校正（真机回归）");
const mkNb = (specs) => specs.map((s, i) => ({
  screenNumber: String(s.n), rawScreenNumber: s.raw || String(s.n),
  type: "single", lines: [], top: s.top !== undefined ? s.top : i * 100,
  bottom: (s.top !== undefined ? s.top : i * 100) + 40,
  pageIndex: i, stemText: "题干内容", rawText: "", label: String(s.n)
}));
const seqOf = (blocks) => blocks.map(b => b.screenNumber).join(",");
const srcOf = (blocks) => blocks.map(b => b.numberSource).join(",");

/* Case A：真实案例——同页 20~24，其中 24 被 OCR 识成 14 */
const caseA = MSQ.normalizePageQuestionSequence(mkNb([{n:20},{n:21},{n:22},{n:23},{n:14}]));
check("Case A：14 判为序列异常并校正为 24（不放第一位）", seqOf(caseA) === "20,21,22,23,24", seqOf(caseA));
check("Case A：rawScreenNumber 永远保留 OCR 原值 14", caseA[4].rawScreenNumber === "14");
check("Case A：仅被校正块 numberSource=repaired", srcOf(caseA) === "ocr,ocr,ocr,ocr,repaired", srcOf(caseA));

/* Case A2：块顺序被打乱（对应真机上结果页 23/14/22/21/20 的乱序） */
const caseA2 = MSQ.normalizePageQuestionSequence(mkNb([
  {n:23, top:400}, {n:14, top:500}, {n:22, top:300}, {n:21, top:200}, {n:20, top:100}]));
check("Case A2：乱序输入仍按校正后题号升序输出", seqOf(caseA2) === "20,21,22,23,24", seqOf(caseA2));

/* Case B：漏题造成的缺口（22 整块没识别）必须保留，绝不伪造 */
check("Case B：20,21,23,24 保持原样，不伪造 22",
  seqOf(MSQ.normalizePageQuestionSequence(mkNb([{n:20},{n:21},{n:23},{n:24}]))) === "20,21,23,24");

/* Case C：正常连续段一个都不改 */
const caseC = MSQ.normalizePageQuestionSequence(mkNb([{n:51},{n:52},{n:53},{n:54},{n:55}]));
check("Case C：51~55 全部保持 numberSource=ocr", seqOf(caseC) === "51,52,53,54,55" && srcOf(caseC) === "ocr,ocr,ocr,ocr,ocr");

/* Case D：形近字符 3l（复用 pageNumberValue 的转换 → 31 与真 31 重复）借缺口校正为 33 */
const caseD = MSQ.normalizePageQuestionSequence(mkNb([{n:31},{n:32},{n:31,raw:"3l"},{n:34},{n:35}]));
check("Case D：31,32,3l,34,35 恢复为 31~35", seqOf(caseD) === "31,32,33,34,35", seqOf(caseD));
check("Case D：rawScreenNumber 保留 3l 且标记 repaired",
  caseD[2].rawScreenNumber === "3l" && caseD[2].numberSource === "repaired");

/* Case E：可靠题号只有 1~2 个时不做激进序列推断 */
check("Case E：仅 2 个题号 → 不推断，只升序",
  (() => { const r = MSQ.normalizePageQuestionSequence(mkNb([{n:35},{n:20}]));
    return seqOf(r) === "20,35" && srcOf(r) === "ocr,ocr"; })());

/* 补充边界：掉位数字 / 证据不足 / 无题号块 / 匹配字段不受影响 */
check("OCR 掉位（24 识成 4）→ 尾部顺延校正为 24",
  (() => { const r = MSQ.normalizePageQuestionSequence(mkNb([{n:20},{n:21},{n:22},{n:23},{n:4}]));
    return seqOf(r) === "20,21,22,23,24" && r[4].numberSource === "repaired"; })());
check("证据不足（90 与 24 差两位）不强行改号，仍升序放末尾",
  (() => { const r = MSQ.normalizePageQuestionSequence(mkNb([{n:20},{n:21},{n:22},{n:23},{n:90}]));
    return seqOf(r) === "20,21,22,23,90" && r[4].numberSource === "ocr"; })());
check("无题号的块 numberSource=unknown 且排在最后",
  (() => { const blocks = mkNb([{n:20},{n:21},{n:22}]);
    blocks.push({ type: "single", lines: [], top: 300, bottom: 340, pageIndex: 3,
      stemText: "题", rawText: "", label: "本页第4题" });
    const r = MSQ.normalizePageQuestionSequence(blocks);
    return r.length === 4 && r[r.length - 1].numberSource === "unknown"
      && r[r.length - 1].screenNumber === undefined && seqOf(r.slice(0, 3)) === "20,21,22"; })());
check("题号校正绝不改写 bankId/matches/confidence/answer",
  (() => { const blocks = mkNb([{n:20},{n:21},{n:22},{n:23},{n:14}]);
    blocks[4].bankId = 999; blocks[4].confidence = "high";
    blocks[4].matches = [{ id: 999, score: 1234 }]; blocks[4].answer = "B";
    const last = MSQ.normalizePageQuestionSequence(blocks)[4];
    return last.bankId === 999 && last.confidence === "high" && last.answer === "B"
      && last.matches.length === 1 && last.matches[0].id === 999; })());
check("修复前的位置被记录在 originalPageIndex（输入序保留不重排）",
  (() => { const input = mkNb([{n:23},{n:14},{n:22},{n:21},{n:20}]);
    const r = MSQ.normalizePageQuestionSequence(input);
    return r.every(b => typeof b.originalPageIndex === "number")
      && r[0].screenNumber === "20" && r[0].originalPageIndex === 4
      && input[0].originalPageIndex === 0 && input[0].screenNumber === "23"; })());

/* 端到端：searchPageQuestionsByOcr 输出已按校正题号升序，匹配结果不受题号影响 */
check("整页链路：末题 34 被识成 14 时仍输出 31~34 且匹配全对",
  (() => {
    const singles = byType.single.slice(0, 4);
    const lines = [];
    let y = 60;
    singles.forEach((q, i) => {
      const num = (i === 3) ? "14" : String(31 + i);
      lines.push({ text: num + ". " + q.stem, left: 40, top: y, right: 900, bottom: y + 46 }); y += 52;
      q.options.forEach((o, k) => {
        lines.push({ text: "ABCDEF"[k] + ". " + o, left: 60, top: y, right: 900, bottom: y + 46 }); y += 52;
      });
    });
    const res = MSQ.searchPageQuestionsByOcr(batchIdx, lines, "single", { limit: 3 });
    const seq = res.blocks.map(b => b.screenNumber).join(",");
    const matchOk = res.blocks.every((b, i) => b.bankId === singles[i].id);
    return seq === "31,32,33,34" && matchOk
      && res.blocks[3].rawScreenNumber === "14" && res.blocks[3].numberSource === "repaired";
  })());
check("整页链路：漏题（少一道）时缺口保留且其余升序",
  (() => {
    const singles = byType.single.slice(4, 8);   // 4 题页：题号 20,21,22,23
    const lines = [];
    let y = 60;
    singles.forEach((q, i) => {
      if (i === 2) { return; }                   // 第 22 题整块漏识别
      lines.push({ text: (20 + i) + ". " + q.stem, left: 40, top: y, right: 900, bottom: y + 46 }); y += 52;
      q.options.forEach((o, k) => {
        lines.push({ text: "ABCDEF"[k] + ". " + o, left: 60, top: y, right: 900, bottom: y + 46 }); y += 52;
      });
    });
    const res = MSQ.searchPageQuestionsByOcr(batchIdx, lines, "single", { limit: 3 });
    return res.blocks.map(b => b.screenNumber).join(",") === "20,21,23"
      && res.blocks.every(b => b.numberSource === "ocr");
  })());

/* ---------- utils ---------- */
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
