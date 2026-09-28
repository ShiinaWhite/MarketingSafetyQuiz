#!/usr/bin/env node
/* backfill.js —— 历史样本 → samples.db 结构化索引（SAMPLE_DATABASE_V1 §13 / B7）

     node tools/sample_db/backfill.js [--root <dir>] [--db <path>] --dry-run
     node tools/sample_db/backfill.js [--root <dir>] [--db <path>] --apply

   - 默认 --dry-run（零写入，只报告）；--apply 才写库（写入走与在线双写完全相同的
     recordSample / recordFeedback 幂等路径）。
   - 对 raw files 严格 READ ONLY：不移动、不删除、不改名、不改 mtime。
   - malformed（JSON 解析失败 / sampleId 与目录不符 / blocks 非数组）：报告 + 跳过，
     绝不自动修数据、绝不写库。
   - 幂等：再跑一遍 inserted=0 / updated=0，全部 duplicate，无任何副作用。 */
"use strict";

const fs = require("fs");
const path = require("path");
const samplesDb = require("./store.js");

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, "..", "..", "real_samples"),
    db: path.resolve(__dirname, "..", "..", "data", "samples", "samples.db"),
    apply: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") { args.root = path.resolve(argv[++i]); }
    else if (a === "--db") { args.db = path.resolve(argv[++i]); }
    else if (a === "--apply") { args.apply = true; }
    else if (a === "--dry-run") { args.apply = false; }
    else if (a === "--help" || a === "-h") { args.help = true; }
  }
  return args;
}

/* 扫描 root 下 YYYY-MM-DD/<sampleId>/ 两层目录（与 Collector 落盘布局一致） */
function listSampleDirs(root) {
  const out = [];
  let dateDirs;
  try { dateDirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SAMPLE_RE = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
  for (const d of dateDirs) {
    if (!d.isDirectory() || !DATE_RE.test(d.name)) { continue; }
    const datePath = path.join(root, d.name);
    let sampleDirs;
    try { sampleDirs = fs.readdirSync(datePath, { withFileTypes: true }); } catch (e) { continue; }
    for (const s of sampleDirs) {
      if (!s.isDirectory() || !SAMPLE_RE.test(s.name)) { continue; }
      out.push({ dir: path.join(datePath, s.name), sampleId: s.name });
    }
  }
  out.sort(function (a, b) { return a.sampleId < b.sampleId ? -1 : 1; });
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node tools/sample_db/backfill.js [--root <dir>] [--db <path>] --dry-run|--apply");
    process.exit(0);
  }
  const opened = samplesDb.openSamplesStore({ path: args.db });
  if (!opened.ok) {
    console.error("samples.db 不可用：" + opened.error);
    process.exit(1);
  }
  const db = opened.store;
  const stats = {
    scanned: 0, valid: 0, inserted: 0, updated: 0, duplicate: 0,
    malformed: 0, missing_capture: 0, missing_run: 0,
    feedback_count: 0, block_count: 0
  };
  const malformedList = [];
  const mode = args.apply ? "APPLY（写入）" : "DRY-RUN（零写入）";
  console.log("backfill " + mode);
  console.log("root: " + args.root);
  console.log("db  : " + args.db);
  console.log("");

  try {
    for (const entry of listSampleDirs(args.root)) {
      stats.scanned += 1;
      const runPath = path.join(entry.dir, "run.json");
      if (!fs.existsSync(runPath)) {
        stats.missing_run += 1;
        stats.malformed += 1;
        malformedList.push(entry.sampleId + ": run.json 缺失");
        continue;
      }
      let run;
      try {
        run = JSON.parse(fs.readFileSync(runPath, "utf8"));
      } catch (e) {
        stats.malformed += 1;
        malformedList.push(entry.sampleId + ": run.json 不可解析");
        continue;
      }
      if (!run || typeof run !== "object" || run.sampleId !== entry.sampleId) {
        stats.malformed += 1;
        malformedList.push(entry.sampleId + ": run.json.sampleId 与目录不符");
        continue;
      }
      if (run.blocks !== undefined && !Array.isArray(run.blocks)) {
        stats.malformed += 1;
        malformedList.push(entry.sampleId + ": blocks 非数组");
        continue;
      }
      const capturePath = path.join(entry.dir, "capture.jpg");
      const hasCapture = fs.existsSync(capturePath);
      if (!hasCapture) { stats.missing_capture += 1; }
      const image = (run.image && typeof run.image === "object") ? run.image : {};
      const info = {
        sampleId: entry.sampleId,
        manifest: run,
        provider: image.storage || null,       /* raw 档案自述的存储（r2/…）；不猜测 */
        objectKey: image.objectKey || null,
        localPath: hasCapture ? capturePath : null,
        sha256: image.sha256 || null,
        size: image.bytes || null,
        width: image.width || null,
        height: image.height || null
      };
      const verdict = args.apply
        ? db.recordSample(info)
        : db.classifySample(info);
      stats.valid += 1;
      stats[verdict] += 1;
      stats.block_count += Array.isArray(run.blocks) ? run.blocks.length : 0;

      const fbPath = path.join(entry.dir, "feedback.json");
      if (fs.existsSync(fbPath)) {
        try {
          const fb = JSON.parse(fs.readFileSync(fbPath, "utf8"));
          if (fb && typeof fb === "object") {
            stats.feedback_count += 1;
            if (args.apply) { db.recordFeedback(entry.sampleId, fb); }
          } else {
            malformedList.push(entry.sampleId + ": feedback.json 形状非法（跳过反馈）");
          }
        } catch (e) {
          malformedList.push(entry.sampleId + ": feedback.json 不可解析（跳过反馈）");
        }
      }
    }
  } finally {
    db.close();
  }

  console.log("scanned=" + stats.scanned +
    "  valid=" + stats.valid +
    "  inserted=" + stats.inserted +
    "  updated=" + stats.updated +
    "  duplicate=" + stats.duplicate);
  console.log("malformed=" + stats.malformed +
    "  missing_capture=" + stats.missing_capture +
    "  missing_run=" + stats.missing_run);
  console.log("feedback_count=" + stats.feedback_count +
    "  block_count=" + stats.block_count);
  if (malformedList.length) {
    console.log("");
    console.log("malformed 明细（已跳过，未自动修数据）：");
    for (const m of malformedList) { console.log("  - " + m); }
  }
  if (!args.apply) {
    console.log("");
    console.log("DRY-RUN 未写库。确认后加 --apply 执行写入。");
  }
  process.exit(0);
}

main();
