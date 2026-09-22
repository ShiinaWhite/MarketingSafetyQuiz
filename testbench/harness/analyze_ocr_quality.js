/* analyze_ocr_quality.js —— 各分辨率档的 OCR 文本质量指标（harness 代码，只读 OCR JSONL）。
   指标（全部按 GT 对齐统计）：
   STEM_CHAR_COVERAGE   期望题干字符被 OCR 实际捕获的比例（均值）
   STEM_RECALL50        题干字符覆盖 >= 50% 的块占比（可匹配下限）
   QUESTION_NUMBER_RECALL 期望题号被成功识别为块题号的比例
   OPTION_LABEL_RECALL  期望的 A~F 选项标签被识别出来的比例
   用法：node testbench/harness/analyze_ocr_quality.js r1600q85 app_ideal r2400q85 ... */
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
function coverage(expected, actual) {
  const e = String(expected == null ? "" : expected).replace(/[^\p{L}\p{N}]/gu, "");
  const a = String(actual == null ? "" : actual).replace(/[^\p{L}\p{N}]/gu, "");
  if (!e.length) { return 1; }
  const pool = new Map();
  for (const ch of a) { pool.set(ch, (pool.get(ch) || 0) + 1); }
  let hit = 0;
  for (const ch of e) { const n = pool.get(ch) || 0; if (n > 0) { hit++; pool.set(ch, n - 1); } }
  return hit / e.length;
}

const profiles = process.argv.slice(2);
const summary = [];
for (const profile of profiles) {
  const ocrFile = path.join(OUT, "ocr", profile + ".jsonl");
  if (!fs.existsSync(ocrFile)) { summary.push({ profile, missing: true }); continue; }
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  const data = Bench.normalizeQuestions(JSON.parse(fs.readFileSync(
    path.join(ROOT, manifest.source === "private" ? "private_questions.json" : "mock_questions.json"), "utf8")));
  const ocrLines = fs.readFileSync(ocrFile, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const omap = new Map(ocrLines.filter(o => !o.header).map(o => [o.file, o]));
  let covSum = 0, covN = 0, cov50 = 0, numHit = 0, numN = 0, optHit = 0, optN = 0;
  manifest.pages.forEach(page => {
    if (evalSet(page.pageId) !== "dev") { return; }   /* 质量分析固定用 dev，不碰 holdout */
    const img = page.images[profile];
    if (!img) { return; }
    const o = omap.get(path.basename(img.file));
    if (!o || o.err) { return; }
    const lines = (o.lines || []).map(l => ({ text: l.text, left: l.left || 0, top: l.top || 0, right: l.right || 0, bottom: l.bottom || 0 }));
    const gt = JSON.parse(fs.readFileSync(path.join(OUT, page.gt), "utf8"));
    const blocks = MSQ.splitPageOcrLines(lines, page.type);
    gt.questions.forEach((exp, i) => {
      const b = blocks[i];
      const cov = coverage(exp.stem, b ? b.stemText : "");
      covSum += cov; covN++;
      if (cov >= 0.5) { cov50++; }
      if (b && String(b.screenNumber) === String(exp.screenNumber)) { numHit++; }
      numN++;
      if (b) {
        const opts = (b.optionsText || "").toUpperCase();
        const want = Math.min(exp.stem ? countOptionLines(b) : 0, 6);
        for (let k = 0; k < want; k++) {
          if (opts.indexOf("ABCDEF"[k] + ".") >= 0 || opts.indexOf("ABCDEF"[k] + "、") >= 0) { optHit++; }
          optN++;
        }
      }
    });
  });
  function countOptionLines(b) {
    let n = 0;
    const letters = "ABCDEF";
    for (let k = 0; k < 6; k++) { if ((b.optionsText || "").toUpperCase().indexOf(letters[k] + ".") >= 0) { n++; } }
    return Math.max(n, (b.lines || []).length ? 4 : 0);
  }
  summary.push({
    profile, pages: covN ? undefined : 0,
    STEM_CHAR_COVERAGE: covN ? (covSum / covN * 100) : 0,
    STEM_RECALL50: covN ? (cov50 / covN * 100) : 0,
    QUESTION_NUMBER_RECALL: numN ? (numHit / numN * 100) : 0,
    OPTION_LABEL_RECALL: optN ? (optHit / optN * 100) : 0,
    sample: covN
  });
}
console.log("profile      | STEM字符覆盖 | 题干召回>=50% | 题号召回 | 选项标签召回 | dev样本");
summary.forEach(s => {
  if (s.missing) { console.log(s.profile.padEnd(12) + "| 无 OCR 数据"); return; }
  console.log(s.profile.padEnd(12) + "|" + s.STEM_CHAR_COVERAGE.toFixed(1).padStart(12) + "%" +
    "|" + s.STEM_RECALL50.toFixed(1).padStart(13) + "%" +
    "|" + s.QUESTION_NUMBER_RECALL.toFixed(1).padStart(8) + "%" +
    "|" + s.OPTION_LABEL_RECALL.toFixed(1).padStart(12) + "%" +
    "|" + String(s.sample).padStart(7));
});
