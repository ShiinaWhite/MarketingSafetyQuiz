/* test_core.js —— Node 下自检：题库 JSON + core.js 纯逻辑
   运行: node test_core.js   （退出码 0 = 全部通过） */
"use strict";
const fs = require("fs");
const path = require("path");

/* DEV_TO_MAIN_SYNC_V1：源码守卫的行尾鲁棒性 —— merge/checkout 会按 autocrlf
   把工作区写成 CRLF，守卫里的多行字符串模式一律按 LF 匹配（只影响本测试
   的文本读取；JSON.parse 等对 \r\n 不敏感）。 */
const _origReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = function (p, opts) {
  const c = _origReadFileSync(p, opts);
  return (typeof c === "string") ? c.replace(/\r\n/g, "\n") : c;
};
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

/* ---------- 真实样本采集旁路（www/js/sample-collector.js） ----------
   只测「采集不改变识别结果」与「样本数据完整」：matcher 输出是唯一事实来源。 */
section("真实样本采集：设置（v2 公网固定 endpoint，自动上传默认 ON）");
const MSQSample = require("./www/js/sample-collector.js");
const memStore = () => {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
};
check("默认设置 = 自动上传 ON（fresh config，loadSettings 迁移层生效）",
  (() => {
    const fresh = MSQSample.loadSettings({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    return fresh.migrationVersion === 2 && fresh.autoUpload === true;
  })());
check("shouldCollect：强制 ON（SIMPLIFY_CAPTURE_FLOW_V1，用户无 opt-out）", (() => {
  const fresh = MSQSample.loadSettings({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  return MSQSample.shouldCollect(fresh) === true && MSQSample.shouldCollect() === true;
})());
check("历史 opt-out 设置不再生效（恒 ON）", (() => {
  const st = memStore();
  MSQSample.saveSettings(st, { autoUpload: false });
  return MSQSample.shouldCollect(MSQSample.loadSettings(st)) === true;
})());
check("v1 配置迁移：无法区分主动关闭与默认 OFF → 统一 ON", (() => {
  const st = memStore();
  st.setItem(MSQSample.LEGACY_SETTINGS_KEY,
    JSON.stringify({ enabled: false, serverUrl: "http://192.168.3.39:8787" }));
  const s = MSQSample.loadSettings(st);
  return s.autoUpload === true && st.getItem(MSQSample.SETTINGS_KEY) !== null;
})());
check("PUBLIC_BASE_URL 固定公网域名（无 IP/端口）",
  MSQSample.PUBLIC_BASE_URL === "https://update.shiinalab.top");
{
  const st = memStore();
  MSQSample.saveSettings(st, { autoUpload: true });
  const back = MSQSample.loadSettings(st);
  check("设置 v2 存取往返", back.autoUpload === true && back.migrationVersion === 2);
  st.setItem(MSQSample.SETTINGS_KEY, "{bad json");
  check("坏 JSON 回退默认 ON", MSQSample.loadSettings(st).autoUpload === true);
}

section("sampleId 生成");
{
  const id = MSQSample.makeSampleId(new Date(2026, 8, 23, 17, 15, 30), "ab12cd");
  check("时间戳 + 随机段格式", id === "20260923_171530_ab12cd", id);
  check("符合 collector 校验正则", MSQSample.SAMPLE_ID_RE.test(id));
  check("同秒不同随机段得到不同 id",
    id !== MSQSample.makeSampleId(new Date(2026, 8, 23, 17, 15, 30), "ff01ab"));
  const auto = MSQSample.makeSampleId(new Date());
  check("随机段自动生成且格式合法", MSQSample.SAMPLE_ID_RE.test(auto));
}

section("manifest 纯度与诊断一致性（matcher 输出零改动）");
{
  const s1 = byType.single[30], m1 = byType.multi[10], j1 = byType.judge[10];
  let top = 100;
  const line = (text) => ({ text, left: 0, right: 900, top, bottom: (top += 34) - 6 });
  const pageLines = [
    line("31. " + s1.stem),
    ...s1.options.map((o, i) => line(MSQ.LETTERS[i] + ". " + o)),
    line("多选题"),
    line("32. " + m1.stem),
    ...m1.options.map((o, i) => line(MSQ.LETTERS[i] + ". " + o)),
    line("判断题"),
    line("33. " + j1.stem),
    line("A. 正确"),
    line("B. 错误"),
  ];
  const idx = MSQ.buildBatchOcrIndex(qs);
  const byId = {};
  idx.forEach((it) => { byId[it.id] = it; });
  const out = MSQ.searchPageQuestionsByOcr(idx, pageLines, "single", { limit: 3 });
  check("模拟页分出 3 块", out.blocks.length === 3, String(out.blocks.length));
  check("3 块全部有匹配（候选检查才有意义）", out.blocks.every((b) => b.bankId !== null));

  const snapshot = JSON.stringify(out.blocks);
  const buildArgs = {
    sampleId: "20260923_171530_ab12cd", capturedAt: "2026-09-23T17:15:30.000Z",
    pageType: "single", text: "31. …\n多选题\n判断题", lines: pageLines, out,
    ocrWidth: 3000, ocrHeight: 4000,
    timing: { ocrMs: 900, splitMs: 2, matchMs: 20, totalMs: 1000 },
    bankById: byId
  };
  const manifest = MSQSample.buildRunManifest(buildArgs);
  check("buildRunManifest 纯观测：不改写 matcher 输出", JSON.stringify(out.blocks) === snapshot);
  check("重复构建结果逐字节一致（纯函数）",
    JSON.stringify(manifest) === JSON.stringify(MSQSample.buildRunManifest(buildArgs)));
  check("schemaVersion / sampleId / pageType / timing 进 manifest",
    manifest.schemaVersion === 1 && manifest.sampleId === "20260923_171530_ab12cd" &&
    manifest.pageType === "single" && manifest.timing.totalMs === 1000);
  check("image 只声明文件名（bytes/sha256/宽高由 collector 保存时补，不伪造）",
    manifest.image.filename === "capture.jpg" && manifest.image.bytes === undefined);
  check("ocr 原文与行坐标完整保留",
    manifest.ocr.lines.length === pageLines.length &&
    manifest.ocr.lines[0].text === pageLines[0].text &&
    manifest.ocr.lines[0].top === pageLines[0].top && manifest.ocr.lines[0].bottom === pageLines[0].bottom);
  check("ocr 位图尺寸保留", manifest.ocr.width === 3000 && manifest.ocr.height === 4000);

  const pairs = manifest.blocks.map((sb, i) => ({ sb, b: out.blocks[i] }));
  check("每块 finalBankId/finalAnswer/confidence 与 matcher 输出一致",
    pairs.every((p) => p.sb.finalBankId === p.b.bankId &&
      p.sb.finalAnswer === p.b.answer && p.sb.confidence === p.b.confidence));
  check("每块 rawScreenNumber/numberSource 保留（含校正来源）",
    pairs.every((p) => p.sb.rawScreenNumber === String(p.b.rawScreenNumber) &&
      p.sb.numberSource === p.b.numberSource));
  check("stemText/optionsText/rawText 保留",
    pairs.every((p) => p.sb.stemText === p.b.stemText && p.sb.optionsText === p.b.optionsText &&
      p.sb.rawText === p.b.rawText));
  check("Top1 候选 = finalBankId",
    pairs.every((p) => p.sb.candidates.length && p.sb.candidates[0].rank === 1 &&
      p.sb.candidates[0].bankId === p.sb.finalBankId));
  check("Top3 候选分数排序保持（只记录不改写）",
    pairs.every((p) => p.sb.candidates.every((c, i, a) => i === 0 || a[i - 1].score >= c.score)));
  check("候选答案来自题库真值（Top1 答案 = 题库答案文本）",
    pairs.every((p) => p.sb.candidates[0].answer === MSQ.pageAnswerText(byId[p.sb.finalBankId])));
  const CLS = { high: "high", medium: "mid", low: "low", none: "none" };
  check("置信分类与 UI 显示分类一致（pageAnswerDisplay 映射）",
    pairs.every((p) => MSQ.pageAnswerDisplay(p.sb.confidence, p.sb.finalAnswer).cls === CLS[p.sb.confidence]));
  check("无 bankById 时 candidates.answer = null 不炸",
  (() => {
    const m2 = MSQSample.buildRunManifest(Object.assign({}, buildArgs, { bankById: null }));
    return m2.blocks.every((sb) => sb.candidates.every((c) => c.answer === null));
  })());
}

section("payload 组装：JPEG 字节零改写");
{
  const DATA_URL = "data:image/jpeg;base64,QUJDREVG"; /* 占位字节，只测透传不测解码 */
  let payload = null;
  try {
    payload = MSQSample.buildUploadPayload({
      photoDataUrl: DATA_URL, sampleId: "20260923_171530_ab12cd",
      text: "x", lines: [], out: { blocks: [] }, pageType: "single",
      timing: {}, bankById: null
    });
  } catch (e) { payload = null; }
  check("payload 构建成功", payload !== null);
  check("photoDataUrl 原样透传（同一字符串，无二次压缩）", payload && payload.photoDataUrl === DATA_URL);
  check("payload 含 sampleId 与 manifest", payload && payload.sampleId === "20260923_171530_ab12cd"
    && payload.manifest && payload.manifest.schemaVersion === 1);
  let threw = false;
  try {
    MSQSample.buildUploadPayload({ photoDataUrl: "data:image/png;base64,AAAA", sampleId: "x" });
  } catch (e) { threw = true; }
  check("非 jpeg dataUrl 拒绝（collector 侧同样 400 兜底）", threw);
  check("joinUrl 拼接 /health", MSQSample.joinUrl("http://10.0.2.2:8787/", "/health") === "http://10.0.2.2:8787/health");
}

/* ---------- AUTO_PAGE_TYPE_V1：题型自动判定 ---------- */
section("AUTO 题型：合成 runs 决策矩阵（常数显式、阈值边界）");
{
  const mkOut = (confList) => ({
    blocks: confList.map((c) => ({ confidence: c })),
    answered: confList.filter((c) => c !== "none").length
  });
  const S = (h, m, l) => mkOut([...Array(h).fill("high"), ...Array(m).fill("medium"), ...Array(l).fill("low")]);
  const resolve = (runs, prev) => MSQ.resolvePageTypeAuto(runs, [], prev);

  const d = resolve({ single: S(3, 0, 0), multi: S(0, 0, 2), judge: S(0, 0, 0) }, null);
  check("D：single 大量 high、其余弱 → single（strong/match-quality）",
    d.type === "single" && d.confidence === "strong" && d.method === "match-quality");

  const e = resolve({ single: S(1, 0, 5), multi: S(7, 1, 0), judge: S(0, 0, 2) }, "single");
  check("E：multi 明显更好但上一页 single → 必须切 multi（strong）",
    e.type === "multi" && e.confidence === "strong" && e.method === "match-quality" &&
    e.diagnostics.previousType === "single");

  const f = resolve({ single: S(3, 0, 0), multi: S(2, 10, 0), judge: S(0, 0, 3) }, "single");
  check("F：结果非常接近 + 上一页 single → 弱倾向 single（medium/previous-page）",
    f.type === "single" && f.confidence === "medium" && f.method === "previous-page");

  const fNeg = resolve({ single: S(3, 0, 0), multi: S(2, 9, 1), judge: S(0, 0, 3) }, "judge");
  check("F-：上一页题型远离最佳分时不生效 → 最佳猜测 + ambiguous",
    fNeg.type === "single" && fNeg.confidence === "ambiguous" && fNeg.method === "match-quality",
    `margin=${fNeg.diagnostics.margin}`);

  const g = resolve({ single: S(0, 0, 1), multi: S(0, 0, 1), judge: mkOut([]) }, null);
  check("G：三路都极弱 → ambiguous 但仍给出类型（不抛错、不需重拍）",
    g.confidence === "ambiguous" && g.type === "single" && g.diagnostics.margin < MSQ.AUTO_MARGIN_CLOSE);

  const strongEdge = resolve({ single: S(3, 0, 0), multi: S(2, 6, 0), judge: mkOut([]) }, null);
  check("阈值边界：margin=400（=MARGIN_STRONG）判 strong", strongEdge.confidence === "strong");
  const midEdge = resolve({ single: S(3, 0, 0), multi: S(2, 7, 0), judge: mkOut([]) }, null);
  check("阈值边界：margin=300 落在 medium 档", midEdge.confidence === "medium");

  check("autoTypeScore 常数导出且可复算",
    MSQ.AUTO_TYPE_SCORE.high === 1000 && MSQ.AUTO_TYPE_SCORE.medium === 100 &&
    MSQ.AUTO_TYPE_SCORE.low === 10 &&
    MSQ.autoTypeScore(S(2, 1, 3)).score === 2 * 1000 + 100 + 3 * 10);
}

section("AUTO 题型：章节标题优先（真实题库 + pageSectionType 容错）");
{
  const idxA = MSQ.buildBatchOcrIndex(qs);
  const s1 = byType.single[30], m1 = byType.multi[10], j1 = byType.judge[10];
  const pageOf = (heading, q) => {
    let y = 100;
    const line = (t) => ({ text: t, left: 0, right: 900, top: y, bottom: (y += 34) - 6 });
    const lines = [];
    if (heading) { lines.push(line(heading)); }
    lines.push(line("31. " + q.stem));
    q.options.forEach((o, i) => lines.push(line(MSQ.LETTERS[i] + ". " + o)));
    return lines;
  };
  const rAuto = (lines, prev) => MSQ.recomputePageFromLines(idxA, lines, "auto", { limit: 3, previousType: prev });

  const ra = rAuto(pageOf("单项选择题", s1));
  check("A：标题'单项选择题' → AUTO=single/strong/section-heading",
    ra.resolved.type === "single" && ra.resolved.method === "section-heading" && ra.resolved.confidence === "strong");
  const rb = rAuto(pageOf("多项选择题", m1));
  check("B：标题'多项选择题' → AUTO=multi", rb.resolved.type === "multi" && rb.resolved.method === "section-heading");
  const rc = rAuto(pageOf("判断题", j1));
  check("C：标题'判断题' → AUTO=judge", rc.resolved.type === "judge" && rc.resolved.method === "section-heading");

  const rp = MSQ.resolvePageTypeAuto(
    { single: mkOut2([{ confidence: "high" }, { confidence: "high" }]), multi: mkOut2([]), judge: mkOut2([{ confidence: "none" }]) },
    [{ text: "判断题", top: 1 }], null);
  function mkOut2(blocks) { return { blocks, answered: blocks.filter((b) => b.confidence !== "none").length }; }
  check("标题优先级最高：匹配质量偏向 single 也被'判断题'标题覆盖",
    rp.type === "judge" && rp.method === "section-heading" && rp.confidence === "strong");

  const rd = rAuto(pageOf(null, s1), null);
  check("D-real：无标题单选页 → match-quality 选中 single",
    rd.resolved.type === "single" && rd.resolved.method === "match-quality",
    JSON.stringify(rd.resolved.diagnostics.scores));
}

section("AUTO 题型：结果页切题型复用 lines（零 OCR）");
{
  const idxA = MSQ.buildBatchOcrIndex(qs);
  const s1 = byType.single[30];
  let y = 100;
  const line = (t) => ({ text: t, left: 0, right: 900, top: y, bottom: (y += 34) - 6 });
  const linesS = [line("31. " + s1.stem), ...s1.options.map((o, i) => line(MSQ.LETTERS[i] + ". " + o))];
  const snap = JSON.stringify(linesS);

  const rH = MSQ.recomputePageFromLines(idxA, linesS, "multi", { limit: 3 });
  const freshM = MSQ.searchPageQuestionsByOcr(idxA, linesS, "multi", { limit: 3 });
  check("H：single→multi 切换与旧逻辑逐字节一致（同一份 lines）",
    JSON.stringify(rH.out) === JSON.stringify(freshM) && rH.resolved.method === "manual");
  check("H：切换不改写输入 lines", JSON.stringify(linesS) === snap);

  const rI = MSQ.recomputePageFromLines(idxA, linesS, "judge", { limit: 3 });
  const freshJ = MSQ.searchPageQuestionsByOcr(idxA, linesS, "judge", { limit: 3 });
  check("I：multi→judge 同样仅本地重算且一致",
    JSON.stringify(rI.out) === JSON.stringify(freshJ) && rI.resolved.method === "manual");

  const rK = MSQ.recomputePageFromLines(idxA, linesS, "auto", { limit: 3, previousType: null });
  check("K：auto 输出 = 直接以判定题型调用旧逻辑（matcher 零改动）",
    JSON.stringify(rK.out) ===
    JSON.stringify(MSQ.searchPageQuestionsByOcr(idxA, linesS, rK.resolved.type, { limit: 3 })));
  check("K：auto 不改写三路试跑结果",
    JSON.stringify(rK.runs.single) ===
    JSON.stringify(MSQ.searchPageQuestionsByOcr(idxA, linesS, "single", { limit: 3 })));
  const rK2 = MSQ.recomputePageFromLines(idxA, linesS, "auto", { limit: 3, previousType: null });
  check("K：resolvePageTypeAuto 纯函数（两次调用一致）",
    JSON.stringify(rK.resolved) === JSON.stringify(rK2.resolved));

  const runsForSug = {
    single: MSQ.searchPageQuestionsByOcr(idxA, linesS, "single", { limit: 3 }),
    multi: mkOut2([{ confidence: "high" }, { confidence: "high" }, { confidence: "high" }]),
    judge: mkOut2([])
  };
  function mkOut2(blocks) { return { blocks, answered: blocks.filter((b) => b.confidence !== "none").length }; }
  const sug = MSQ.suggestBetterPageType("single", runsForSug.single, runsForSug);
  check("J：手动异常时只产生建议对象，不覆盖用户选择",
    sug === null || (sug && sug.type && !runsForSug.single.__suggested));
  const sugSnap = JSON.stringify(runsForSug);
  MSQ.suggestBetterPageType("single", runsForSug.single, runsForSug);
  check("J：建议函数不改写 runs", JSON.stringify(runsForSug) === sugSnap);

  /* 静态守卫：结果页切题型函数绝不触碰相机/OCR；整页流程 OCR 只发生一次 */
  const appSrc2 = fs.readFileSync(path.join(__dirname, "www/js/app.js"), "utf8");
  const fnStart = appSrc2.indexOf("function switchBatchPageType");
  const fnEnd = fnStart >= 0 ? appSrc2.indexOf("\n  function ", fnStart + 10) : -1;
  const fnBody = (fnStart >= 0 && fnEnd > fnStart) ? appSrc2.slice(fnStart, fnEnd) : "";
  check("TYPE_SWITCH_OCR_CALLS = 0（切题型函数无 recognizeText/getPlugin 引用）",
    fnBody.length > 200 && !fnBody.includes("recognizeText") && !fnBody.includes("getPlugin"),
    `bodyLen=${fnBody.length}`);
  const bsStart = appSrc2.indexOf("async function startBatchPageSearch");
  const bsEnd = bsStart >= 0 ? appSrc2.indexOf("\n  /* ", bsStart + 10) : -1;
  const bsBody = (bsStart >= 0 && bsEnd > bsStart) ? appSrc2.slice(bsStart, bsEnd) : "";
  check("整页流程 OCR once（startBatchPageSearch 内 recognizeText 恰好 1 次）",
    (bsBody.match(/recognizeText/g) || []).length === 1);
}

section("样本采集：AUTO 诊断字段（schemaVersion=1 增量）");
{
  const base = {
    photoDataUrl: "data:image/jpeg;base64,QUJD", sampleId: "20260923_200000_aa12cd",
    text: "x", lines: [], out: { blocks: [] }, pageType: "multi",
    pageTypeMode: "auto", resolvedPageType: "multi",
    pageTypeResolutionMethod: "match-quality", autoTypeConfidence: "strong",
    timing: {}, bankById: null
  };
  const p1 = MSQSample.buildUploadPayload(base);
  const j1 = JSON.stringify(p1.manifest);
  check("AUTO 诊断字段进 manifest",
    j1.includes('"pageTypeMode":"auto"') && j1.includes('"resolvedPageType":"multi"') &&
    j1.includes('"pageTypeResolutionMethod":"match-quality"') && j1.includes('"autoTypeConfidence":"strong"'));
  check("schemaVersion 仍为 1（旧 collector 兼容）", p1.manifest.schemaVersion === 1);
  const p2 = MSQSample.buildUploadPayload({
    photoDataUrl: base.photoDataUrl, sampleId: base.sampleId,
    text: "x", lines: [], out: { blocks: [] }, pageType: "single", timing: {}, bankById: null
  });
  check("不传诊断字段时不产生该键（旧行为不变）",
    !JSON.stringify(p2.manifest).includes("pageTypeMode") &&
    !JSON.stringify(p2.manifest).includes("autoTypeConfidence"));
}

/* ---------- BATCH_DETAIL_NAVIGATION_V1：详情来源与返回（静态守卫） ----------
   行为级 NAV-A~J 由 testbench/nav_test.html 在真实浏览器中覆盖（fake 插件 + 真实 DOM）；
   这里用源码结构断言防止回归：统一返回入口、来源上下文、返回零重算零上传。 */
section("导航：详情来源与返回（静态守卫）");
{
  const appSrc3 = fs.readFileSync(path.join(__dirname, "www/js/app.js"), "utf8");
  const fnOf = (sig, nextSig) => {
    const s = appSrc3.indexOf(sig);
    if (s < 0) { return ""; }
    const e = nextSig ? appSrc3.indexOf(nextSig, s + 10) : appSrc3.indexOf("\n  function ", s + 10);
    return appSrc3.slice(s, e > s ? e : undefined);
  };
  const openDetailFn = fnOf("function openSearchDetail(");
  const backDetailFn = fnOf("function handleSearchDetailBack(");

  check("NAV-S1 openSearchDetail 带 source 参数并记录 batch 上下文",
    openDetailFn.includes("function openSearchDetail(id, source)") &&
    openDetailFn.includes("batch-results") && openDetailFn.includes("batchWindowY"));
  check("NAV-S2 Top3 候选点击传入 batch-results 来源",
    appSrc3.includes('openSearchDetail(m.id, "batch-results")'));
  check("NAV-S3 返回按来源路由：batch → show(view-batch-results)，否则 → search",
    backDetailFn.includes("detailReturnContext.source === \"batch-results\"") &&
    backDetailFn.includes('show("view-batch-results")') &&
    backDetailFn.includes('show("view-search")'));
  check("NAV-S4 返回恢复双通道滚动位置（容器 + window）",
    backDetailFn.includes("batchScrollTop") && backDetailFn.includes("batchWindowY") &&
    backDetailFn.includes("requestAnimationFrame"));
  const forbidden = ["recognizeText", "searchPageQuestionsByOcr", "recomputePageFromLines",
    "splitPageOcrLines", "renderBatchResults", "makeSampleId", "postJSON"];
  check("NAV-F/G/H 静态：详情返回零 OCR/零重算/零上传",
    forbidden.every((k) => !backDetailFn.includes(k)), forbidden.filter((k) => backDetailFn.includes(k)).join(","));
  check("NAV-A/B 统一入口：详情返回按钮与系统 back 共用 handleSearchDetailBack",
    appSrc3.includes('$("btn-detail-back").addEventListener("click", handleSearchDetailBack)') &&
    (appSrc3.match(/case "view-search-detail": handleSearchDetailBack\(\); return;/g) || []).length === 1);
  check("NAV-C Android back 唯一监听（registerSystemBack 单次注册）",
    (appSrc3.match(/addListener\("backButton"/g) || []).length === 1);
  check("NAV-J 一次 back 一层：batch-results 层只走 handleBatchResultsBack",
    (appSrc3.match(/case "view-batch-results": handleBatchResultsBack\(\); return;/g) || []).length === 1);
}

/* ---------- SELF_UPDATE_V1：应用内自更新纯逻辑 ---------- */
section("应用自更新：updater.js（UPD-A~L）");
const MSQUpdater = require("./www/js/updater.js");
{
  const goodManifest = {
    schemaVersion: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev",
    versionCode: 2, versionName: "1.0.2-dev", apkUrl: "/api/update/dev/apk",
    sha256: "c5f8965a5c6a3f86bde2ee50d71ebc22b2bade0650e1174bbc3572a11d959abb",
    size: 52450325, publishedAt: "2026-09-24T00:00:00Z", notes: "SELF_UPDATE_V1"
  };
  const v = (m, exp) => MSQUpdater.validateManifest(m, exp || { channel: "dev", packageName: "com.jty.safetyquiz.dev" });

  check("UPD-A 当前1 新2 → available", MSQUpdater.checkUpdateState(1, goodManifest) === "available");
  check("UPD-B 当前2 新2 → latest", MSQUpdater.checkUpdateState(2, goodManifest) === "latest");
  check("UPD-C 当前3 新2 → 不允许降级", MSQUpdater.checkUpdateState(3, goodManifest) === "downgrade");
  check("UPD-D packageName 不匹配 → reject",
    !v(Object.assign({}, goodManifest, { packageName: "com.jty.safetyquiz" })).ok);
  check("UPD-E channel 不匹配 → reject",
    !v(Object.assign({}, goodManifest, { channel: "stable" })).ok);
  check("UPD-F schemaVersion 不支持 → reject",
    !v(Object.assign({}, goodManifest, { schemaVersion: 2 })).ok);
  check("UPD-G sha256 非法 → reject",
    !v(Object.assign({}, goodManifest, { sha256: "abc" })).ok);
  check("UPD-H size 异常 → reject",
    !v(Object.assign({}, goodManifest, { size: 0 })).ok &&
    !v(Object.assign({}, goodManifest, { size: MSQUpdater.MAX_APK_BYTES + 1 })).ok);
  check("合法 manifest → ok", v(goodManifest).ok);
  check("versionCode 非整数 → reject",
    !v(Object.assign({}, goodManifest, { versionCode: 2.5 })).ok &&
    !v(Object.assign({}, goodManifest, { versionCode: "2" })).ok);

  check("UPD-I 相对 apkUrl → 按 server 解析",
    MSQUpdater.resolveApkUrl("http://192.168.3.39:8787", "/api/update/dev/apk")
      === "http://192.168.3.39:8787/api/update/dev/apk");
  check("UPD-J 绝对 https apkUrl → 保持原样",
    MSQUpdater.resolveApkUrl("http://192.168.3.39:8787", "https://update.shiinalab.top/dev/app.apk")
      === "https://update.shiinalab.top/dev/app.apk");
  check("UPD-K 未配置更新服务器 → 使用内置公网默认",
    MSQUpdater.resolveUpdateServer({}, null, "") === "https://update.shiinalab.top");
  check("UPD-K2 显式 bundled default 可覆盖内置公网",
    MSQUpdater.resolveUpdateServer({}, "https://example.test") === "https://example.test");
  check("UPD-L 内置默认恒可用（不存在无服务器状态）",
    MSQUpdater.resolveUpdateServer({}, null, undefined) === "https://update.shiinalab.top");
  check("更新设置优先于采集设置",
    MSQUpdater.resolveUpdateServer({ serverUrl: "https://update.shiinalab.top" },
      { serverUrl: "http://192.168.3.39:8787" }, "") === "https://update.shiinalab.top");
  check("渠道由 applicationId 决定（不写死 dev）",
    MSQUpdater.updateChannelFor("com.jty.safetyquiz.dev") === "dev" &&
    MSQUpdater.updateChannelFor("com.jty.safetyquiz") === "stable" &&
    MSQUpdater.updateChannelFor("com.other.app") === null);
  check("serverUrl 归一化（坏协议拒绝/去尾斜杠）",
    MSQUpdater.normalizeSettings({ serverUrl: "ftp://x" }).serverUrl === "" &&
    MSQUpdater.normalizeSettings({ serverUrl: "http://a:1/" }).serverUrl === "http://a:1");
}

/* ---------- APK_DELIVERY_COS_CDN_VC13_V1：CDN apkUrl + fallback 语义 ---------- */
section("CDN 迁移：绝对 apkUrl / fallbackApkUrl 前向兼容 / 回退分类（UPD-CDN 系列）");
{
  const CDN_URL = "https://apk.shiinalab.top/dev/vc13/msq-dev-vc13.apk";
  const manifestVc13 = {
    schemaVersion: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev",
    versionCode: 13, versionName: "1.0.13-dev",
    apkUrl: CDN_URL,
    fallbackApkUrl: "/api/update/dev/apk",
    sha256: "7".repeat(64), size: 17221414,
    publishedAt: "2026-09-26T00:00:00Z", notes: "CDN"
  };
  const v13 = (m) => MSQUpdater.validateManifest(m, { channel: "dev", packageName: "com.jty.safetyquiz.dev" });

  check("UPD-CDN-1a 绝对 HTTPS CDN apkUrl 原样透传",
    MSQUpdater.resolveApkUrl("https://update.shiinalab.top", CDN_URL) === CDN_URL);
  check("UPD-CDN-1b CDN apkUrl 的 manifest 校验通过", v13(manifestVc13).ok);
  /* #2 vc12 前向兼容：未知 fallbackApkUrl 字段不破坏校验（vc12 代码同样宽松，已实证） */
  check("UPD-CDN-2 manifest 含 fallbackApkUrl 仍校验通过（vc12 前向兼容）", v13(manifestVc13).ok);
  check("UPD-CDN-2b 无 fallbackApkUrl 的 manifest 同样通过（legacy 不受影响）",
    v13(Object.assign({}, manifestVc13, { fallbackApkUrl: undefined })).ok);
  /* #13 malformed size → manifest 校验拒绝 */
  check("UPD-CDN-13 size 畸形（字符串/负数/非整数）→ reject",
    !v13(Object.assign({}, manifestVc13, { size: "17221414" })).ok &&
    !v13(Object.assign({}, manifestVc13, { size: -1 })).ok &&
    !v13(Object.assign({}, manifestVc13, { size: 17.5 })).ok);

  /* #3-10 回退分类矩阵：传输失败允许回退，安全失败一律 HARD FAIL */
  const cls = (e) => MSQUpdater.classifyDownloadFailure(e);
  const fb = (e) => MSQUpdater.shouldTryFallback(e);
  check("UPD-CDN-3 DNS/IO 异常（DOWNLOAD_FAILED）→ transport，允许回退",
    cls({ code: "DOWNLOAD_FAILED", message: "下载失败：Unable to resolve host apk.shiinalab.top" }) === "transport" &&
    fb({ code: "DOWNLOAD_FAILED", message: "x" }) === true);
  check("UPD-CDN-4/5/6 HTTP 503 / 429 / 408 → transport，允许回退一次",
    [503, 500, 429, 408].every((s) =>
      fb({ code: "HTTP_ERROR", message: "下载失败 HTTP " + s }) === true));
  check("UPD-CDN-6b HTTP 404/403 → security，禁止回退",
    cls({ code: "HTTP_ERROR", message: "下载失败 HTTP 404" }) === "security" &&
    fb({ code: "HTTP_ERROR", message: "下载失败 HTTP 403" }) === false);
  /* #7-10 安全校验失败 = HARD FAIL，绝不回退 */
  check("UPD-CDN-7 SHA mismatch → 禁止回退",
    fb({ code: "SHA_MISMATCH", message: "更新包校验失败（SHA256 不一致）" }) === false &&
    cls({ code: "SHA_MISMATCH", message: "x" }) === "security");
  check("UPD-CDN-8 package mismatch → 禁止回退",
    fb({ code: "PACKAGE_MISMATCH", message: "x" }) === false);
  check("UPD-CDN-9 version mismatch → 禁止回退",
    fb({ code: "VERSION_MISMATCH", message: "x" }) === false);
  check("UPD-CDN-10 signer mismatch / 解析失败 / 超限 / 安装前校验 → 禁止回退",
    ["SIGNER_MISMATCH", "PARSE_FAILED", "TOO_LARGE", "VERIFY_FAILED"].every((c) =>
      fb({ code: c, message: "x" }) === false));
  check("UPD-CDN-10b 无 code 的拒绝（JS 侧参数错误）→ 禁止回退",
    fb(new Error("下载地址无效")) === false);

  /* fallback URL 解析：相对路径按控制面 server 拼接；缺失 → null */
  check("UPD-CDN-11 fallbackApkUrl 相对路径 → 控制面拼接",
    MSQUpdater.fallbackApkUrlFor(manifestVc13, "https://update.shiinalab.top") ===
      "https://update.shiinalab.top/api/update/dev/apk");
  check("UPD-CDN-12 无 fallbackApkUrl → null（不触发回退）",
    MSQUpdater.fallbackApkUrlFor({ apkUrl: CDN_URL }, "https://update.shiinalab.top") === null);

  /* #14 安装前二次校验仍然存在（静态守卫，防未来被误删） */
  const pluginSrc = fs.readFileSync(path.join(__dirname, "android/app/src/main/java/com/jty/safetyquiz/UpdatePlugin.java"), "utf8");
  const installIdx = pluginSrc.indexOf("public void installDownloadedUpdate");
  const verifyIdx = pluginSrc.indexOf("verifyApkFile(call, apk, expectedSha256", installIdx);
  check("UPD-CDN-14 installDownloadedUpdate 安装前二次全量校验仍在（静态守卫）",
    installIdx >= 0 && verifyIdx > installIdx);
  check("UPD-CDN-14b 下载校验使用多态 size 解析（getLong 陷阱修复，静态守卫）",
    pluginSrc.includes("UpdateVerifier.flexibleLong("));
}

/* ---------- STARTUP_UPDATE_CHECK_V1：冷启动自动检查更新（SUC 系列） ----------
   决策矩阵是纯函数；编排（createController）内部走 Promise 微任务，所以本小节
   的编排断言在异步函数内完成，文件末尾的统一结论推迟到其完成后输出。 */
section("启动自动检查更新：startup-update.js（SUC 系列）");
const MSQStartupUpdate = require("./www/js/startup-update.js");
const appSrc = fs.readFileSync(path.join(__dirname, "www/js/app.js"), "utf8");

/* 决策矩阵（SUC-2~6/9 的判定核心，同步纯函数） */
{
  const d = (check, flags) => MSQStartupUpdate.decideStartupPrompt(check, flags || {});
  check("SUC-2 决策（DEFERRED）：fresh available → 本 session 永不弹（deferred 到下次冷启动）",
    d({ ok: true, state: "available" }, { canShowNow: true }).prompt === false &&
    d({ ok: true, state: "available" }, { canShowNow: true }).reason === "fresh-discovery-deferred-next-cold-start" &&
    d({ ok: true, state: "available" }, { dismissed: true }).prompt === false);
  check("SUC-3 决策：latest == current（latest）→ 完全静默",
    d({ ok: true, state: "latest" }).prompt === false);
  check("SUC-4 决策：latest < current（downgrade）→ 完全静默",
    d({ ok: true, state: "downgrade" }).prompt === false);
  check("SUC-5 决策：检查失败（offline/DNS/超时/5xx 归并为 ok:false）→ 完全静默",
    d({ ok: false }).prompt === false && d(null).prompt === false &&
    d({ ok: false }).reason === "check-failed");
  check("SUC-6 决策：manifest 无效（校验失败）→ 完全静默",
    d({ ok: false, error: "更新信息 versionCode 无效" }).prompt === false);
  check("SUC-9 决策：用户已关闭提示 → 本次 session 不再自动弹",
    d({ ok: true, state: "available" }, { dismissed: true }).prompt === false);
  check("SUC-9b 决策（DEFERRED）：fresh 路径不再读 canShowNow（页面位置只影响 cache prompt 门）",
    d({ ok: true, state: "available" }, { canShowNow: false }).prompt === false &&
    d({ ok: true, state: "available" }, {}).reason === "fresh-discovery-deferred-next-cold-start");
}

/* 编排测试：注入 fake io，驱动与 app.js 完全相同的 controller 代码 */
function runSucOrchestrationTests() {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const SU_CREATE = (io) => MSQStartupUpdate.createController(io);
  const sucManifest = (vc) => ({
    schemaVersion: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev",
    versionCode: vc, versionName: "1.0." + vc, sha256: "a".repeat(64),
    size: 17221414, apkUrl: "https://apk.shiinalab.top/dev/vc" + vc + "/msq-dev-vc" + vc + ".apk",
    fallbackApkUrl: "/api/update/dev/apk"
  });
  function makeIo(overrides) {
    const io = {
      calls: { fetch: 0, prompt: 0 }, logs: [], manifest: null,
      getAppInfo: () => Promise.resolve(
        { id: "com.jty.safetyquiz.dev", versionName: "1.0.14", versionCode: 14 }),
      channelFor: (id) => (id === "com.jty.safetyquiz.dev" ? "dev" : null),
      fetchLatest: function () {
        this.calls.fetch++;
        return this.manifest === "REJECT"
          ? Promise.reject(new Error("simulated transport failure"))
          : Promise.resolve(this.manifest);
      },
      validate: (m, exp) => MSQUpdater.validateManifest(m, exp),
      compare: (cur, m) => MSQUpdater.checkUpdateState(cur, m),
      canShowNow: () => true,
      showPrompt: function (info, m) {
        this.calls.prompt++;
        this.promptedWith = { info: info, m: m };
      },
      debug: function (msg) { this.logs.push(msg); }
    };
    return Object.assign(io, overrides || {});
  }

  return Promise.resolve().then(async () => {
    /* SUC-1 冷启动只触发一次检查（再触发=前台恢复/相机返回/安装器返回） */
    {
      const io = makeIo(); io.manifest = sucManifest(14);
      const c = SU_CREATE(io);
      const r1 = c.trigger();
      c.trigger(); c.trigger(); c.trigger();
      await flush();
      check("SUC-1 冷启动触发检查且整个 session 恰好一次（fetch 恰好 1 次）",
        r1.ran === true && io.calls.fetch === 1);
      check("SUC-1b 二次触发被拒并记 debug（后台→前台/相机返回同路径）",
        io.logs.some((l) => l.includes("already ran this session")));
    }

    /* SUC-2（DEFERRED_PROMPT_V1）有更新 → fresh discovery 静默完成，本 session 不弹 */
    {
      const io = makeIo(); io.manifest = sucManifest(15);
      const c = SU_CREATE(io);
      c.trigger(); await flush();
      check("SUC-2 latest(15) > current(14) → fresh discovery 静默（本 session 不弹）",
        io.calls.prompt === 0 &&
        io.logs.some((l) => l.includes("fresh-discovery-deferred-next-cold-start")));
    }

    /* SUC-3/4 无更新/降级 → 完全静默 */
    {
      const io = makeIo(); io.manifest = sucManifest(14);
      SU_CREATE(io).trigger(); await flush();
      check("SUC-3 latest == current → 不弹、无 UI 状态",
        io.calls.prompt === 0 && io.logs.some((l) => l.includes("not-newer:latest")));
    }
    {
      const io = makeIo(); io.manifest = sucManifest(13);
      SU_CREATE(io).trigger(); await flush();
      check("SUC-4 latest < current → 不弹",
        io.calls.prompt === 0 && io.logs.some((l) => l.includes("not-newer:downgrade")));
    }

    /* SUC-5 网络失败（offline/DNS/超时/5xx 在 MSQSample.getJSON 一律 reject）→ 静默 */
    {
      const io = makeIo(); io.manifest = "REJECT";
      SU_CREATE(io).trigger(); await flush();
      check("SUC-5 网络失败 → 不弹不抛错，仅非敏感 debug log",
        io.calls.prompt === 0 &&
        io.logs.some((l) => l.includes("startup update check failed: network/transport")));
    }

    /* SUC-6 manifest 畸形/校验失败 → 静默 */
    {
      const io = makeIo(); io.manifest = { foo: 1 };
      SU_CREATE(io).trigger(); await flush();
      check("SUC-6a 畸形 manifest → 不弹",
        io.calls.prompt === 0 && io.logs.some((l) => l.includes("check-failed")));
    }
    {
      /* 真 validateManifest 校验矩阵：schema/渠道/包名/versionCode/sha/size 全挡 */
      const bad = [
        null,
        Object.assign(sucManifest(15), { schemaVersion: 2 }),
        Object.assign(sucManifest(15), { channel: "stable" }),
        Object.assign(sucManifest(15), { packageName: "com.other.app" }),
        Object.assign(sucManifest(15), { versionCode: 1.5 }),
        Object.assign(sucManifest(15), { sha256: "zz" }),
        Object.assign(sucManifest(15), { size: -1 })
      ];
      const allRejected = bad.every((m) =>
        !MSQUpdater.validateManifest(m, { channel: "dev", packageName: "com.jty.safetyquiz.dev" }).ok);
      check("SUC-6b 真 validateManifest 挡住全部畸形 manifest（进入启动静默路径）",
        allRejected);
    }

    /* SUC-7/8 前台恢复/相机返回不重新检查：一次性状态 + app.js 无生命周期监听器 */
    {
      const io = makeIo(); io.manifest = sucManifest(14);
      const c = SU_CREATE(io);
      c.trigger(); await flush();
      const n1 = io.calls.fetch;
      c.trigger(); c.trigger(); await flush();
      check("SUC-7/8 任何后续 trigger（=后台恢复/相机返回）都不再 fetch",
        n1 === 1 && io.calls.fetch === 1 && c.flags().started === true);
      check("SUC-7/8b app.js 无 resume/appStateChange/visibilitychange 监听器（源码守卫）",
        !/addListener\("(resume|appStateChange)"/.test(appSrc) &&
        !appSrc.includes("visibilitychange"));
      check("SUC17-1/2 启动检查在 bootstrap 期即触发（早于 loadBank），modal 门与题库解耦（INSTANT_V2）",
        appSrc.indexOf("startupUpdateCtrl.trigger();") > 0 &&
        appSrc.indexOf("startupUpdateCtrl.trigger();") < appSrc.indexOf("loadBank().then(") &&
        appSrc.includes("modalUiReady = true;") &&
        appSrc.indexOf("modalUiReady = true;") > appSrc.indexOf("Modal.init();") &&
        appSrc.indexOf("modalUiReady = true;") < appSrc.indexOf("loadBank().then(") &&
        appSrc.includes("startupUpdateCtrl.markUiReady();"));
      check("SUC17-2b cache prompt 门：modalUiReady + 首页 + 无弹窗（不就绪绝不展示）",
        appSrc.includes("!modalUiReady || currentViewId() !== \"view-menu\" || Modal.isOpen()"));
    }

    /* SUC-9 dismiss 后同 session 不再自动弹（controller 一次性 + dismissed 双保险） */
    {
      const io = makeIo(); io.manifest = sucManifest(15);
      const c = SU_CREATE(io);
      c.trigger(); await flush();
      c.markDismissed();
      const second = c.trigger(); await flush();
      check("SUC-9 dismiss 后再次触发（含未来误接线）也不弹（fresh 路径恒静默）",
        io.calls.prompt === 0 && second.ran === false &&
        c.flags().dismissed === true);
    }

    /* SUC-10/11 手动"检查更新"交互不受启动静默行为影响（源码守卫） */
    {
      const mIdx = appSrc.indexOf("function checkForUpdate()");
      const endIdx = appSrc.indexOf("function updateFriendlyError", mIdx);
      const manual = appSrc.slice(mIdx, endIdx);
      check("SUC-10 手动 checkForUpdate 不读启动一次性/dismissed 状态（dismiss 后仍可查）",
        mIdx > 0 && endIdx > mIdx &&
        !manual.includes("startupUpdate") && !manual.includes("dismissed"));
      check("SUC-11 手动检查的「已是最新版/暂不更新/无法连接」原交互保留",
        manual.includes("已经是最新版") && manual.includes("暂不更新") &&
        manual.includes("无法连接更新服务器"));
    }

    /* SUC-12 启动与手动共用同一获取/校验/比较/弹窗/下载/校验/安装路径（源码守卫） */
    {
      const bootIdx = appSrc.indexOf("STARTUP_UPDATE_CHECK_V1");
      const startSec = appSrc.slice(bootIdx, appSrc.indexOf("清除记录", bootIdx));
      check("SUC-12b 启动 fresh latest 唯一请求在 prefetch 模块（endpoint/超时与手动一致）",
        fs.readFileSync(path.join(__dirname, "www/js/startup-update-prefetch.js"), "utf8")
          .includes('"/api/update/" + channel + "/latest", 10000'));
      check("SUC-12b2 app.js 启动段复用 prefetch（不自带第二次 latest fetch）",
        startSec.includes("prefetchReady") && !startSec.includes('"/api/update/"'));
      check("SUC-12c 启动校验/比较直接调用 MSQUpdater.validateManifest/checkUpdateState",
        startSec.includes("MSQUpdater.validateManifest(manifest, expected)") &&
        startSec.includes("MSQUpdater.checkUpdateState(currentVersionCode, manifest)"));
      check("SUC-12d 启动提示为 Modal（VC16），「立即更新」进入既有更新页与下载链",
        startSec.includes("function showStartupUpdateModal") &&
        startSec.includes("Modal.open(function (box)") &&
        startSec.includes("openUpdateView(true)") &&
        !startSec.includes('show("view-update")'));
      const dlIdx = appSrc.indexOf("function startUpdateDownload()");
      const dl = appSrc.slice(dlIdx, appSrc.indexOf("function afterDownloadVerified", dlIdx));
      check("SUC-12e 下载/回退/校验仍走同一 UpdatePlugin 路径（resolveApkUrl/shouldTryFallback/verifier）",
        dl.includes("MSQUpdater.resolveApkUrl") && dl.includes("MSQUpdater.shouldTryFallback") &&
        dl.includes("MSQUpdater.fallbackApkUrlFor") && dl.includes("Update.downloadUpdate") &&
        dl.includes("sha256: updateManifest.sha256") &&
        dl.includes("expectedPackageName: updateInfo.id"));
    }

    /* ====== VC17：启动检查提前并行（fetch 与初始化重叠，就绪后才展示） ====== */
    {
      /* SUC17-3（DEFERRED）fetch 先完成（用户在别处/未就绪）→ discovery 静默，不弹不暂存 */
      const ioA = makeIo(); ioA.manifest = sucManifest(15);   /* 对 current=14 为 available */
      const cA = SU_CREATE(ioA);
      cA.trigger(); await flush();
      check("SUC17-3 fetch 完成（无论 UI 状态）→ discovery 静默、不暂存",
        ioA.calls.prompt === 0 &&
        ioA.logs.some((l) => l.includes("fresh-discovery-deferred-next-cold-start")));

      /* SUC17-4 menu 先就绪 → fetch 返回后同样不弹（页面位置与 fresh 解耦） */
      const ioB = makeIo(); ioB.manifest = sucManifest(15);
      const cB = SU_CREATE(ioB);
      cB.markUiReady();
      cB.trigger(); await flush();
      check("SUC17-4 menu 先 ready → fetch 返回后仍不弹（deferred）",
        ioB.calls.prompt === 0 &&
        ioB.logs.some((l) => l.includes("fresh-discovery-deferred-next-cold-start")));

      /* SUC17-8/9 一次性触发与 dismiss 语义保留 */
      const ioD = makeIo(); ioD.manifest = sucManifest(15);
      const cD = SU_CREATE(ioD);
      cD.trigger(); await flush();
      const rD2 = cD.trigger(); await flush();
      cD.markDismissed();
      check("SUC17-8/9 二次触发无效、dismiss 语义保留（fresh 恒静默）",
        rD2.ran === false && ioD.calls.fetch === 1 && ioD.calls.prompt === 0 &&
        cD.flags().dismissed === true);
    }

    /* ====== SDP-7/8：timer 自动重试（node 真定时器；浏览器 hidden 页 timer 被冻结，
       延时自动性只能在 node 进程里证明；storage/fetch 全 mock，30ms delay） ====== */
    {
      const mockStore = (() => { const m = {}; return {
        setItem: (k, v) => { m[k] = String(v); },
        getItem: (k) => (k in m ? m[k] : null),
        removeItem: (k) => { delete m[k]; }
      }; })();
      const validManifest20 = () => ({ schemaVersion: 1, channel: "dev",
        packageName: "com.jty.safetyquiz.dev", versionCode: 15,
        versionName: "1.0.15-dev", sha256: "a".repeat(64), size: 17209403,
        apkUrl: "https://cdn.example/dev/vc15/msq-dev-vc15.apk" });
      let latestCalls = 0;
      global.MSQUpdater = MSQUpdater;
      global.MSQSample = { getJSON: function () {
        latestCalls += 1;
        return latestCalls === 1
          ? Promise.reject(new Error("simulated connect timeout"))
          : Promise.resolve(validManifest20());
      } };
      global.localStorage = mockStore;
      global.__MSQStartupPrefetchRetryDelayMs = 20;
      global.Capacitor = { Plugins: { App: {
        getInfo: async () => ({ id: "com.jty.safetyquiz.dev", version: "1.0.14", build: "14" }),
        addListener: function () { return { remove: function () { } }; }
      } } };
      delete require.cache[require.resolve("./www/js/startup-update-prefetch.js")];
      const pfRaw = require("./www/js/startup-update-prefetch.js");
      /* node 下模块 root=module.exports（self 未定义），浏览器下挂 window —— 两者兼容 */
      const P = pfRaw.__MSQStartupUpdatePrefetch || pfRaw;
      const result = await P.ready.then(function (r) { return r.freshReady; });
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleepMs(60);   /* 给 retry timer 充分触发窗口 */
      const cached = MSQUpdater.readLatestCache(mockStore, "dev");
      check("SDP-7 首次 transport 失败 → timer 到期自动静默重试（恰 2 次尝试）",
        latestCalls === 2);
      check("SDP-8 retry 成功 → validated cache 写入 + fresh ok（本 session 无任何 UI 语义）",
        result && result.ok === true &&
        cached && cached.manifest && cached.manifest.versionCode === 15);
      check("SDP-8b 重试后不再继续尝试（成功即终态）",
        await sleepMs(40).then(() => latestCalls === 2));
    }
  });
}

/* ---------- STARTUP_UPDATE_INSTANT_V2：Validated Manifest Cache（SUC20，纯函数） ---------- */
section("启动更新即时化：Validated Manifest Cache（SUC20，纯函数 + 静态）");
{
  const store = (() => { const m = {}; return {
    setItem: (k, v) => { m[k] = String(v); },
    getItem: (k) => (k in m ? m[k] : null),
    removeItem: (k) => { delete m[k]; }
  }; })();
  const man = (vc, ch, pkg) => ({ schemaVersion: 1, channel: ch || "dev",
    packageName: pkg || "com.jty.safetyquiz.dev", versionCode: vc,
    versionName: "1.0." + vc + "-dev", sha256: "a".repeat(64), size: 17209403,
    apkUrl: "https://cdn.example/dev/vc" + vc + "/msq-dev-vc" + vc + ".apk" });
  const exp = { channel: "dev", packageName: "com.jty.safetyquiz.dev" };

  check("SUC20-1 validated newer cache → available（instant prompt 前提）",
    MSQUpdater.writeLatestCache(store, "dev", man(20), 12345) === true &&
    MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === "available");
  check("SUC20-2 cached equal version → latest（不提示）",
    MSQUpdater.writeLatestCache(store, "dev", man(15), 12346) === true &&
    MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === "latest");
  check("SUC20-3 cached older version → downgrade（不提示）",
    MSQUpdater.writeLatestCache(store, "dev", man(10), 12347) === true &&
    MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === "downgrade");
  check("SUC20-4 corrupt cache → readLatestCache null → ignore",
    (() => { store.setItem(MSQUpdater.latestCacheKey("dev"), "{corrupt!!");
      return MSQUpdater.readLatestCache(store, "dev") === null; })() &&
    MSQUpdater.cachedUpdateState(15, null, exp) === null);
  check("SUC20-5 wrong channel/package cache → validate 拒绝 → ignore",
    (() => {
      store.setItem(MSQUpdater.latestCacheKey("dev"), JSON.stringify(
        { manifest: man(99, "stable"), fetchedAt: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev" }));
      return MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === null;
    })() &&
    (() => {
      store.setItem(MSQUpdater.latestCacheKey("dev"), JSON.stringify(
        { manifest: man(99, "dev", "com.other.app"), fetchedAt: 1, channel: "dev", packageName: "com.other.app" }));
      return MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === null;
    })());
  check("SUC20-6 cache 写读回路保真（manifest/fetchedAt/channel/packageName）",
    (() => {
      MSQUpdater.writeLatestCache(store, "dev", man(21), 555);
      const e = MSQUpdater.readLatestCache(store, "dev");
      return !!(e && e.manifest && e.manifest.versionCode === 21 && e.fetchedAt === 555 &&
        e.channel === "dev" && e.packageName === "com.jty.safetyquiz.dev");
    })());
  check("SUC20-7/12 cache 绝不绕过校验：坏 manifest 即便更高版本也 ignore；升级后 current>=cached 不提示",
    (() => {
      const bad = man(99); bad.sha256 = "zz";
      store.setItem(MSQUpdater.latestCacheKey("dev"), JSON.stringify(
        { manifest: bad, fetchedAt: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev" }));
      return MSQUpdater.cachedUpdateState(15, MSQUpdater.readLatestCache(store, "dev"), exp) === null;
    })() &&
    (() => {
      MSQUpdater.writeLatestCache(store, "dev", man(18), 557);
      return MSQUpdater.cachedUpdateState(19, MSQUpdater.readLatestCache(store, "dev"), exp) === "downgrade";
    })());
  check("SUC20-8 prefetch 唯一 fresh 请求（单 getJSON）+ app.js 启动段复用不发第二次",
    (() => {
      const psrc = fs.readFileSync(path.join(__dirname, "www/js/startup-update-prefetch.js"), "utf8");
      const startIdx = appSrc.indexOf("STARTUP_UPDATE_CHECK_V1");
      const startSec20 = appSrc.slice(startIdx, appSrc.indexOf("清除记录", startIdx));
      return (psrc.match(/getJSON\(/g) || []).length === 1 &&
        startSec20.includes("prefetchReady") && !startSec20.includes('"/api/update/"');
    })());
  check("SUC20-9 展示门解耦：cache prompt 用 modalUiReady 门；置位于 Modal.init 后、loadBank 注册前",
    appSrc.includes('!modalUiReady || currentViewId() !== "view-menu" || Modal.isOpen()') &&
    appSrc.indexOf("modalUiReady = true;") > appSrc.indexOf("Modal.init();") &&
    appSrc.indexOf("modalUiReady = true;") < appSrc.indexOf("loadBank().then("));
  /* ---- STARTUP_UPDATE_DEFERRED_PROMPT_V1：有限静默 retry（SDP 静态守卫） ---- */
  {
    const psrc = fs.readFileSync(path.join(__dirname, "www/js/startup-update-prefetch.js"), "utf8");
    const sucSrc = fs.readFileSync(path.join(__dirname, "www/js/startup-update.js"), "utf8");
    check("SDP-2 静态：fresh discovery 决策恒 deferred（不再有 fresh prompt 路径）",
      sucSrc.includes("fresh-discovery-deferred-next-cold-start") &&
      !sucSrc.includes("io.showPrompt") && !sucSrc.includes("io.canShowNow"));
    check("SDP-9 静态：MAX_FRESH_ATTEMPTS_PER_SESSION = 2",
      psrc.includes("MAX_FRESH_ATTEMPTS_PER_SESSION = 2") &&
      !psrc.includes("MAX_FRESH_ATTEMPTS_PER_SESSION = 3"));
    check("SDP-10 静态：无轮询（无 setInterval；恰一个 retry setTimeout）",
      !psrc.includes("setInterval") && (psrc.match(/setTimeout\(/g) || []).length === 1);
    check("SDP-11 静态：timer 与 resume 共享同一 runFreshAttempt/预算（resume 先清 timer）",
      (psrc.match(/runFreshAttempt\(/g) || []).length >= 4 &&
      psrc.indexOf('App.addListener("resume"') > 0 &&
      /addListener\("resume"[\s\S]{0,400}clearTimeout\(freshRetryTimer\)/.test(psrc));
    check("SDP-13 retry 仅限 transport 类失败（4xx/解析失败不重试）",
      psrc.includes("isTransportRetryable") &&
      psrc.includes("e.status >= 500 || e.status === 429") &&
      psrc.includes("unexpected token"));
  }

  check("SUC20-10 cache 快路径尊重安全门（dismissed/在首页/无弹窗才弹，busy 不抢）",
    appSrc.includes("startupUpdateCtrl.flags().dismissed") &&
    appSrc.includes("startupCachePromptShown") &&
    appSrc.includes('currentViewId() !== "view-menu" || Modal.isOpen()'));
}

/* ---------- SIMPLIFY_CAPTURE_FLOW_V1：界面收口 + 后台 best-effort 采集（CAP 系列） ---------- */
section("拍摄流程收口与样本静默化（CAP 系列，源码守卫 + 纯函数）");
{
  const indexSrc = fs.readFileSync(path.join(__dirname, "www/index.html"), "utf8");
  const pluginSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueuePlugin.java"), "utf8");
  const modelSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueueModel.java"), "utf8");

  /* —— UI16-1 首页无「拍整页搜题」大按钮；UI16-2 搜题页相机仍直拍 —— */
  check("UI16-1 首页相机入口已删除（VC16），只保留搜题入口",
    !appSrc.includes("btn-camera-entry") && !appSrc.includes("拍整页搜题") &&
    appSrc.includes('searchBtn.id = "btn-search-entry";'));
  check("UI16-2 搜题框右侧相机仍直接调用 startBatchPageSearch",
    appSrc.includes('$("btn-batch-photo").addEventListener("click", startBatchPageSearch);'));

  /* —— CAP-S2 不再导航到旧整页拍照页面 —— */
  check("CAP-S2a index.html 已删除 view-batch-photo 中转页",
    !indexSrc.includes("view-batch-photo") && !indexSrc.includes("btn-take-page") &&
    !indexSrc.includes("batch-type-row"));
  check("CAP-S2b app.js 不再出现旧页面导航/选择器代码",
    !appSrc.includes('show("view-batch-photo")') && !appSrc.includes("openBatchPhoto") &&
    !appSrc.includes("initBatchTypes") && !appSrc.includes("handleBatchBack") &&
    !appSrc.includes("batchPageType"));

  /* —— CAP-S3 相机取消回入口页（menu 入口 = 首页） —— */
  check("CAP-S3 相机取消：非权限错误静默回入口页，权限错误 Modal 提示",
    appSrc.includes("var captureOriginView") &&
    appSrc.includes("captureOriginView = (currentViewId() === \"view-search\") ? \"view-search\" : \"view-menu\";") &&
    appSrc.includes("show(captureOriginView);") &&
    appSrc.includes("/permission|denied/i.test(msg)") &&
    appSrc.includes('Modal.alert("无法使用相机", "请授予相机权限后重试");'));

  /* —— CAP-S4 AUTO_PAGE_TYPE 固定生效 —— */
  check("CAP-S4 拍摄固定 AUTO（recompute 传 \"auto\"，pageTypeMode 恒 auto，无拍摄前选择）",
    appSrc.includes('MSQ.recomputePageFromLines(batchIndex, lines, "auto",') &&
    appSrc.includes('pageTypeMode: "auto"') && !appSrc.includes("batch-type-row"));

  /* —— CAP-S5 结果页题型人工纠错保留 —— */
  check("CAP-S5 结果页仍可切题型重算（switchBatchPageType/buildBatchTypeLine 完整，零重新 OCR）",
    appSrc.includes("function switchBatchPageType(mode)") &&
    appSrc.includes("function buildBatchTypeLine(state)") &&
    appSrc.includes('["auto", "single", "multi", "judge"].forEach'));

  /* —— CAP-S6 sample 仍后台自动 persist（无 opt-out） —— */
  check("CAP-S6 collectAndUploadSample 无条件持久化（无 shouldCollect 分支）",
    appSrc.includes("Queue.persistSample({") &&
    !/shouldCollect\(/.test(appSrc) &&
    appSrc.indexOf("lastSampleUpload = {") < appSrc.indexOf("Queue.persistSample({"));

  /* —— CAP-S7 COS queue 仍自动处理（worker 链路零改动） —— */
  check("CAP-S7 原生 worker 链路未动（init 恢复 + startWorker + processSample 三步直传）",
    pluginSrc.includes("SampleQueueModel.normalizeStatusOnBoot") &&
    pluginSrc.includes("private void startWorker()") &&
    pluginSrc.includes('serverUrl + "/api/sample/init"') &&
    pluginSrc.includes('serverUrl + "/api/sample/commit"'));

  /* —— CAP-S8/9/10 样本失败完全静默且不影响拍题主链 —— */
  check("CAP-S8 collectAndUploadSample 整体 try/catch 兜底（样本异常不可能打断拍题）",
    appSrc.indexOf("function collectAndUploadSample(state)") > 0 &&
    /function collectAndUploadSample\(state\) \{\s*\n\s*renderSampleFeedbackVisibility\(\);\s*\n\s*try \{/.test(appSrc));
  check("CAP-S9 持久化失败无任何 UI 提示（仅 console 诊断）",
    !appSrc.includes("本页样本未能保存") &&
    !/persistSample[\s\S]{0,600}showFeedbackToast/.test(appSrc) &&
    appSrc.includes('sampleDebug("persist failed (silent): "'));
  check("CAP-S9b 旧状态行/清理按钮/测试连接/采集面板代码已全部移除",
    !appSrc.includes("renderQueueStatus") && !appSrc.includes("cleanupFailedSamples") &&
    !appSrc.includes("btn-sample-cleanup") && !appSrc.includes("btn-sample-test") &&
    !appSrc.includes("sample-queue-status") && !appSrc.includes("setBatchStatus"));
  check("CAP-S10 原生侧无 Toast/通知（上传失败只改状态后台重试）",
    !pluginSrc.includes("android.widget.Toast") && !pluginSrc.includes("NotificationManager"));

  /* —— CAP-S11 feedback 持久化协议不退化 —— */
  check("CAP-S11 persistFeedback 仍走本地队列补传，失败仅 console（提交动作 UI 不变）",
    appSrc.includes("Queue.persistFeedback({") &&
    appSrc.includes('sampleDebug("feedback persist failed (silent): "') &&
    !/persistFeedback[\s\S]{0,600}showFeedbackToast\("反馈保存失败/.test(appSrc));

  /* —— CAP-S17/18 普通 UI 无任何 sample 配置与域名 —— */
  check("CAP-S17 index.html 无样本采集配置区",
    !indexSrc.includes("sample-panel") && !indexSrc.includes("sample-enabled") &&
    !indexSrc.includes("测试样本采集") && !indexSrc.includes("自动上传测试样本") &&
    !indexSrc.includes("同步状态"));
  check("CAP-S18 UI 不含服务器/CDN/COS 域名",
    !indexSrc.includes("shiinalab") && !appSrc.includes("shiinalab") &&
    !indexSrc.includes("apk.shiinalab") && !indexSrc.includes("update.shiinalab"));

  /* —— DIAG 系列：DEV 隐藏诊断入口 = 检查更新页「当前版本」整行 7 连击 —— */
  check("DIAG-1/2 更新页当前版本整行绑定 7 连击（仅 dev 渠道；块级整行可点）",
    appSrc.includes('MSQSample.diagnosticsChannel(updateInfo.id) === "dev"') &&
    appSrc.indexOf('renderUpdateView("当前版本："') < appSrc.indexOf("bindDevDiagTap(statusEl)") &&
    appSrc.includes("function bindDevDiagTap(el)") &&
    appSrc.includes("devDiagTaps.count >= 7"));
  check("DIAG-3/4 计数逻辑：>=7 才进入，超 3 秒重置",
    appSrc.includes("now - devDiagTaps.firstAt > 3000") &&
    appSrc.includes("if (devDiagTaps.count >= 7) {"));
  check("DIAG-5 MAIN 不绑定手势（diagnosticsChannel 非 dev 直接跳过）",
    appSrc.includes('=== "dev"') && appSrc.includes("bindDevDiagTap(statusEl)") &&
    MSQSample.diagnosticsChannel("com.jty.safetyquiz") === "stable" &&
    MSQSample.diagnosticsChannel("com.other.app") === null);
  check("DIAG-6 诊断页 Back → 检查更新页（按钮与系统 Back 同路）",
    appSrc.includes('$("btn-devdiag-back").addEventListener("click", function () { openUpdateView(); });') &&
    appSrc.includes('case "view-devdiag": openUpdateView(); return;'));
  check("DIAG-7 首页不再存在诊断版本行（menu-version 全删）",
    !indexSrc.includes("menu-version") && !appSrc.includes("menu-version") &&
    !appSrc.includes("initDevDiagnostics"));

  /* —— DIAG17：诊断页显示层全中文（VC17；底层 enum 不动） —— */
  check("DIAG17-2 状态 enum 中文映射纯函数（内部值不变，含 auth_failed 别名）",
    MSQSample.diagnosticStatusLabel("pending") === "待上传" &&
    MSQSample.diagnosticStatusLabel("retry_wait") === "等待重试" &&
    MSQSample.diagnosticStatusLabel("uploading") === "正在上传" &&
    MSQSample.diagnosticStatusLabel("capture_uploaded") === "照片已上传" &&
    MSQSample.diagnosticStatusLabel("synced") === "已同步" &&
    MSQSample.diagnosticStatusLabel("failed") === "失败" &&
    MSQSample.diagnosticStatusLabel("auth_failed") === "需要重新绑定" &&
    MSQSample.diagnosticStatusLabel("auth_required") === "需要重新绑定");
  check("DIAG17-2b 反馈同步状态中文映射", MSQSample.feedbackSyncLabel(0) === "已同步" &&
    MSQSample.feedbackSyncLabel(2) === "待上传 ×2");
  {
    const ddIdx = appSrc.indexOf("function renderDevDiagnostics()");
    const dd = appSrc.slice(ddIdx, appSrc.indexOf("/* ---------------- 应用内自更新", ddIdx));
    check("DIAG17-1 诊断页渲染仅中文标签（旧英文标签全删）",
      dd.includes('"待上传样本"') && dd.includes('"等待重试"') && dd.includes('"上传失败"') &&
      dd.includes('"需要重新绑定"') && dd.includes('"队列占用空间"') &&
      dd.includes('"最老样本等待时间"') && dd.includes('"最近上传速度"') &&
      dd.includes('"上次自动清理"') && dd.includes('"上次清理样本数"') &&
      dd.includes('"上次释放空间"') && dd.includes('"最近反馈同步状态"') &&
      !dd.includes('"pending"') && !dd.includes('"retry_wait"') &&
      !dd.includes('"failed"') && !dd.includes('"queue total bytes"') &&
      !dd.includes('"oldest sample age"') && !dd.includes('"last janitor"') &&
      !dd.includes('"last feedback sync"') && !dd.includes('"Run janitor now"') &&
      !dd.includes('"Retry queue now"'));
    check("DIAG17-3 两个操作按钮中文（立即清理/立即重试）",
      dd.includes('"立即清理"') && dd.includes('"立即重试"'));
    check("DIAG17-1b 诊断页标题中文（开发者诊断）",
      indexSrc.includes("开发者诊断") && !indexSrc.includes("Developer Diagnostics"));
    check("DIAG17 诊断页不渲染任何域名/endpoint/objectKey",
      !dd.includes("shiinalab") && !dd.includes("objectKey") &&
      !dd.includes("presigned") && !dd.includes("serverUrl"));
  }

  /* —— UI16-4~9/13 启动更新 Modal（源码守卫；行为在 nav_test 实测） —— */
  {
    const mIdx = appSrc.indexOf("function showStartupUpdateModal");
    const modalFn = mIdx > 0
      ? appSrc.slice(mIdx, appSrc.indexOf("function handleUpdateBack", mIdx))
      : "";
    check("UI16-4 Modal 内容只有版本信息与简短 notes（≤60 字截断）",
      modalFn.includes('"发现新版本"') && modalFn.includes('"最新版本："') &&
      modalFn.includes("当前版本：") && modalFn.includes("notes.length > 60"));
    check("UI16-4b Modal 绝不含 apkUrl/fallback/域名/SHA/size/诊断字段",
      !/apkUrl|fallbackApkUrl|sha256|shiinalab|versionCode/.test(modalFn.replace(/[^;]*notes[^;]*;/g, "")) &&
      !modalFn.includes("manifest.size") && !modalFn.includes("manifest.sha256"));
    check("UI16-5 启动不再自动导航（controller 无 fresh showPrompt；cache 块防重入且只调 Modal）",
      !appSrc.includes("showPrompt: function (info, manifest) {") &&
      appSrc.includes("startupCachePromptShown") &&
      (() => {
        const cpIdx = appSrc.indexOf("startupCachePromptShown = true;");
        if (cpIdx < 0) { return false; }
        const body = appSrc.slice(cpIdx, cpIdx + 400);
        return body.includes("showStartupUpdateModal(r.info, r.cached.manifest);") &&
          !body.includes('show("') && !body.includes("renderMenu");
      })() &&
      !modalFn.includes('show("') && !modalFn.includes("renderMenu"));
    check("UI16-6 稍后 = 仅关闭 Modal 留在当前页（不导航）",
      /稍后[^;]*barbtn cancel[^;]*function \(\) \{ Modal\.close\(\); \}/.test(modalFn.replace(/\r?\n/g, "")));
    check("UI16-7/8 任何关闭路径都 markDismissed（本 session 不再弹；Back=稍后）",
      modalFn.includes("Modal.onClose = function () {") &&
      modalFn.includes("markDismissed()") &&
      appSrc.includes("var cb = this.onClose;") &&
      appSrc.includes("if (Modal.isOpen()) { Modal.close(); return; }"));
    check("UI16-9 立即更新 → openUpdateView(true)（autostart 复用既有 checkForUpdate/下载链）",
      modalFn.includes("openUpdateView(true)") &&
      appSrc.includes("if (autostart === true) { checkForUpdate(); }") &&
      appSrc.includes('$("btn-update").addEventListener("click", function () { openUpdateView(); });'));
    check("UI16-13 抢操作守卫：cache prompt 门仍是「首屏 + 无弹窗」（fresh 路径已静默）",
      appSrc.includes('currentViewId() !== "view-menu" || Modal.isOpen()'));
    check("UI16 遮罩不关闭（modal-root 无点击关闭处理器）",
      !appSrc.includes('this.root.addEventListener("click"') &&
      !/modal-root[\s\S]{0,120}addEventListener\("click"/.test(appSrc));
  }
  check("CAP-S20b 诊断内容守卫：无 token/URL/Authorization 字段",
    !appSrc.includes("presignedPutUrl") && !appSrc.includes("Authorization") &&
    !appSrc.includes("MSQ_SAMPLE_WRITE_TOKEN") &&
    pluginSrc.includes("public void getDiagnostics"));

  /* —— Janitor 调度守卫（逻辑在 JVM：SampleQueueJanitorTest） —— */
  check("CAP-JAN 调度三时机：cold init / worker 空转 / runJanitorNow（均串行于 worker 线程）",
    /workerExecutor\.execute[\s\S]{0,120}runJanitor\(false\)/.test(pluginSrc) &&
    pluginSrc.includes("runJanitor(false);\n                return;") &&
    pluginSrc.includes("public void runJanitorNow") &&
    modelSrc.includes("JANITOR_MIN_INTERVAL_MS") &&
    modelSrc.includes("QUEUE_HARD_LIMIT_BYTES = 256L * 1024 * 1024") &&
    modelSrc.includes("JANITOR_FAILED_RETENTION_MS = 7L * 24 * 3600 * 1000") &&
    modelSrc.includes("JANITOR_PENDING_RETENTION_MS = 14L * 24 * 3600 * 1000"));
}

/* ---------- APK_CDN_STABILITY_DIAG_V1：下载链路诊断（CDN-D 系列） ---------- */
section("下载诊断：apk-download-diag.js（CDN-D 系列，纯函数）");
{
  const MSQDownloadDiag = require("./www/js/apk-download-diag.js");
  const st = memStore();

  /* CDN-D1 primary CDN success → transport=cdn */
  const d1 = MSQDownloadDiag.buildSuccessRecord({
    transport: "cdn", fallbackUsed: false, fallbackReason: null,
    result: { httpStatus: 200, bytes: 17211763, downloadMs: 12345, cacheStatus: "Cache Hit" }
  });
  check("CDN-D1 primary 成功 → transport=cdn / finalHost=CDN / cache=hit / ok=true",
    d1.apkDownloadTransport === "cdn" && d1.apkFinalHost === "CDN" &&
    d1.apkCacheStatus === "hit" && d1.downloadOk === true &&
    d1.apkHttpStatus === 200 && d1.apkFallbackUsed === false);

  /* CDN-D2 transport error → fallbackUsed=true（legacy 成功覆盖为最终态） */
  const d2fail = MSQDownloadDiag.buildFailureRecord({
    transport: "cdn", fallbackUsed: false,
    error: { code: "DOWNLOAD_FAILED", message: "下载失败：connect timeout" }
  });
  const d2ok = MSQDownloadDiag.buildSuccessRecord({
    transport: "legacy", fallbackUsed: true, fallbackReason: d2fail.apkFallbackReason,
    result: { httpStatus: 200, bytes: 17211763, downloadMs: 45678, cacheStatus: "Cache Hit" }
  });
  check("CDN-D2 回退链：cdn 失败后 legacy 成功 → transport=legacy / fallbackUsed=true",
    d2fail.downloadOk === false && d2ok.apkDownloadTransport === "legacy" &&
    d2ok.apkFallbackUsed === true && d2ok.apkFallbackReason === "DOWNLOAD_FAILED" &&
    d2ok.apkFinalHost === "Legacy");
  MSQDownloadDiag.save(st, d2ok);
  const d2loaded = MSQDownloadDiag.load(st);
  check("CDN-D2b 保存/加载往返一致（同 store key，最终态可回读）",
    d2loaded && d2loaded.apkDownloadTransport === "legacy" &&
    d2loaded.apkFallbackUsed === true && d2loaded.downloadOk === true);

  /* CDN-D3 HTTP 5xx → fallback reason recorded（仅 code+状态，无原始消息） */
  const d3 = MSQDownloadDiag.buildFailureRecord({
    transport: "cdn", fallbackUsed: false,
    error: { code: "HTTP_ERROR", message: "下载失败 HTTP 503" }
  });
  check("CDN-D3 HTTP 5xx → 原因记录含状态码（HTTP_ERROR HTTP 503），原始消息不留存",
    d3.apkFallbackReason === "HTTP_ERROR HTTP 503" && d3.apkHttpStatus === 503 &&
    d3.downloadOk === false && d3.apkDownloadBytes === null);

  /* CDN-D4 security mismatch → no fallback（记录保持 cdn + 失败） */
  const d4 = MSQDownloadDiag.buildFailureRecord({
    transport: "cdn", fallbackUsed: false,
    error: { code: "SHA_MISMATCH", message: "更新包校验失败（SHA256 不一致）" }
  });
  check("CDN-D4 安全校验失败 → 不回退（fallbackUsed=false，原因=SHA_MISMATCH）",
    d4.apkDownloadTransport === "cdn" && d4.apkFallbackUsed === false &&
    d4.apkFallbackReason === "SHA_MISMATCH" && d4.apkHttpStatus === null &&
    d4.apkFinalHost === "CDN");

  /* CDN-D5 legacy success → transport=legacy */
  const d5 = MSQDownloadDiag.buildSuccessRecord({
    transport: "legacy", fallbackUsed: true, fallbackReason: "DOWNLOAD_FAILED",
    result: { httpStatus: 200, bytes: 17193159, downloadMs: 30000, cacheStatus: undefined }
  });
  check("CDN-D5 legacy 成功 → transport=legacy / finalHost=Legacy",
    d5.apkDownloadTransport === "legacy" && d5.apkFinalHost === "Legacy" &&
    d5.downloadOk === true);

  /* CDN-D6 speed calculation correct */
  check("CDN-D6 速度计算：17211763B / 12345ms → 1394229 B/s",
    d1.apkBytesPerSec === Math.round(17211763 * 1000 / 12345) &&
    d1.apkBytesPerSec === 1394229);
  check("CDN-D6b 无耗时/零耗时 → 速度为 null（不伪造）",
    MSQDownloadDiag.buildSuccessRecord({
      transport: "cdn", fallbackUsed: false, fallbackReason: null,
      result: { httpStatus: 200, bytes: 100, downloadMs: 0, cacheStatus: "Cache Hit" }
    }).apkBytesPerSec === null);

  /* CDN-D7 diagnostics contains no credential / domain */
  const d7 = MSQDownloadDiag.sanitize({
    schemaVersion: 1, updatedAt: "2026-09-26T09:00:00.000Z", downloadOk: true,
    apkDownloadTransport: "cdn",
    apkFallbackReason: "Unknown host apk.shiinalab.top with token=abc",
    apkHttpStatus: "https://evil.example/snimische",
    someUnknownKey: "should be dropped",
    apkFinalHost: "CDN"
  });
  const d7text = JSON.stringify(d7);
  check("CDN-D7 黑名单子串（域名/URL/token）全部过滤，未知键丢弃",
    !d7text.includes("shiinalab") && !d7text.includes("https://") &&
    !d7text.includes("token") && !("someUnknownKey" in d7) &&
    d7.apkFallbackReason === "[filtered]" && d7.apkHttpStatus === "[filtered]");
  check("CDN-D7b FORBIDDEN 黑名单覆盖任务要求项",
    ["apk.shiinalab.top", "update.shiinalab.top", "authorization", "secret",
      "presigned", "cookie"].every((f) => MSQDownloadDiag.FORBIDDEN.indexOf(f) >= 0));

  /* CDN-D8 cache status unknown handled safely */
  check("CDN-D8 缓存状态解析：明确 indicator 才映射，缺失/未知 → unknown",
    MSQDownloadDiag.normalizeCacheStatus(undefined) === "unknown" &&
    MSQDownloadDiag.normalizeCacheStatus(null) === "unknown" &&
    MSQDownloadDiag.normalizeCacheStatus("") === "unknown" &&
    MSQDownloadDiag.normalizeCacheStatus("Cache Hit") === "hit" &&
    MSQDownloadDiag.normalizeCacheStatus("Cache Miss") === "miss" &&
    MSQDownloadDiag.normalizeCacheStatus("X-Whatever") === "unknown" &&
    d5.apkCacheStatus === "unknown");

  /* native 侧诊断字段守卫（无 URL/域名落盘） */
  const updSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/UpdatePlugin.java"), "utf8");
  check("CDN-D9 native resolve 携带非敏感诊断字段 + X-Cache-Lookup 解析，不含域名/URL",
    updSrc.includes('ret.put("httpStatus", status)') &&
    updSrc.includes('ret.put("downloadMs", downloadMs)') &&
    updSrc.includes('ret.put("bytesPerSec"') &&
    updSrc.includes('ret.put("cacheStatus", cacheStatus)') &&
    updSrc.includes('getHeaderField("X-Cache-Lookup")') &&
    !updSrc.includes("shiinalab") && !/ret\.put\("(url|host|finalHost)"/.test(updSrc));
  check("CDN-D9b 诊断模块已接入 app.js 下载链路与 DEV 诊断页（仅 DEV 可见）",
    appSrc.includes("diag.buildSuccessRecord({") && appSrc.includes("diag.buildFailureRecord({") &&
    appSrc.includes('groups[4].rows.push(["最近下载来源"') &&
    appSrc.includes('groups[4].rows.push(["是否发生回退"'));
}

/* ---------- DEV_TO_MAIN_SYNC_V1：MAIN/STABLE 构建边界守卫（MAIN-1~8） ---------- */
section("MAIN/STABLE 构建边界（DEV_TO_MAIN_SYNC_V1，MAIN-1~8）");
{
  const gradleSrc = fs.readFileSync(path.join(__dirname, "android/app/build.gradle"), "utf8");
  const mainStrings = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/res/values/strings.xml"), "utf8");
  const devStrings = fs.readFileSync(path.join(__dirname,
    "android/app/src/dev/res/values/strings.xml"), "utf8");
  const pubSrc = fs.readFileSync(path.join(__dirname, "tools/dev_update/publish.js"), "utf8");
  const cospubSrc = fs.readFileSync(path.join(__dirname, "tools/dev_update/cos_publish.js"), "utf8");
  const indexSrcMain = fs.readFileSync(path.join(__dirname, "www/index.html"), "utf8");

  check("MAIN-1 stable package id 正确（defaultConfig 无后缀，.dev 仅在 dev buildType）",
    gradleSrc.includes('applicationId "com.jty.safetyquiz"') &&
    gradleSrc.includes("applicationIdSuffix '.dev'") &&
    !/applicationId\s+"com\.jty\.safetyquiz\.dev"/.test(gradleSrc));
  check("MAIN-2 stable label 正确（main=营销安规刷题，dev overlay=营销安规刷题 DEV）",
    mainStrings.includes(">营销安规刷题<") &&
    !mainStrings.includes("营销安规刷题 DEV") &&
    devStrings.includes(">营销安规刷题 DEV<"));
  check("MAIN-3 stable 渠道 DEV diagnostics 无入口（diagnosticsChannel=stable 不绑定手势）",
    MSQSample.diagnosticsChannel("com.jty.safetyquiz") === "stable" &&
    MSQSample.diagnosticsChannel("com.jty.safetyquiz.dev") === "dev" &&
    appSrc.includes('diagnosticsChannel(updateInfo.id) === "dev"'));
  check("MAIN-4 sample config UI 不存在（stable 与 dev 共用同一收口后 UI）",
    !indexSrcMain.includes("sample-panel") && !indexSrcMain.includes("自动上传测试样本") &&
    !indexSrcMain.includes("测试连接") && !indexSrcMain.includes("sample-enabled"));
  check("MAIN-5 AUTO sample collection 生效（shouldCollect 恒 ON）",
    MSQSample.shouldCollect() === true);
  {
    const dbgStart = gradleSrc.indexOf("debug {");
    const devStart = gradleSrc.indexOf("dev {");
    const dcStart = gradleSrc.indexOf("defaultConfig {");
    const dcEnd = gradleSrc.indexOf("buildFeatures {");
    check("MAIN-6 DEV_ARM64_ONLY 仅作用于 dev buildType（stable 保持全 ABI）",
      dbgStart > 0 && devStart > dbgStart &&
      gradleSrc.slice(dbgStart, devStart).indexOf("DEV_ARM64_ONLY") < 0 &&
      gradleSrc.slice(dbgStart, devStart).indexOf("abiFilters") < 0 &&
      dcStart > 0 && dcEnd > dcStart &&
      gradleSrc.slice(dcStart, dcEnd).indexOf("abiFilters") < 0 &&
      gradleSrc.slice(devStart).indexOf('project.findProperty("DEV_ARM64_ONLY")') >= 0);
    check("R8/shrinkResources 为共享能力（stable 发布路径 debug buildType 同样启用）",
      gradleSrc.slice(dbgStart, devStart).includes("minifyEnabled true") &&
      gradleSrc.slice(dbgStart, devStart).includes("shrinkResources true") &&
      gradleSrc.slice(dbgStart, devStart).includes("proguardFiles"));
  }
  check("MAIN-7 stable updater 走 stable 渠道（updateChannelFor 映射正确）",
    MSQUpdater.updateChannelFor("com.jty.safetyquiz") === "stable" &&
    MSQUpdater.updateChannelFor("com.jty.safetyquiz.dev") === "dev");
  check("MAIN-8 stable 发布路径不使用 /dev/（渠道配置互相隔离）",
    pubSrc.includes('cosPrefix: "stable"') && pubSrc.includes('cosPrefix: "dev"') &&
    pubSrc.includes('fallbackApkUrl: "/api/update/stable/apk"') &&
    pubSrc.includes('fallbackApkUrl: "/api/update/dev/apk"') &&
    pubSrc.includes('updatesDir: path.join(ROOT, "release", "updates", "stable")') &&
    cospubSrc.includes("channelCosPrefix") &&
    cospubSrc.includes('"stable/v" + vc + "/msq-stable-v" + vc + ".apk"'));
  const serverSrcMain = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/server.js"), "utf8");
  check("MAIN-8b server 双渠道隔离（stable 读 updates/stable/营销安规刷题.apk）",
    serverSrcMain.includes('dev: "营销安规刷题-DEV.apk"') &&
    serverSrcMain.includes('stable: "营销安规刷题.apk"'));

  /* —— STP：channel-aware publisher（STABLE_RELEASE_PIPELINE_V1，源码守卫） —— */
  check("STP-1/2 publisher 渠道配置：stable package/label 正确且与 dev 隔离",
    pubSrc.includes('packageName: "com.jty.safetyquiz"') &&
    pubSrc.includes('label: "营销安规刷题"') &&
    pubSrc.includes('packageName: "com.jty.safetyquiz.dev"') &&
    pubSrc.includes('label: EXPECTED_LABEL'));
  check("STP-3 stable ABI 核验要求全 4 ABI（build 后 aapt 实测）",
    pubSrc.includes("REQUIRED_STABLE_ABIS = [\"'arm64-v8a'\", \"'armeabi-v7a'\", \"'x86'\", \"'x86_64'\"]") &&
    pubSrc.includes("stable 全 ABI 核验失败"));
  check("STP 版本注入：STABLE_VERSION_CODE/NAME 仅 debug buildType，无 -dev 后缀追加",
    gradleSrc.includes('withBuildType("debug")') &&
    gradleSrc.includes("STABLE_VERSION_CODE") &&
    !/STABLE_VERSION_NAME[^\n]*-dev/.test(gradleSrc));
  check("STP-8~11 fail-closed：stable 复用同一 releaseApk/cospublish 状态机",
    pubSrc.includes('channel: o.channel === "stable" ? "stable" : "dev"') &&
    cospubSrc.includes('deps.channel === "stable"') &&
    pubSrc.includes("stable versionCode 必须 > 现有 latest 的"));
  check("STP-12 期望包名前置校验在发布主链",
    pubSrc.includes("expectedPackageName: channel.packageName") &&
    cospubSrc.includes("packageName mismatch"));
  check("STP-14 secret scan 在发布主链（失败即拒绝，凭据值不打印）",
    pubSrc.includes("loadSecretScanForbidden()") &&
    pubSrc.includes("secretScanApk(apkBytes") &&
    pubSrc.includes("secret scan 失败") &&
    /* 只允许打印模式数量（scanForbidden.length），禁止打印任何单个凭据值 */
    !/console\.(log|error)\([^)]*scanForbidden\[[^\]]*\]/.test(pubSrc));
  check("STP dry-run：不上传、不写 latest.json（本地校验完成后即返回）",
    pubSrc.includes("args.dryRun") && pubSrc.includes("== DRY-RUN 完成 ==") &&
    pubSrc.indexOf("args.dryRun") < pubSrc.indexOf("const rel = await releaseApk"));
}

/* ---------- REAL_SAMPLE_FEEDBACK_V2：反馈状态与 payload 纯函数 ---------- */
section("样本反馈：状态绑定 sampleId（FB-P 系列，纯函数）");
{
  const A = "20260924_100000_aa11aa";
  const B = "20260924_100001_bb22bb";
  let stA = MSQSample.feedbackInitialState();
  check("FB-P1 新 sample 初始未反馈",
    stA.pageTypes.length === 0 && Object.keys(stA.blocks).length === 0);
  const opSet = MSQSample.buildPageFeedbackRequest(A, ["missing_question", "other"]);
  check("FB-P set 请求结构（action/scope/issueTypes）",
    opSet.action === "set" && opSet.scope === "page" &&
    opSet.issueTypes.join() === "missing_question,other");
  stA = MSQSample.applyFeedbackToState(stA, opSet);
  check("FB-P2 提交后 A 已反馈（2 项，排序去重）",
    stA.pageTypes.join() === "missing_question,other");
  const stA2 = MSQSample.applyFeedbackToState(stA,
    MSQSample.buildPageFeedbackRequest(A, ["missing_question", "other"]));
  check("FB-P7 重复 set 同 issue 不产生重复",
    stA2.pageTypes.join() === "missing_question,other");
  const stB = MSQSample.feedbackInitialState();
  check("FB-P3/P4 新 sample B 初始未反馈，A 的反馈不污染 B",
    stB.pageTypes.length === 0 && stA.pageTypes.length === 2);
  const stA3 = MSQSample.applyFeedbackToState(stA,
    MSQSample.buildPageFeedbackRequest(A, ["other"]));
  check("FB-P5 修改反馈 = 全量替换",
    stA3.pageTypes.join() === "other" && stA.pageTypes.length === 2);
  const stA4 = MSQSample.applyFeedbackToState(stA3, MSQSample.buildPageClearRequest(A));
  check("FB-P6 清除反馈 → pageIssues 清空", stA4.pageTypes.length === 0);

  const block = { screenNumber: "27", rawScreenNumber: "27", numberSource: "ocr",
    type: "single", answer: "A", confidence: "low", bankId: 123,
    matches: [{ id: 123 }, { id: 5 }, { id: 9 }], matchesAssisted: false };
  block.matches.assistedByOptions = false;
  const setOp = MSQSample.buildBlockFeedbackRequest(A, "set", 2, block);
  check("FB-B4 block payload 字段完整且不猜正确答案",
    setOp.action === "set" && setOp.scope === "block" && setOp.issue === "wrong_answer" &&
    setOp.blockIndex === 2 && setOp.block.screenNumber === "27" &&
    setOp.block.finalAnswer === "A" && setOp.block.confidence === "low" &&
    setOp.block.finalBankId === 123 && setOp.block.matchedByOptions === false &&
    setOp.block.rawScreenNumber === "27" && setOp.block.numberSource === "ocr");
  check("FB-B4 不包含 Top2/candidate 等被猜测的真值字段",
    setOp.block.expectedAnswer === undefined && setOp.block.expectedBankId === undefined);
  let stB2 = MSQSample.feedbackInitialState();
  stB2 = MSQSample.applyFeedbackToState(stB2, setOp);
  check("FB-B1 block set 后状态已标错", stB2.blocks["2:wrong_answer"] === true);
  stB2 = MSQSample.applyFeedbackToState(stB2,
    MSQSample.buildBlockFeedbackRequest(A, "set", 3, block));
  check("FB-B3 block3 标错不影响 block2",
    stB2.blocks["2:wrong_answer"] === true && stB2.blocks["3:wrong_answer"] === true);
  stB2 = MSQSample.applyFeedbackToState(stB2,
    MSQSample.buildBlockFeedbackRequest(A, "remove", 2, null));
  check("FB-B2 remove 撤销 block2",
    stB2.blocks["2:wrong_answer"] === undefined && stB2.blocks["3:wrong_answer"] === true);
  check("非法 op 被拒绝（不应用）",
    !MSQSample.isValidFeedbackOp({ action: "set", scope: "page", sampleId: A, issueTypes: ["nope"] }) &&
    !MSQSample.isValidFeedbackOp({ action: "set", scope: "block", sampleId: A, issue: "wrong_answer", blockIndex: -1, block: {} }) &&
    !MSQSample.isValidFeedbackOp({ action: "nope", scope: "page", sampleId: A }));
}

section("持久化队列：公网固定 endpoint（源码守卫）");
{
  const joined = ["www/js/sample-collector.js", "www/js/updater.js", "www/js/app.js"]
    .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  check("业务 JS 无内网地址/端口残留",
    !joined.includes("192.168.") && !joined.includes(":8787"));
  check("业务 JS 无 LAN fallback / 自动发现逻辑",
    !joined.includes("lanFallback") && !joined.includes("discoverLan"));
  check("默认 sample/update endpoint 均为 update.shiinalab.top",
    MSQSample.PUBLIC_BASE_URL === "https://update.shiinalab.top" &&
    MSQUpdater.PUBLIC_BASE_URL === "https://update.shiinalab.top");
}

/* ---------- QUEUE_RECOVERY_AND_CLEANUP_V1：恢复与清理（源码/结构守卫） ---------- */
section("队列恢复与清理：generation 与 cleanup 守卫");
{
  const pluginSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueuePlugin.java"), "utf8");
  check("REC-S1 启动恢复调用 shouldAutoRecoverAuthFailed（generation 判定）",
    pluginSrc.includes("shouldAutoRecoverAuthFailed(st, authGeneration())"));
  check("CLEAN-S1 cleanupFailed 只允许 failed/auth_failed（源码白名单）",
    pluginSrc.includes("STATUS_FAILED.equals(status)") &&
    pluginSrc.includes("STATUS_AUTH_FAILED.equals(status)") &&
    pluginSrc.indexOf("cleanupFailed") > 0);
  const cleanupFn = pluginSrc.slice(pluginSrc.indexOf("public void cleanupFailed"));
  check("CLEAN-S2 非失败状态不被清理路径触碰（cleanupEligible 白名单语义）",
    cleanupFn.includes("cleanupEligible") &&
    !cleanupFn.includes("STATUS_PENDING.equals(cleanupStatus)") &&
    !cleanupFn.includes("STATUS_UPLOADING.equals(cleanupStatus)") &&
    !cleanupFn.includes("STATUS_RETRY_WAIT.equals(cleanupStatus)"));
  check("AUTH-GEN BuildConfig 字段已声明（非秘密整数）",
    fs.readFileSync(path.join(__dirname, "android/app/build.gradle"), "utf8")
      .includes("MSQ_SAMPLE_AUTH_GENERATION"));
}

/* ---------- R2_FAST_TRANSFER_V1：大文件数据面迁移（源码/结构守卫） ---------- */
section("R2 直传：客户端只用 init→PUT→commit，且不落盘 presigned URL");
{
  const pluginSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueuePlugin.java"), "utf8");
  const modelSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueueModel.java"), "utf8");

  check("R2-Q1 新客户端不再调用 legacy POST /api/sample（只走 init/commit）",
    !pluginSrc.includes('"/api/sample"') &&
    pluginSrc.includes("/api/sample/init") &&
    pluginSrc.includes("/api/sample/commit"));

  const psStart = pluginSrc.indexOf("private void processSample");
  const processSample = pluginSrc.slice(psStart, pluginSrc.indexOf("private String readRevision"));
  check("R2-Q2 capture 以原生文件流直传（不整图进内存、不 base64）",
    processSample.includes("httpPutFile(putUrl, capture") &&
    !/readFile\(new File\(dir, CAPTURE_NAME\)\)/.test(processSample) &&
    !processSample.includes("Base64"));
  check("R2-Q3 presigned URL 只在内存使用，绝不写入 state.json",
    !/put\("presigned/.test(pluginSrc));
  check("R2-Q4 直传目标必须是 https（拒绝明文上传）",
    pluginSrc.includes('startsWith("https://")'));
  check("R2-Q5 直传 PUT 不附加 Authorization（会破坏 presigned 签名）",
    !/httpPutFile[\s\S]{0,1600}Authorization/.test(pluginSrc));
  check("R2-Q6 上传失败只改状态，绝不删除本地样本",
    !/\.delete\(\)/.test(pluginSrc.slice(pluginSrc.indexOf("private void recordFailure"),
      pluginSrc.indexOf("private void recordFailure") + 1200)));
  check("R2-Q7 队列状态机含 R2 中间态与直传进度字段",
    modelSrc.includes("STATUS_UPLOADING_CAPTURE") &&
    modelSrc.includes("STATUS_CAPTURE_UPLOADED") &&
    modelSrc.includes("captureObjectKey") &&
    modelSrc.includes("captureUploaded") &&
    modelSrc.includes("sampleCommitted"));
  check("R2-Q8 启动恢复把 R2 中间态回落 pending（不假设 PUT 已完成）",
    modelSrc.includes("STATUS_UPLOADING_CAPTURE.equals(status)") &&
    modelSrc.includes("STATUS_CAPTURE_UPLOADED.equals(status)"));
}

section("R2 直传：Collector 侧 objectKey 由服务器派生 + 短时效 presign");
{
  const storeSrc = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/r2_store.js"), "utf8");
  const serverSrc = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/server.js"), "utf8");
  const r2Src = fs.readFileSync(path.join(__dirname, "tools/r2/r2.js"), "utf8");

  check("R2-Q9 objectKey 由 sampleId 服务器派生（samples/<date>/<id>/capture.jpg）",
    storeSrc.includes('"samples/" + date + "/" + sampleId + "/" + CAPTURE_NAME'));
  check("R2-Q10 commit 校验 objectKey 必须等于服务器派生值",
    storeSrc.includes("objectKey !== expectedKey"));
  check("R2-Q11 commit 只做 HeadObject，不同步下载 JPEG 校验",
    storeSrc.includes("headObject") &&
    !/commitSample[\s\S]{0,4000}getObjectToFile/.test(storeSrc));
  check("R2-Q12 presigned TTL 默认 300 秒（短时效）",
    storeSrc.includes("DEFAULT_PRESIGN_TTL_SECONDS = 300"));
  check("R2-Q13 presign 是 PUT-only 的 SigV4 query 签名",
    r2Src.includes('"PUT", canonicalUri, canonicalQuery') &&
    r2Src.includes("UNSIGNED-PAYLOAD"));
  check("R2-Q14 R2 未配置时 init/commit FAIL CLOSED（503，不降级为隧道大文件）",
    serverSrc.includes("sample upload backend unavailable"));
  check("R2-Q15 legacy /api/sample 仍在（旧客户端平滑 OTA 兼容一代）",
    serverSrc.includes('p === "/api/sample"'));
  check("R2-Q16 镜像 worker 在 commit 响应路径之外（后台，不阻塞手机）",
    storeSrc.includes("function kickMirror") &&
    storeSrc.includes("setImmediate") &&
    storeSrc.includes("function whenMirrorIdle"));
}

section("R2 直传：APK 发布路径与缓存策略守卫");
{
  const publishSrc = fs.readFileSync(path.join(__dirname,
    "tools/dev_update/publish.js"), "utf8");
  const r2PubSrc = fs.readFileSync(path.join(__dirname,
    "tools/dev_update/r2_publish.js"), "utf8");
  const serverSrc = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/server.js"), "utf8");

  check("R2-Q17 APK 对象 key 按 versionCode 唯一（无覆盖式固定名）",
    r2PubSrc.includes('APK_PREFIX + "/vc" + vc + "/MarketingSafetyQuiz-dev-vc" + vc + ".apk"'));
  check("R2-Q18 APK 使用 immutable 长缓存",
    r2PubSrc.includes("public, max-age=31536000, immutable"));
  check("R2-Q19 发布验证不整包下载（Range 冒烟上限 1MB）",
    r2PubSrc.includes("SMOKE_RANGE_BYTES = 1024 * 1024") &&
    r2PubSrc.includes("abortAfterBytes"));
  check("R2-Q20 latest.json 在 R2 上传+验证之后才写（APK 先可用）",
    publishSrc.indexOf("await r2publish.publishApk") > 0 &&
    publishSrc.indexOf("writeAtomic(paths.latestJson") >
      publishSrc.indexOf("await r2publish.publishApk"));
  check("R2-Q21 prune 保留最新 3 个且保护 current latest",
    publishSrc.includes("DEV_APK_KEEP_COUNT = 3") &&
    r2PubSrc.includes("v.versionCode === Number(currentVersionCode)"));
  check("R2-Q22 latest.json 仍由 Collector 提供且 no-store（不经 R2 缓存）",
    serverSrc.includes('"Cache-Control": "no-store"'));
}

section("R2 secret 静态扫描：仓库内不得出现真实 credential");
{
  /* 只扫「形态」：AWS/R2 风格 access key id 与「被赋了真实值的 env 变量」。
     命中时只报告文件名，绝不打印匹配到的值本身。 */
  const roots = ["www", "tools", "android/app/src", "test_core.js", "README.md", ".gitignore"];
  const files = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      if (/node_modules|[\\/]build[\\/]|[\\/]\.git|[\\/]_build|[\\/]release|[\\/]real_samples|[\\/]_local/.test(p)) { return; }
      fs.readdirSync(p).forEach((n) => walk(path.join(p, n)));
      return;
    }
    if (/\.(js|json|java|html|css|md|bat|txt|example)$/.test(p)) { files.push(p); }
  };
  roots.forEach((r) => walk(path.join(__dirname, r)));

  const awsKeyHits = [];
  const assignedSecretHits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) { awsKeyHits.push(path.relative(__dirname, f)); }
    const m = /R2_SECRET_ACCESS_KEY\s*[=:]\s*["']?([A-Za-z0-9+/=_-]{16,})/.exec(text);
    if (m && !/^(your|REPLACE|CHANGE|xxx|\.\.\.)/i.test(m[1])) {
      assignedSecretHits.push(path.relative(__dirname, f));
    }
  }
  check("R2-P3b 无 AWS/R2 风格 access key id 硬编码", awsKeyHits.length === 0,
    awsKeyHits.join(","));
  check("R2-P3c 无被赋真实值的 R2_SECRET_ACCESS_KEY", assignedSecretHits.length === 0,
    assignedSecretHits.join(","));
  check("R2-P3d .env.r2.local 已被 .gitignore 排除",
    fs.readFileSync(path.join(__dirname, ".gitignore"), "utf8").includes(".env.r2.local"));
}

section("COS_SAMPLE_TRANSFER_V1：provider 选择与客户端行为守卫");
{
  const serverSrc = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/server.js"), "utf8");
  const providerSrc = fs.readFileSync(path.join(__dirname,
    "tools/sample_collector/provider.js"), "utf8");
  const pluginSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueuePlugin.java"), "utf8");
  const modelSrc = fs.readFileSync(path.join(__dirname,
    "android/app/src/main/java/com/jty/safetyquiz/SampleQueueModel.java"), "utf8");

  check("COS-Q1 provider 选择：COS 优先，R2 后备，可显式禁用（FAIL CLOSED 可测）",
    providerSrc.includes('want === "cos"') &&
    providerSrc.includes('want === "r2"') &&
    providerSrc.includes('want === "none"'));
  check("COS-Q2 presign TTL 300 秒（COS 路径与 R2 共用同一常量）",
    fs.readFileSync(path.join(__dirname, "tools/sample_collector/r2_store.js"), "utf8")
      .includes("DEFAULT_PRESIGN_TTL_SECONDS = 300"));
  check("COS-Q3 legacy /api/sample 保留（ENABLED_COMPAT）",
    serverSrc.includes('p === "/api/sample"'));
  check("COS-Q4 mirror 在 commit 响应路径之外（后台 worker）",
    fs.readFileSync(path.join(__dirname, "tools/sample_collector/r2_store.js"), "utf8")
      .includes("function kickMirror"));
  check("COS-Q5 手机端记录的是数字诊断（耗时/速率），不是 URL",
    pluginSrc.includes("captureBytesPerSec") &&
    pluginSrc.includes("captureUploadMs") &&
    /* state 里绝不写入 presigned URL / 签名（setServer 的 serverUrl 是合法 API 字段） */
    !/\.put\("(presignedPutUrl|presigned[A-Za-z]*|signature|sig)"/.test(pluginSrc));
  check("COS-Q6 429 走 model 的 markRateLimited（尊重 Retry-After，可 JVM 单测）",
    modelSrc.includes("markRateLimited") &&
    modelSrc.includes("RATE_LIMIT_MAX_WAIT_MS") &&
    pluginSrc.includes("recordRateLimited(dir, \"commit HTTP 429\"") &&
    pluginSrc.includes("parseRetryAfterMs"));
  check("COS-Q7 COS PUT 403/400 不进入永久 failed（会重新 init）",
    /COS PUT HTTP " \+ putStatus \+ " \(will re-init\)"/.test(pluginSrc));
  check("COS-Q8 手机 state.json 不落 presigned URL",
    !/put\("presigned/.test(pluginSrc));
}

function finish() {
  console.log("\n" + "=".repeat(46));
  if (fails.length) { console.log(`结果：${fails.length} 项未通过 -> ${fails}`); process.exit(1); }
  console.log("结果：全部通过 ✓");
}
/* SUC 编排小节内部走 Promise 微任务（controller 的 getAppInfo/fetchLatest 是异步），
   统一结论推迟到它完成后输出；异常按失败项记录。 */
runSucOrchestrationTests().then(finish, function (e) {
  console.error("\n[SUC] 编排测试异常：", e && e.stack || e);
  fails.push("SUC 编排测试异常");
  finish();
});
