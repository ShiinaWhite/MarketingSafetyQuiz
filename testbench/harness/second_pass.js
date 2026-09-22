/* second_pass.js —— 低置信块局部二次 OCR（harness 代码）。
   第一遍整页 OCR → 分题 → 挑证据不足的块（low/none、题干过短、选项辅助、编号非 ocr 原文）
   → 按块的第一遍 OCR 行 bbox 换算 CSS 坐标，从同一确定性渲染里按 clip 高倍截取局部图
   → 设备端 ML Kit 二次识别 → Node 侧按"更好才替换"合并。

   用法：
     node testbench/harness/second_pass.js --profile app_ideal --capture
     node testbench/harness/second_pass.js --profile app_ideal --merge
   产物：testbench/.generated/second_pass/<profile>/ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const MSQ = require("../../www/js/core.js");
const Bench = require("../bench-core.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".generated");
const PAGE_CSS_WIDTH = 720;
const CROP_TARGET_WIDTH = 2000;
const PAD_LINES = 1.5;
process.env.MSYS_NO_PATHCONV = "1";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? (process.argv[i + 1] && process.argv[i + 1][0] !== "-" ? process.argv[i + 1] : true) : def;
}
function evalSet(pageId) {
  let h = 0;
  const s = String(pageId);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return (h % 100) < 70 ? "dev" : "holdout";
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function median(a) {
  if (!a.length) { return 0; }
  const v = a.slice().sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
}

class CDP {
  constructor(wsUrl) { this.id = 0; this.pending = new Map(); this.sessionId = null; this.wsUrl = wsUrl; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error("CDP 连接失败"));
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) { p.reject(new Error(m.error.message)); } else { p.resolve(m.result); }
        }
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    const msg = { id, method, params: params || {} };
    if (this.sessionId) { msg.sessionId = this.sessionId; }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP 超时")); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { } }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitForHttp(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) { return await r.json(); } } catch (e) { }
    await sleep(150);
  }
  throw new Error("等待 " + url + " 超时");
}
function startStaticServer(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}
function findChrome() {
  for (const c of ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]) {
    if (fs.existsSync(c)) { return c; }
  }
  throw new Error("找不到 Chrome/Edge");
}

/* 触发规则：证据不足的块才二次识别 */
function needSecondPass(b) {
  if (!b.matches || !b.matches.length) { return "no_match"; }
  if (b.confidence === "low" || b.confidence === "none") { return "low_conf"; }
  if (b.matches.assistedByOptions) { return "assisted"; }
  if (b.numberSource !== "ocr") { return "number_" + b.numberSource; }
  if (MSQ.normalizeOcrText(b.stemText || "").length < 12) { return "short_stem"; }
  return null;
}

async function captureCrops(profile) {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  const data = Bench.normalizeQuestions(JSON.parse(fs.readFileSync(
    path.join(ROOT, manifest.source === "private" ? "private_questions.json" : "mock_questions.json"), "utf8")));
  const idx = MSQ.buildBatchOcrIndex(data);
  const ocrLines = fs.readFileSync(path.join(OUT, "ocr", profile + ".jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const omap = new Map(ocrLines.filter(o => !o.header).map(o => [o.file, o]));
  /* 第一遍成像宽/CSS 宽：按 profile 名解析（r3000q85 -> 3000/720，app_ideal -> 2000/720） */
  const wm = /^r(\d+)q/.exec(profile) || /^(\d+)px/.exec(profile);
  const firstScale = wm ? (parseInt(wm[1], 10) / PAGE_CSS_WIDTH) : (profile === "ceiling" ? 1 : 2000 / PAGE_CSS_WIDTH);
  const cropDir = path.join(OUT, "second_pass", profile, "images");
  fs.mkdirSync(cropDir, { recursive: true });

  const jobs = [];
  const triggers = [];
  manifest.pages.forEach(page => {
    if (evalSet(page.pageId) !== "dev") { return; }
    const img = page.images[profile];
    if (!img) { return; }
    const o = omap.get(path.basename(img.file));
    if (!o || o.err || !o.lines) { return; }
    const lines = o.lines.map(l => ({ text: l.text, left: l.left || 0, top: l.top || 0, right: l.right || 0, bottom: l.bottom || 0 }));
    if (!lines.length) { return; }
    const lineH = median(lines.map(l => l.bottom - l.top)) || 40;
    const blocks = MSQ.splitPageOcrLines(lines, page.type);
    const res = MSQ.searchPageQuestionsByOcr(idx, lines, page.type, { limit: 3 });
    res.blocks.forEach((b, i) => {
      const why = needSecondPass(b);
      if (!why) { return; }
      const raw = blocks[i];
      if (!raw || raw.top === null || raw.top === undefined) { return; }
      const pad = lineH * PAD_LINES;
      const topCss = Math.max(0, (raw.top - pad) / firstScale);
      const botRaw = (raw.bottom == null || raw.bottom < raw.top) ? raw.top : raw.bottom;
      const bottomCss = (botRaw + pad) / firstScale;
      const height = Math.max(60, bottomCss - topCss);
      jobs.push({ cropFile: page.pageId + "_b" + i + ".jpg", pageId: page.pageId, blockIdx: i, why,
        clip: { x: 0, y: +topCss.toFixed(1), width: PAGE_CSS_WIDTH, height: +height.toFixed(1),
          scale: CROP_TARGET_WIDTH / PAGE_CSS_WIDTH } });
      triggers.push({ pageId: page.pageId, blockIdx: i, why });
    });
  });
  fs.writeFileSync(path.join(OUT, "second_pass", profile, "jobs.json"),
    JSON.stringify({ profile, cropTargetWidth: CROP_TARGET_WIDTH, padLines: PAD_LINES,
      triggered: triggers.length, triggers, jobs }, null, 1));
  console.log("触发二次 OCR 的块：" + jobs.length);

  const srv = await startStaticServer(ROOT);
  const chrome = findChrome();
  const port = await freePort();
  const profileDir = path.join(OUT, "chrome-sp-" + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(chrome, ["--headless=new", "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir, "--no-first-run", "--disable-extensions",
    "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-gpu", "about:blank"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let cdp = null;
  try {
    const version = await waitForHttp("http://127.0.0.1:" + port + "/json/version", 20000);
    cdp = await new CDP(version.webSocketDebuggerUrl).connect();
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    cdp.sessionId = attached.sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: PAGE_CSS_WIDTH, height: 3200, deviceScaleFactor: 1, mobile: false });
    let n = 0;
    for (const j of jobs) {
      const page = manifest.pages.find(p2 => p2.pageId === j.pageId);
      const q = new URLSearchParams({ seed: String(page.seed), type: page.type, count: String(page.count),
        start: String(page.startNumber), mode: page.mode, source: manifest.source, pool: page.pool || "all",
        fontSize: "md", lineHeight: "normal", pageWidth: "normal", spacing: "normal",
        indent: "1", headerStyle: "standard", zoom: "100", noise: "0" });
      if (page.splitAt) { q.set("splitAt", String(page.splitAt)); }
      await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + srv.port + "/harness/render.html?" + q.toString() });
      const t0 = Date.now();
      for (;;) {
        const r = await cdp.send("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true });
        if (r.result && r.result.value) { break; }
        if (Date.now() - t0 > 15000) { throw new Error("就绪超时 " + j.pageId); }
        await sleep(40);
      }
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, clip: j.clip, captureBeyondViewport: true });
      fs.writeFileSync(path.join(cropDir, j.cropFile), Buffer.from(shot.data, "base64"));
      n++;
      if (n % 25 === 0) { console.log("  裁图 " + n + "/" + jobs.length); }
    }
    console.log("裁图完成 " + n + " 张");
  } finally {
    if (cdp) { cdp.close(); }
    try { child.kill(); } catch (e) { }
    srv.server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
  }
}

async function main() {
  const profile = String(arg("profile", "app_ideal"));
  if (arg("capture", false)) {
    try { await captureCrops(profile); }
    catch (e) { console.error("[失败] " + e.message); process.exit(1); }
    return;
  }
  console.log("用法：second_pass.js --profile <p> --capture");
}
main();
