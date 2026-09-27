#!/usr/bin/env node
/* backup.js —— telemetry.db / samples.db 一致性快照（DATA_PLATFORM_V1 §15 / C）

     node tools/db/backup.js [--db telemetry|samples|both] [--out <dir>] [--keep N]

   使用 node:sqlite backup API（对 WAL 活库做一致性快照拷贝）——绝不直接裸 copy
   数据库文件（WAL 下裸 copy 会得到不一致的损坏副本）。
   输出：data/backups/<name>-<YYYYMMDD-HHMMSS>.db（先写 .tmp 再原子 rename）。
   --keep N：每个前缀保留最近 N 份（默认 14），超出清理最老。 */
"use strict";

const fs = require("fs");
const path = require("path");
const sqlite = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUT = path.join(ROOT, "data", "backups");

function parseArgs(argv) {
  const args = { db: "both", out: DEFAULT_OUT, keep: 14 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") { args.db = argv[++i]; }
    else if (a === "--out") { args.out = path.resolve(argv[++i]); }
    else if (a === "--keep") { args.keep = Number(argv[++i]) || 14; }
    else if (a === "--help" || a === "-h") { args.help = true; }
  }
  return args;
}

function stamp(ms) {
  const d = new Date(ms);
  const p2 = function (n) { return (n < 10 ? "0" : "") + n; };
  return "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
    "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

function pruneOld(outDir, prefix, keep) {
  const files = fs.readdirSync(outDir)
    .filter(function (f) { return f.indexOf(prefix + "-") === 0 && f.endsWith(".db"); })
    .sort();
  const extra = files.length - keep;
  for (let i = 0; i < extra; i++) {
    try { fs.unlinkSync(path.join(outDir, files[i])); } catch (e) { /* 尽力 */ }
  }
  return Math.max(0, extra);
}

async function backupOne(sourcePath, outDir, prefix, keep, now) {
  if (!fs.existsSync(sourcePath)) {
    return { skipped: true, reason: "数据库不存在：" + sourcePath };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, prefix + "-" + stamp(now) + ".db");
  const tmp = dest + ".tmp-" + process.pid;
  const src = new sqlite.DatabaseSync(sourcePath);
  try {
    await sqlite.backup(src, tmp);
    fs.renameSync(tmp, dest);
  } finally {
    try { src.close(); } catch (e) { /* 尽力 */ }
    try { if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); } } catch (e) { /* 尽力 */ }
  }
  const pruned = pruneOld(outDir, prefix, keep);
  return { ok: true, dest: dest, size: fs.statSync(dest).size, pruned: pruned };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node tools/db/backup.js [--db telemetry|samples|both] [--out <dir>] [--keep N]");
    process.exit(0);
  }
  const targets = [];
  if (args.db === "telemetry" || args.db === "both") {
    targets.push({ prefix: "telemetry", file: path.join(ROOT, "data", "telemetry", "telemetry.db") });
  }
  if (args.db === "samples" || args.db === "both") {
    targets.push({ prefix: "samples", file: path.join(ROOT, "data", "samples", "samples.db") });
  }
  const now = Date.now();
  let failed = false;
  for (const t of targets) {
    try {
      const r = await backupOne(t.file, args.out, t.prefix, args.keep, now);
      if (r.skipped) {
        console.log("[跳过] " + t.prefix + "：" + r.reason);
      } else {
        console.log("[OK] " + t.prefix + " → " + r.dest +
          "（" + Math.round(r.size / 1024) + " KiB，清理旧备份 " + r.pruned + " 份）");
      }
    } catch (e) {
      failed = true;
      console.error("[失败] " + t.prefix + "：" + String((e && e.message) || e));
    }
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) { main(); }

module.exports = { backupOne: backupOne, parseArgs: parseArgs, DEFAULT_OUT: DEFAULT_OUT };
