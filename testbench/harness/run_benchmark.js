/* run_benchmark.js —— 基准测试主流程（harness 代码）。
   输入：testbench/.generated/manifest.json + groundtruth/ + ocr/<profile>.jsonl（由 Android harness 产出）
   流程：ML Kit lines → splitPageOcrLines → searchPageQuestionsByOcr → 与 Ground Truth 比对 → 报告
   注意：本脚本不做任何 OCR；OCR 文本只能来自 Android 端 ML Kit 导出的 JSONL。

   用法：
     node testbench/harness/run_benchmark.js --profile ceiling
     node testbench/harness/run_benchmark.js --both
     node testbench/harness/run_benchmark.js --selftest    # 仅验证 harness 链路，产物标记 NOT_MLKIT */
"use strict";

const fs = require("fs");
const path = require("path");
const MSQ = require("../../www/js/core.js");
const Bench = require("../bench-core.js");
const report = require("./report.js");

const ROOT = path.resolve(__dirname, "..");          // testbench/
const OUT = path.join(ROOT, ".generated");
const REPORTS = path.join(OUT, "reports");
const FAILURES = path.join(OUT, "failures");
const REPO = path.resolve(__dirname, "../..");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? (process.argv[i + 1] && process.argv[i + 1][0] !== "-" ? process.argv[i + 1] : true) : def;
}

function baselineCommit() {
  try {
    const { execSync } = require("child_process");
    return execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
  } catch (e) { return "(unknown)"; }
}

/* 固定 dev/holdout 切分：按 pageId 哈希，稳定且与内容无关（调参前先切，防过拟合）。
   dev ≈ 70%，holdout ≈ 30%。优化过程只看 dev；holdout 仅在最终验收时跑。 */
function evalSet(pageId) {
  let h = 0;
  const s = String(pageId);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return (h % 100) < 70 ? "dev" : "holdout";
}

function mlkitVersion() {
  try {
    const g = fs.readFileSync(path.join(REPO, "android/app/build.gradle"), "utf8");
    const m = g.match(/text-recognition-chinese:([\d.]+)/);
    return m ? "com.google.mlkit:text-recognition-chinese:" + m[1] : "(未在 build.gradle 找到)";
  } catch (e) { return "(unknown)"; }
}

/* ---------- 读取 ML Kit 导出的 OCR JSONL ---------- */
function loadOcr(file) {
  const map = new Map();
  let header = null;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    if (!line.trim()) { return; }
    const o = JSON.parse(line);
    if (o.header) { header = o; return; }
    map.set(o.file, o);
  });
  return { header, map };
}

/* ---------- 单页：分题 + 题型约束匹配 ---------- */
function runPage(page, gt, ocr) {
  const lines = (ocr.lines || []).map(l => ({ text: l.text, left: l.left, top: l.top, right: l.right, bottom: l.bottom }));
  const t0 = process.hrtime.bigint();
  const blocksOnly = MSQ.splitPageOcrLines(lines, page.type);
  const t1 = process.hrtime.bigint();
  const res = MSQ.searchPageQuestionsByOcr(BATCH_INDEX, lines, page.type, { limit: 3 });
  const t2 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  const blocks = res.blocks.map(b => ({
    screenNumber: b.screenNumber, label: b.label, type: b.type, confidence: b.confidence,
    bankId: b.bankId, answerRaw: b.answer,
    /* 界面实际显示：低置信度/无匹配显示 ?（与 App 的 batchAnswerDisplay 一致） */
    answerDisplayed: MSQ.pageAnswerDisplay(b.confidence, b.answer).text,
    stemText: b.stemText, optionsText: b.optionsText, rawText: b.rawText,
    top: b.top, bottom: b.bottom,
    matches: (b.matches || []).map(m => ({ id: m.id, score: m.score, type: m.type }))
  }));
  return {
    blocks: blocks,
    splitMs: ms(t0, t1),
    matchMs: ms(t1, t2),
    splitCountOnly: blocksOnly.length
  };
}

let BATCH_INDEX = null;

function main() {
  const selftest = !!arg("selftest", false);
  const both = !!arg("both", false);
  const profiles = both ? ["ceiling", "app_ideal"] : [String(arg("profile", "ceiling"))];
  const setName = String(arg("set", "all")).toLowerCase();
  if (["dev", "holdout", "all"].indexOf(setName) < 0) { throw new Error("--set 只支持 dev|holdout|all"); }
  const secondName = arg("second", null);
  let secondJobs = null, secondOcr = null;
  if (secondName) {
    const jp = path.join(OUT, "second_pass", String(secondName), "jobs.json");
    const op = path.join(OUT, "ocr", String(secondName) + "-crops.jsonl");
    secondJobs = JSON.parse(fs.readFileSync(jp, "utf8"));
    secondOcr = new Map(fs.readFileSync(op, "utf8").split(/\r?\n/).filter(Boolean).map(l => {
      const o = JSON.parse(l); return [o.file, o];
    }));
    console.log("[二次OCR] 触发块 " + secondJobs.jobs.length + "，裁图结果 " + secondOcr.size);
  }
  const manifestPath = path.join(OUT, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("缺少 " + manifestPath + "\n先运行： node testbench/harness/generate_dataset.js");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dataPath = path.join(ROOT, manifest.source === "private" ? "private_questions.json" : "mock_questions.json");
  const data = Bench.normalizeQuestions(JSON.parse(fs.readFileSync(dataPath, "utf8")));
  BATCH_INDEX = MSQ.buildBatchOcrIndex(data);
  fs.mkdirSync(REPORTS, { recursive: true });

  const summaries = [];
  let blocked = false;

  profiles.forEach(profile => {
    const ocrFile = path.join(OUT, "ocr", profile + ".jsonl");
    if (!selftest && !fs.existsSync(ocrFile)) {
      console.error("\n[BLOCKED] 缺少 ML Kit OCR 数据：" + ocrFile);
      blocked = true;
      return;
    }
    const src = selftest ? buildSelftestOcr(manifest, profile) : loadOcr(ocrFile);
    const pagesInSet = manifest.pages.filter(p => setName === "all" || evalSet(p.pageId) === setName);
    const records = [];
    const pageJobs = {};
    if (secondJobs) {
      secondJobs.jobs.forEach(j => {
        if (setName !== "all" && evalSet(j.pageId) !== setName) { return; }
        (pageJobs[j.pageId] = pageJobs[j.pageId] || []).push(j);
      });
    }
    pagesInSet.forEach(page => {
      const img = page.images[profile];
      if (!img) { return; }
      const base = path.basename(img.file);
      const ocr = src.map.get(base);
      if (!ocr) { return; }
      const gt = JSON.parse(fs.readFileSync(path.join(OUT, page.gt), "utf8"));
      const r = runPage(page, gt, ocr);
      /* ---- 局部二次 OCR 合并：只对触发块，"更好才替换" ---- */
      (pageJobs[page.pageId] || []).forEach(j => {
        const cropO = secondOcr.get(j.cropFile);
        const b = r.blocks[j.blockIdx];
        if (!cropO || cropO.err || !b) { return; }
        const cropText = String(cropO.text || "");
        r.secondPass = r.secondPass || { triggered: 0, ocrMs: [] };
        r.secondPass.triggered++; r.secondPass.ocrMs.push(cropO.ms || 0);
        if (!cropText.trim() || !b.matches) { return; }
        const secondMatches = MSQ.matchPageQuestionBlock(BATCH_INDEX, { stemText: cropText, optionsText: "", type: b.type }, { limit: 3 });
        const first = b.matches[0] || null;
        const second = secondMatches[0] || null;
        if (!second) { return; }
        const firstScore = first ? first.score : 0;
        let via = null, chosen = null;
        /* 保守合并：只救"原本显示 ?"的块；任何已显示的答案绝不被二次结果替换 */
        const firstHidden = !first || b.answerDisplayed === "?";
        if (!first) { chosen = secondMatches; via = "second_no_first"; }
        else if (firstHidden && second.score > firstScore * 1.15) { chosen = secondMatches; via = "second_recover"; }
        else { chosen = b.matches; via = "first_kept"; }
        if (via && via.indexOf("second") === 0) {
          b.matches = chosen;
          b.bankId = chosen[0].id;
          b.answerItem = BATCH_INDEX.find(x => String(x.id) === String(chosen[0].id)) || null;
          b.answer = b.answerItem ? MSQ.pageAnswerText(b.answerItem) : "?";
          const conf = MSQ.pageBlockConfidence(chosen, { stemText: cropText });
          b.confidence = conf === "high" ? "medium" : conf;   /* 恢复路径保守封顶 medium */
          b.answerDisplayed = MSQ.pageAnswerDisplay(b.confidence, b.answer).text;
          b.secondPassInfo = { via: via, secondScore: second.score, firstScore: firstScore };
        }
      });
      records.push({
        pageId: page.pageId, profile: profile, seed: page.seed, type: page.type, mode: page.mode,
        count: page.count, startNumber: page.startNumber, topUp: !!page.topUp,
        image: img.file, imageWidth: ocr.width || null, imageHeight: ocr.height || null,
        ocr: { ms: ocr.ms || 0, text: ocr.text || "", lines: ocr.lines || [], err: ocr.err || null },
        timings: {
          ocrMs: ocr.ms || 0,
          splitMs: r.splitMs,
          matchMs: r.matchMs,
          totalMs: (ocr.ms || 0) + r.splitMs + r.matchMs
        },
        blocks: r.blocks,
        gt: gt
      });
    });
    if (!records.length) {
      console.error("[BLOCKED] " + profile + " 没有可用的 (图片, OCR) 配对");
      blocked = true;
      return;
    }
    const agg = report.aggregate(records);
    const meta = {
      baselineCommit: baselineCommit(),
      runtime: src.header
        ? (src.header.device + " · Android " + src.header.release + " (API " + src.header.sdkInt + ") · " +
           (src.header.profile || profile))
        : "(selftest：无设备)",
      mlkit: src.header ? src.header.mlkit : "(selftest)",
      source: manifest.source, bankSize: manifest.bankSize, profile: profile,
      coverage: manifest.coverage, evalSet: setName,
      pagesInSet: setName === "all" ? manifest.pages.length
        : manifest.pages.filter(p => evalSet(p.pageId) === setName).length,
      timingNote: "OCR 耗时来自 Android 端 ML Kit（同一次进程、已预热模型）；" +
        "split/match 在电脑端 V8 上测量，非手机 CPU。TOTAL 为 image-to-answer，不含对焦/快门/Camera 启动。"
    };
    const name = selftest ? profile + "_report_NOT_MLKIT.json" : profile + "_report.json";
    fs.writeFileSync(path.join(REPORTS, name), JSON.stringify({ meta: meta, metrics: agg }, null, 2), "utf8");
    /* 失败样本完整证据 */
    const fdir = path.join(FAILURES, profile);
    fs.mkdirSync(fdir, { recursive: true });
    records.forEach(r => {
      const bad = [];
      r.gt.questions.forEach((exp, i) => {
        const b = r.blocks[i];
        const shown = b ? b.answerDisplayed : "?";
        if (shown !== exp.answer) {
          bad.push({ index: i, expected: exp, got: b ? {
            screenNumber: b.screenNumber, type: b.type, bankId: b.bankId, answer: shown,
            confidence: b.confidence, stemText: b.stemText, top3: b.matches
          } : null });
        }
      });
      if (!bad.length) { return; }
      fs.writeFileSync(path.join(fdir, r.pageId + ".json"), JSON.stringify({
        pageId: r.pageId, image: r.image, imageSize: [r.imageWidth, r.imageHeight],
        config: { seed: r.seed, type: r.type, mode: r.mode, count: r.count, startNumber: r.startNumber },
        timings: r.timings,
        groundTruth: r.gt.questions,
        ocrText: r.ocr.text,
        ocrLines: r.ocr.lines,
        blocks: r.blocks.map(b => ({ screenNumber: b.screenNumber, type: b.type, confidence: b.confidence,
          bankId: b.bankId, answer: b.answerDisplayed, stemText: b.stemText, top3: b.matches })),
        failed: bad
      }, null, 2), "utf8");
    });
    summaries.push({ profile: profile, meta: meta, agg: agg });
    console.log("[完成] " + profile + "：页 " + agg.pages + " · 题 " + agg.questions +
      " · Top1 " + agg.TOP1_MATCH_ACCURACY.toFixed(1) + "% · 答案 " + agg.ANSWER_ACCURACY.toFixed(1) +
      "% · 高置信度错误 " + agg.HIGH_CONFIDENCE_WRONG);
  });

  if (summaries.length) {
    const md = summaries.map(s => report.renderMarkdown(s.meta, s.agg)).join("\n\n---\n\n");
    const file = selftest ? "baseline_summary_NOT_MLKIT.md" : "baseline_summary.md";
    fs.writeFileSync(path.join(REPORTS, file), md, "utf8");
    console.log("[报告] " + path.relative(process.cwd(), path.join(REPORTS, file)));
    if (selftest) {
      console.log("\n*** 注意：本次为 HARNESS SELFTEST，OCR 文本由 Ground Truth 合成，");
      console.log("*** 不是 ML Kit 指标，不得作为 App OCR 准确率引用。***\n");
    }
  }
  if (blocked) {
    console.error("\n真实 ML Kit 指标需要一台可用的 Android 设备/模拟器，步骤：");
    console.error("  1) adb push testbench/.generated/images /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/images");
    console.error("  2) cd android && gradlew.bat :app:connectedDebugAndroidTest \\");
    console.error("       -Pandroid.testInstrumentationRunnerArguments.profile=ceiling");
    console.error("     （再跑一次 profile=app_ideal）");
    console.error("  3) adb pull /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/ocr testbench/.generated/ocr");
    console.error("  4) node testbench/harness/run_benchmark.js --both");
    process.exit(2);
  }
}

/* selftest 专用：用 Ground Truth 文本合成"完美 OCR"行，仅用于验证 harness 链路是否通。
   产物文件名与打印都带 NOT_MLKIT 标记，绝不写入正式报告。 */
function buildSelftestOcr(manifest, profile) {
  const map = new Map();
  manifest.pages.forEach(page => {
    const img = page.images[profile];
    if (!img) { return; }
    const gt = JSON.parse(fs.readFileSync(path.join(OUT, page.gt), "utf8"));
    const lines = [];
    let y = 60;
    const push = (text, left) => { lines.push({ text: text, left: left, top: y, right: 900, bottom: y + 46 }); y += 52; };
    lines.push({ text: "2026 年营销安规仿真考试（Test Bench）", left: 300, top: 10, right: 900, bottom: 40 });
    gt.questions.forEach(q => {
      push(q.screenNumber + ". " + q.stem, 40);
      const src = BATCH_INDEX.find(x => String(x.id) === String(q.bankId));
      if (src) { src.options.forEach((o, i) => push(Bench.LETTERS[i] + ". " + o, 60)); }
    });
    map.set(path.basename(img.file), {
      file: path.basename(img.file), ms: 0, width: img.cssWidth, height: img.cssHeight,
      text: lines.map(l => l.text).join("\n"), lines: lines, err: null
    });
  });
  return { header: null, map: map };
}

if (require.main === module) {
  try { main(); } catch (e) { console.error("[失败] " + e.message + "\n" + e.stack); process.exit(1); }
}
module.exports = { runPage, loadOcr };
