/* pageplan.js —— 基准测试的页面计划（harness 代码，纯函数，可单测）。
   5 轮 × 30 页 = 150 页；每页随机 5/8/10 题；题型配比按需求：
   单选纯页 30% / 多选纯页 25% / 判断纯页 25% / 跨块页 20%。
   随机抽样覆盖不到 392 题时，用 mustInclude 自动补生成页面直到 392/392。 */
"use strict";

const Bench = require("../bench-core.js");

/* 每轮固定 seed（需求指定） */
const ROUND_SEEDS = [2026092101, 2026092102, 2026092103, 2026092104, 2026092105];
const PAGES_PER_ROUND = 30;
/* 每轮 30 页的题型配比：9 单选 + 8 多选 + 7 判断 + 3 单选→多选 + 3 多选→判断 */
const MIX = [
  { mode: "normal", type: "single", n: 9, label: "single" },
  { mode: "normal", type: "multi", n: 8, label: "multi" },
  { mode: "normal", type: "judge", n: 7, label: "judge" },
  { mode: "single-multi", type: "single", n: 3, label: "single-multi" },
  { mode: "multi-judge", type: "multi", n: 3, label: "multi-judge" }
];
const COUNTS = [5, 8, 10];

/* 与 bench-core 相同的确定性随机，保证页面计划本身可复现 */
function rng(seed) { return Bench.mulberry32(seed); }
function intIn(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }

/* 起始题号要像真实卷面：按题型落在各自大块的合理区间 */
function startFor(mode, type, rand) {
  if (mode === "single-multi") { return intIn(rand, 1, 140); }
  if (mode === "multi-judge") { return intIn(rand, 41, 95); }
  if (type === "single") { return intIn(rand, 1, 140); }
  if (type === "multi") { return intIn(rand, 41, 95); }
  return intIn(rand, 61, 105);
}

function makePage(roundIdx, pageIdx, spec, seed, rand, extra) {
  const count = spec.count || COUNTS[Math.floor(rand() * COUNTS.length)];
  const splitAt = spec.mode === "normal" ? null : Math.max(1, Math.round(count / 2));
  return Object.assign({
    pageId: "R" + (roundIdx + 1) + "P" + String(pageIdx + 1).padStart(2, "0"),
    round: roundIdx + 1,
    indexInRound: pageIdx,
    seed: seed,
    type: spec.type,
    count: count,
    startNumber: spec.startNumber || startFor(spec.mode, spec.type, rand),
    mode: spec.mode,
    splitAt: splitAt,
    pool: spec.pool || "all",
    label: spec.label
  }, extra || {});
}

/* 生成 150 页计划（不含补齐页） */
function buildPlan() {
  const pages = [];
  ROUND_SEEDS.forEach((roundSeed, ri) => {
    const rand = rng(roundSeed);
    let idx = 0;
    MIX.forEach(spec => {
      for (let k = 0; k < spec.n; k++) {
        /* 每页一个独立 seed：轮 seed + 页序号，稳定可复现 */
        pages.push(makePage(ri, idx, spec, roundSeed + idx, rand));
        idx++;
      }
    });
  });
  return pages;
}

/* 统计一批页面对题库的覆盖情况 */
function coverageOf(pages, data) {
  const used = new Set();
  pages.forEach(p => (p.bankIds || []).forEach(id => used.add(String(id))));
  const byType = {};
  data.forEach(q => {
    byType[q.type] = byType[q.type] || { total: 0, used: 0, missing: [] };
    byType[q.type].total++;
    if (used.has(String(q.id))) { byType[q.type].used++; }
    else { byType[q.type].missing.push(q.id); }
  });
  const total = data.length;
  const usedTotal = data.filter(q => used.has(String(q.id))).length;
  return { total: total, used: usedTotal, missing: total - usedTotal, byType: byType };
}

/* 用 mustInclude 补页，直到题库全覆盖；返回补出来的页（也追加进 pages） */
function topUpCoverage(pages, data, opts) {
  const o = opts || {};
  const maxPages = o.maxPages || 60;
  const covered = new Set();
  pages.forEach(p => (p.bankIds || []).forEach(id => covered.add(String(id))));
  const missingByType = { single: [], multi: [], judge: [] };
  data.forEach(q => { if (!covered.has(String(q.id))) { missingByType[q.type].push(q.id); } });
  const added = [];
  let seedBase = 2026092900;
  let n = 0;
  ["single", "multi", "judge"].forEach(type => {
    const missing = missingByType[type];
    for (let i = 0; i < missing.length && n < maxPages; i += 10) {
      const chunk = missing.slice(i, i + 10);
      const count = Math.max(5, chunk.length);
      n++;
      const page = makePage(-1, n - 1, {
        mode: "normal", type: type, n: 1, label: "topup", count: count
      }, seedBase + n, rng(seedBase + n), { topUp: true, mustIncludeIds: chunk });
      page.startNumber = startFor("normal", type, rng(seedBase + n));
      page.mustInclude = {};
      page.mustInclude[type] = chunk;
      page.pageId = "TO" + String(n).padStart(2, "0");
      page.round = 0;
      pages.push(page);
      added.push(page);
    }
  });
  return added;
}

module.exports = {
  ROUND_SEEDS, PAGES_PER_ROUND, MIX, COUNTS,
  buildPlan, coverageOf, topUpCoverage, startFor
};
