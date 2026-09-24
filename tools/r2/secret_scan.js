#!/usr/bin/env node
/* secret_scan.js —— R2 / Cloudflare credential 静态扫描（R2_FAST_TRANSFER_V1，任务书第 32 节）

   运行：node tools/r2/secret_scan.js [--apk <path>]

   扫描范围：
     - Git tracked 文件（git ls-files，权威「会进仓库」集合）
     - 工作树未跟踪文件（排除 gitignored）
     - www/ 前端产物（会打进 APK 的 assets）
     - 已构建的 APK（strings / assets / resources.arsc 里的可打印串）
     - release/updates/dev/latest.json
     - run.json 样本（real_samples 抽样）

   检测目标：
     - 真实 R2 credential 值（从本机 .env.r2.local / 环境变量取，**只用于比对，不打印**）
     - AWS/R2 风格 access key id（AKIA + 16 位大写字母数字）
     - 形如 64 位 hex / 40 位 base64 的可疑 secret 赋值给 R2_/AWS_ 变量
     - Cloudflare API token 形态

   输出 R2_SECRET_HITS = N。命中时只报告文件与行号，**绝不打印匹配到的值**。

   退出码：0 = 无命中；1 = 有命中。 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..", "..");
const r2 = require("./r2.js");

const TEXT_EXT = /\.(js|mjs|cjs|json|java|kt|xml|html|css|md|bat|cmd|sh|txt|yml|yaml|toml|gradle|properties|example|gitignore)$/i;
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|build|\.gradle|_build|_local|release|real_samples|__pycache__)([\\/]|$)/;

const hits = [];
function record(kind, file, line) {
  hits.push({ kind: kind, file: file, line: line });
}

/* ---- 待检测的「真实值」：从本机 secret 装载，仅用于比对 ---- */
function realSecrets() {
  const out = [];
  const loaded = r2.loadConfig({ root: ROOT });
  if (loaded.ok) {
    if (loaded.config.accessKeyId) { out.push({ kind: "R2_ACCESS_KEY_ID", value: loaded.config.accessKeyId }); }
    if (loaded.config.secretAccessKey) { out.push({ kind: "R2_SECRET_ACCESS_KEY", value: loaded.config.secretAccessKey }); }
    if (loaded.config.accountId) { out.push({ kind: "R2_ACCOUNT_ID", value: loaded.config.accountId }); }
  }
  /* 腾讯云 COS（COS_SAMPLE_TRANSFER_POC）：SecretId/SecretKey 都要比对 */
  try {
    const cos = require("../cos/cos.js");
    const c = cos.loadConfig({ root: ROOT });
    if (c && c.ok) {
      if (c.config.accessKeyId) { out.push({ kind: "COS_SECRET_ID", value: c.config.accessKeyId }); }
      if (c.config.secretAccessKey) { out.push({ kind: "COS_SECRET_KEY", value: c.config.secretAccessKey }); }
    }
  } catch (e) { /* 无 COS 配置：跳过 */ }
  for (const k of ["R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "CLOUDFLARE_API_TOKEN",
    "MSQ_SAMPLE_WRITE_TOKEN", "COS_SECRET_ID", "COS_SECRET_KEY"]) {
    const v = (process.env[k] || "").trim();
    if (v.length >= 16) { out.push({ kind: k + " (env)", value: v }); }
  }
  return out;
}

/* 形态规则（不依赖真实值） */
const SHAPE_RULES = [
  { kind: "AWS/R2 access key id 形态", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "AWS/R2 access key id 形态(短)", re: /\bAKI[A-Z0-9]{17}\b/ },
  { kind: "Cloudflare API token 形态", re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]{0,80}(cloudflare|CF_API|CLOUDFLARE))/i },
  { kind: "R2_SECRET_ACCESS_KEY 被赋真实值",
    re: /R2_SECRET_ACCESS_KEY\s*[=:]\s*["']?([A-Za-z0-9+/=_-]{16,})/,
    ignoreIf: (m) => /^(your|REPLACE|CHANGE|xxx|\.\.\.)/i.test(m[1]) },
  { kind: "R2_ACCESS_KEY_ID 被赋真实值",
    re: /R2_ACCESS_KEY_ID\s*[=:]\s*["']?([A-Za-z0-9+/=_-]{16,})/,
    ignoreIf: (m) => /^(your|REPLACE|CHANGE|xxx|\.\.\.)/i.test(m[1]) },
  { kind: "COS_SECRET_KEY 被赋真实值",
    re: /COS_SECRET_KEY\s*[=:]\s*["']?([A-Za-z0-9+/=_-]{16,})/,
    ignoreIf: (m) => /^(your|REPLACE|CHANGE|xxx|\.\.\.)/i.test(m[1]) }
];

function scanText(kind, fileLabel, text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of SHAPE_RULES) {
      const m = rule.re.exec(line);
      if (!m) { continue; }
      if (rule.ignoreIf && rule.ignoreIf(m)) { continue; }
      /* .env.*.example 是模板，允许占位 */
      if (/\.env\.[a-z0-9]+\.example$/i.test(fileLabel)) { continue; }
      record(rule.kind, fileLabel, i + 1);
    }
    for (const s of SECRETS) {
      if (s.value && line.indexOf(s.value) >= 0) {
        record("真实值泄漏：" + s.kind, fileLabel, i + 1);
      }
    }
  }
}

let SECRETS = [];

/* ---- 收集待扫描文本文件 ---- */
function gitTracked() {
  const r = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) { return null; }
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP_DIR.test(full)) { continue; }
    if (e.isDirectory()) { walk(full, acc); }
    else if (TEXT_EXT.test(e.name)) { acc.push(full); }
  }
  return acc;
}

/* ---- APK 扫描：取可打印 ASCII 串 + 解压 assets 里的文本 ---- */
function printableStrings(buf, minLen) {
  const out = [];
  let cur = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7F) { cur += String.fromCharCode(b); }
    else {
      if (cur.length >= (minLen || 12)) { out.push(cur); }
      cur = "";
    }
  }
  if (cur.length >= (minLen || 12)) { out.push(cur); }
  return out;
}

function scanApk(apkPath) {
  const label = path.relative(ROOT, apkPath);
  if (!fs.existsSync(apkPath)) {
    console.log("  [skip] APK 不存在：" + label);
    return false;
  }
  const buf = fs.readFileSync(apkPath);
  /* 1) 整包可打印串 */
  const strs = printableStrings(buf, 16);
  for (let i = 0; i < strs.length; i++) {
    for (const s of SECRETS) {
      if (s.value && strs[i].indexOf(s.value) >= 0) { record("APK 内真实值泄漏：" + s.kind, label, 0); }
    }
    for (const rule of SHAPE_RULES) {
      if (rule.re.test(strs[i])) {
        if (rule.ignoreIf && rule.ignoreIf(rule.re.exec(strs[i]))) { continue; }
        record("APK 内形态命中：" + rule.kind, label, 0);
      }
    }
  }
  /* 2) assets/ 里的 JS（会直接跑在 WebView 里） */
  let assetsFound = 0;
  try {
    const cd = findZipEntries(buf);
    for (const e of cd) {
      if (!/^assets\/.*\.(js|json|html|css)$/.test(e.name)) { continue; }
      let text = null;
      try {
        const data = readZipEntry(buf, e);
        if (data) { text = data.toString("utf8"); assetsFound++; }
      } catch (err) { /* 单条失败跳过 */ }
      if (text) { scanText("apk", label + "!" + e.name, text); }
    }
  } catch (e) { /* APK 结构异常 */ }
  console.log("  [apk] " + label + "：扫描 " + strs.length + " 个字符串、" +
    assetsFound + " 个 assets 文本文件");
  return true;
}

function findZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { return []; }
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = cdOffset;
  const out = [];
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { break; }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    out.push({
      name: buf.slice(p + 46, p + 46 + nameLen).toString("utf8"),
      method: method, compSize: compSize, localOffset: localOffset
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readZipEntry(buf, entry) {
  const lNameLen = buf.readUInt16LE(entry.localOffset + 26);
  const lExtraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + lNameLen + lExtraLen;
  const data = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) { return data; }
  if (entry.method === 8) { return zlib.inflateRawSync(data); }
  return null;
}

function parseArgs(argv) {
  const a = { apk: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--apk") { a.apk.push(argv[++i]); }
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  SECRETS = realSecrets();
  console.log("== R2 / Cloudflare credential 静态扫描 ==");
  console.log("用于比对的真实值来源数量：" + SECRETS.length +
    "（" + (SECRETS.length ? SECRETS.map((s) => s.kind).join(", ") : "无 —— 未配置 R2，仅做形态扫描") + "）");
  console.log("（下面只报告文件名与行号，绝不打印匹配到的值）\n");

  /* 1) Git tracked */
  const tracked = gitTracked();
  if (tracked === null) {
    console.log("[警告] git ls-files 失败：跳过 tracked 扫描");
  } else {
    let scanned = 0;
    for (const rel of tracked) {
      const full = path.join(ROOT, rel);
      if (!TEXT_EXT.test(rel)) { continue; }
      let text;
      try { text = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
      scanned++;
      scanText("git", rel, text);
    }
    console.log("  [git] 扫描 " + scanned + " 个 tracked 文本文件");
  }

  /* 2) 工作树（含未跟踪，排除 gitignored） */
  const treeFiles = walk(ROOT, []);
  let treeScanned = 0;
  for (const full of treeFiles) {
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
    treeScanned++;
    scanText("tree", path.relative(ROOT, full), text);
  }
  console.log("  [tree] 扫描 " + treeScanned + " 个工作树文本文件");

  /* 3) 前端产物（www/，会进 APK assets） */
  const wwwFiles = walk(path.join(ROOT, "www"), []);
  let wwwScanned = 0;
  for (const full of wwwFiles) {
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
    wwwScanned++;
    scanText("www", path.relative(ROOT, full), text);
  }
  console.log("  [www] 扫描 " + wwwScanned + " 个前端文件");

  /* 4) latest.json */
  const latestPath = path.join(ROOT, "release", "updates", "dev", "latest.json");
  if (fs.existsSync(latestPath)) {
    scanText("latest", path.relative(ROOT, latestPath), fs.readFileSync(latestPath, "utf8"));
    console.log("  [latest] 已扫描 release/updates/dev/latest.json");
  } else {
    console.log("  [latest] 无本地 latest.json");
  }

  /* 5) 样本 run.json 抽样 */
  const rsRoot = path.join(ROOT, "real_samples");
  if (fs.existsSync(rsRoot)) {
    let n = 0;
    const sampleRun = (dir, depth) => {
      if (depth > 3 || n >= 50) { return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (n >= 50) { return; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { sampleRun(full, depth + 1); }
        else if (e.name === "run.json") {
          n++;
          try { scanText("sample", path.relative(ROOT, full), fs.readFileSync(full, "utf8")); }
          catch (err) { /* 忽略 */ }
        }
      }
    };
    sampleRun(rsRoot, 0);
    console.log("  [samples] 抽样扫描 " + n + " 个 run.json");
  }

  /* 6) APK */
  const apkTargets = args.apk.length ? args.apk : [
    path.join(ROOT, "release", "营销安规刷题-DEV.apk"),
    path.join(ROOT, "release", "updates", "dev", "营销安规刷题-DEV.apk"),
    path.join(ROOT, "android", "app", "build", "outputs", "apk", "dev", "app-dev.apk")
  ];
  for (const a of apkTargets) { scanApk(a); }

  /* ---- 报告 ---- */
  console.log("\n" + "=".repeat(64));
  /* 去重（同一文件同一规则多次命中只报一次） */
  const uniq = new Map();
  for (const h of hits) {
    const k = h.kind + "|" + h.file;
    if (!uniq.has(k)) { uniq.set(k, h); }
  }
  const list = Array.from(uniq.values());
  if (list.length === 0) {
    console.log("R2_SECRET_HITS = 0");
    console.log("未发现 R2 / Cloudflare credential 泄漏 ✓");
  } else {
    console.log("R2_SECRET_HITS = " + list.length);
    console.log("（仅文件名与行号；匹配到的值一律不打印）");
    list.forEach((h) => console.log("  - [" + h.kind + "] " + h.file +
      (h.line ? ":" + h.line : "")));
  }
  console.log("=".repeat(64));
  process.exit(list.length ? 1 : 0);
}

main();
