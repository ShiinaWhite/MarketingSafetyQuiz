/* calibrate.js —— 在 dev 集上分析真实 ML Kit 输出下的置信度分布，网格搜索
   high/medium 阈值（harness 代码）。只输出建议阈值，不改动任何算法文件。 */
"use strict";
const fs = require("fs");
const path = require("path");
const MSQ = require("../../www/js/core.js");
const Bench = require("../bench-core.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".generated");

function evalSet(pageId) {
  let h = 0;
  const s = String(pageId);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return (h % 100) < 70 ? "dev" : "holdout";
}

function main() {
  const profile = process.argv[2] || "ceiling";
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  const data = Bench.normalizeQuestions(JSON.parse(
    fs.readFileSync(path.join(ROOT, manifest.source === "private" ? "private_questions.json" : "mock_questions.json"), "utf8")));
  const idx = MSQ.buildBatchOcrIndex(data);
  const ocrLines = fs.readFileSync(path.join(OUT, "ocr", profile + ".jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const ocrMap = new Map(ocrLines.filter(o => !o.header).map(o => [o.file, o]));

  const rows = [];
  let devPages = 0;
  manifest.pages.forEach(page => {
    if (evalSet(page.pageId) !== "dev") { return; }
    const img = page.images[profile];
    if (!img) { return; }
    const ocr = ocrMap.get(path.basename(img.file));
    if (!ocr || ocr.err) { return; }
    devPages++;
    const lines = (ocr.lines || []).map(l => ({ text: l.text, left: l.left, top: l.top, right: l.right, bottom: l.bottom }));
    const gt = JSON.parse(fs.readFileSync(path.join(OUT, page.gt), "utf8"));
    const res = MSQ.searchPageQuestionsByOcr(idx, lines, page.type, { limit: 3 });
    res.blocks.forEach((b, i) => {
      const exp = gt.questions[i];
      if (!exp) { return; }
      const t1 = (b.matches && b.matches[0]) || null;
      const t2 = (b.matches && b.matches[1]) || null;
      rows.push({
        score: t1 ? t1.score : 0,
        lead: (t2 && t2.score > 0) ? t1.score / t2.score : 2,
        correct: b.bankId !== null && exp && String(b.bankId) === String(exp.bankId),
        nMatches: (b.matches || []).length
      });
    });
  });

  const wrong = rows.filter(r => !r.correct), right = rows.filter(r => r.correct);
  console.log("dev 集页数 " + devPages + "，样本 " + rows.length + "（正确 " + right.length + " / 错误 " + wrong.length + "）");
  const dist = (arr, key) => {
    const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
    const v = arr.map(x => x[key]).sort((a, b) => a - b);
    return qs.map(q => v[Math.floor((v.length - 1) * q)].toFixed(0)).join(" / ");
  };
  console.log("score 分位(5/25/50/75/95%)  正确: " + dist(right, "score") + "   错误: " + dist(wrong, "score"));
  console.log("lead  分位(5/25/50/75/95%)  正确: " + dist(right, "lead") + "   错误: " + dist(wrong, "lead"));

  /* 网格搜索：high = score>=HS && lead>=HL；medium = score>=MS && lead>=ML（非 high）
     目标：wrongHigh = 0 前提下，最小化 (wrongMedium*2 + falseNeg)，并保持 high 覆盖量 */
  let best = [];
  for (let HS = 200; HS <= 1600; HS += 100) {
    for (let HL = 1.05; HL <= 1.95; HL += 0.05) {
      for (let MS = 100; MS <= Math.min(HS, 600); MS += 100) {
        for (let ML = 1.0; ML <= Math.min(HL, 1.4); ML += 0.05) {
          let wH = 0, wM = 0, fn = 0, hi = 0;
          rows.forEach(r => {
            const isHigh = r.score >= HS && r.lead >= HL;
            const isMed = !isHigh && r.score >= MS && r.lead >= ML;
            if (isHigh) { hi++; if (!r.correct) { wH++; } }
            else if (isMed) { if (!r.correct) { wM++; } }
            else if (r.correct) { fn++; }
          });
          if (wH === 0) {
            best.push({ HS, HL: +HL.toFixed(2), MS, ML: +ML.toFixed(2), wM, fn, hi });
          }
        }
      }
    }
  }
  best.sort((a, b) => (a.wM * 2 + a.fn) - (b.wM * 2 + b.fn) || b.hi - a.hi);
  console.log("\nwrongHigh=0 的最优组合（按 错误中置信*2 + 漏答 最小排序，取前 8）：");
  best.slice(0, 8).forEach(b => console.log(
    "  HS=" + b.HS + " HL=" + b.HL + " MS=" + b.MS + " ML=" + b.ML +
    "  → 错误中置信 " + b.wM + "，漏答(正确但low) " + b.fn + "，high 覆盖 " + b.hi + "/" + rows.length));
  if (!best.length) { console.log("  （没有 wrongHigh=0 的组合，需引入更多特征）"); }
}
main();
