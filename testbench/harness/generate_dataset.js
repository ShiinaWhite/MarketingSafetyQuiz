/* generate_dataset.js —— 自动生成基准测试数据集（harness 代码）。
   链路：bench-core 生成页面 → headless Chrome 真实渲染 → CDP 截图 → 图片 + Ground Truth + manifest。

   两个 Profile（同一批页面，两种成像条件）：
     ceiling    PNG 无损、1:1 像素、标准字号行距、100% 缩放（理论上限）
     app_ideal  JPEG quality 85、图像宽 2000px（与 App 整页拍照 Camera 设置 width:2000/quality:85 一致）

   用法：
     node testbench/harness/generate_dataset.js                      # 全量 150 页 × 2 Profile
     node testbench/harness/generate_dataset.js --limit 3            # 先跑 3 页验证
     node testbench/harness/generate_dataset.js --profile ceiling    # 只跑一个 Profile
     node testbench/harness/generate_dataset.js --source mock        # 用公开模拟题库
   产物全部落在 testbench/.generated/（已 gitignore）。 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const Bench = require("../bench-core.js");
const plan = require("./pageplan.js");

const ROOT = path.resolve(__dirname, "..");            // testbench/
const OUT = path.join(ROOT, ".generated");
const IMAGES = path.join(OUT, "images");
const GT = path.join(OUT, "groundtruth");
const PROFILES = {
  ceiling: { ext: "png", format: "png", quality: 0, scale: 1, desc: "PNG 无损 1:1" },
  ...Object.fromEntries([
    ["r1600q85", 1600, 85], ["r2400q85", 2400, 85], ["r3000q85", 3000, 85],
    ["r3000q95", 3000, 95], ["r3600q90", 3600, 90], ["r4000q90", 4000, 90],
    ["png2400", 2400, 0], ["png3000", 3000, 0]
  ].map(([name, w, q]) => {
    const fmt = name.startsWith("png") ? "png" : "jpeg";
    return [name, { ext: fmt === "png" ? "png" : "jpg", format: fmt, quality: q,
      scale: w / 720, desc: (fmt === "png" ? "PNG " : "JPEG q" + q + " ") + w + "px" }];
  })),
  app_ideal: { ext: "jpg", format: "jpeg", quality: 85, scale: 2000 / 720, desc: "JPEG q85 宽2000px" },
  camera_stress: { ext: "jpg", format: "jpeg", quality: 70, scale: 2000 / 720, stress: true,
    desc: "模拟拍摄退化（旋转/透视/模糊/亮度对比度/纹理/q70），非真实手机拍摄" }
};
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? (process.argv[i + 1] && process.argv[i + 1][0] !== "-" ? process.argv[i + 1] : true) : def;
}

/* ---------- 极简静态服务器（只服务 testbench 目录，无依赖） ---------- */
function startStaticServer(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") { p = "/index.html"; }
    const file = path.join(dir, p);
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server: server, port: server.address().port }));
  });
}

/* ---------- 极简 CDP 客户端（Node 内置 WebSocket，无第三方依赖） ---------- */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.sessionId = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = e => reject(new Error("CDP 连接失败: " + (e.message || e.type)));
      this.ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) { reject(new Error(m.error.message)); } else { resolve(m.result); }
        }
      };
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const msg = { id: id, method: method, params: params || {} };
    if (sessionId || this.sessionId) { msg.sessionId = sessionId || this.sessionId; }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP 超时: " + method)); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

async function waitForHttp(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) { return await r.json(); }
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("等待 " + url + " 超时");
}

function findChrome() {
  const explicit = arg("chrome", null);
  if (explicit && explicit !== true) { return explicit; }
  for (const c of CHROME_CANDIDATES) { if (fs.existsSync(c)) { return c; } }
  throw new Error("找不到 Chrome/Edge，可用 --chrome <路径> 指定");
}

/* ---------- 单页截图 ---------- */
async function capture(cdp, base, page, profile) {
  const prof = PROFILES[profile];
  const q = new URLSearchParams({
    seed: String(page.seed), type: page.type, count: String(page.count),
    start: String(page.startNumber), mode: page.mode, source: DATA_SOURCE, pool: page.pool || "all",
    fontSize: "md", lineHeight: "normal", pageWidth: "normal", spacing: "normal",
    indent: "1", headerStyle: "standard", zoom: "100", noise: "0"
  });
  if (page.splitAt) { q.set("splitAt", String(page.splitAt)); }
  if (prof.stress) { q.set("stress", "1"); }
  await cdp.send("Page.navigate", { url: base + "/harness/render.html?" + q.toString() });
  /* 等就绪（字体/布局稳定） */
  const t0 = Date.now();
  for (;;) {
    const r = await cdp.send("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true });
    if (r.result && r.result.value) { break; }
    if (Date.now() - t0 > 15000) { throw new Error("页面就绪超时 " + page.pageId); }
    await new Promise(r2 => setTimeout(r2, 60));
  }
  const err = await cdp.send("Runtime.evaluate", { expression: "window.__error || ''", returnByValue: true });
  if (err.result && err.result.value) { throw new Error("渲染失败 " + page.pageId + ": " + err.result.value); }
  /* 视口设成考试页主体尺寸（拍摄退化模式时四周留取景边距），截出来就是页面本身 */
  const size = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify(window.__size)", returnByValue: true });
  const dim = JSON.parse(size.result.value);
  const padRatio = prof.stress ? await cdp.send("Runtime.evaluate",
    { expression: "window.__pad || 0", returnByValue: true }).then(r => r.result.value) : 0;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: Math.round(dim.width * (1 + padRatio * 2)),
    height: Math.round(dim.height * (1 + padRatio * 2)),
    deviceScaleFactor: prof.scale, mobile: false
  });
  await new Promise(r => setTimeout(r, 60));
  const shot = await cdp.send("Page.captureScreenshot",
    prof.format === "png" ? { format: "png", captureBeyondViewport: false }
      : { format: "jpeg", quality: prof.quality, captureBeyondViewport: false });
  return { base64: shot.data, width: dim.width, height: dim.height };
}

/* ---------- 主流程 ---------- */
let DATA_SOURCE = "private";

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function main() {
  const limit = arg("limit", 0);
  const onlyProfile = arg("profile", "both");
  DATA_SOURCE = arg("source", "private") === "mock" ? "mock" : "private";
  const profiles = onlyProfile === "both" ? ["ceiling", "app_ideal"] : [String(onlyProfile)];
  profiles.forEach(p => { if (!PROFILES[p]) { throw new Error("未知 Profile: " + p); } });

  const dataFile = DATA_SOURCE === "private" ? "private_questions.json" : "mock_questions.json";
  const dataPath = path.join(ROOT, dataFile);
  if (!fs.existsSync(dataPath)) { throw new Error("缺少数据源 " + dataPath); }
  const data = Bench.normalizeQuestions(JSON.parse(fs.readFileSync(dataPath, "utf8")));
  console.log("[数据源] " + DATA_SOURCE + " 共 " + data.length + " 题");

  /* 计划：150 页 + 补齐页（392 全覆盖） */
  let pages = plan.buildPlan();
  /* 先算出每页实际题目（供覆盖率统计），再补齐 */
  const resolvePage = p => Bench.buildPage({
    data: data, seed: p.seed, type: p.type, count: p.count, startNumber: p.startNumber,
    mode: p.mode, splitAt: p.splitAt, pool: p.pool, mustInclude: p.mustInclude
  });
  pages.forEach(p => {
    const built = resolvePage(p);
    p.bankIds = built.questions.map(q => q.bankId);
  });
  let cov = plan.coverageOf(pages, data);
  const added = plan.topUpCoverage(pages, data);
  added.forEach(p => { p.bankIds = resolvePage(p).questions.map(q => q.bankId); });
  cov = plan.coverageOf(pages, data);
  console.log("[计划] " + plan.ROUND_SEEDS.length + " 轮 × " + plan.PAGES_PER_ROUND + " 页 = " +
    (plan.ROUND_SEEDS.length * plan.PAGES_PER_ROUND) + " 页，补齐 " + added.length +
    " 页 → 共 " + pages.length + " 页；题库覆盖 " + cov.used + "/" + cov.total);
  if (limit) { pages = pages.slice(0, parseInt(limit, 10)); console.log("[限制] 只跑前 " + pages.length + " 页"); }

  [IMAGES, GT].forEach(d => fs.mkdirSync(d, { recursive: true }));
  profiles.forEach(p => fs.mkdirSync(path.join(IMAGES, p), { recursive: true }));

  const srv = await startStaticServer(ROOT);
  const chrome = findChrome();
  const port = await freePort();
  /* 每次运行用独立 profile 目录，避免上次残留的 DevToolsActivePort / 目录锁 */
  const profileDir = path.join(OUT, "chrome-profile-" + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(chrome, [
    "--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + profileDir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--force-device-scale-factor=1", "--force-color-profile=srgb", "--hide-scrollbars",
    "--disable-gpu", "--window-size=1200,900", "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let chromeErr = "";
  child.stderr.on("data", d => { chromeErr += d.toString().slice(0, 400); });
  let cdp = null;
  const base = "http://127.0.0.1:" + srv.port;
  /* manifest 按 profile 合并：补充生成新 Profile 时保留已有 Profile 的条目与图片索引 */
  const manifestPath = path.join(OUT, "manifest.json");
  const prevManifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const prevByPage = {};
  if (prevManifest) { (prevManifest.pages || []).forEach(pe => { prevByPage[pe.pageId] = pe; }); }
  const manifest = { generatedAt: new Date().toISOString(), source: DATA_SOURCE, bankSize: data.length,
    plannedPages: plan.ROUND_SEEDS.length * plan.PAGES_PER_ROUND, topUpPages: added.length,
    coverage: { used: cov.used, total: cov.total },
    profiles: prevManifest ? prevManifest.profiles : {}, pages: [] };


  /* 单页渲染+截图（含 GT 落盘），失败可重试 */
  async function renderOne(p, renav) {
    const built = resolvePage(p);
    const gt = Bench.buildGroundTruth(built, {
      source: DATA_SOURCE, display: { fontSize: "md", lineHeight: "normal", pageWidth: "normal",
        spacing: "normal", indent: true, headerStyle: "standard", zoom: 100, noise: false }
    });
    const gtFile = path.join(GT, p.pageId + ".json");
    fs.writeFileSync(gtFile, JSON.stringify(gt, null, 2), "utf8");
    const entry = { pageId: p.pageId, round: p.round, seed: p.seed, type: p.type, mode: p.mode,
      count: p.count, startNumber: p.startNumber, splitAt: p.splitAt, topUp: !!p.topUp,
      gt: path.relative(OUT, gtFile).replace(/\\/g, "/"), images: (prevByPage[p.pageId] || {}).images || {} };
    for (const prof of profiles) {
      const shot = await capture(cdp, base, p, prof);
      const rel = path.join(prof, p.pageId + "." + PROFILES[prof].ext);
      fs.writeFileSync(path.join(IMAGES, rel), Buffer.from(shot.base64, "base64"));
      entry.images[prof] = { file: rel.replace(/\\/g, "/"), cssWidth: shot.width, cssHeight: shot.height };
    }
    return entry;
  }

  let done = 0;
  const total = pages.length * profiles.length;
  try {
    let version = null;
    try {
      version = await waitForHttp("http://127.0.0.1:" + port + "/json/version", 20000);
    } catch (e) {
      throw new Error("Chrome 调试端口未就绪。" + (chromeErr ? " Chrome 输出: " + chromeErr.trim() : ""));
    }
    cdp = await new CDP(version.webSocketDebuggerUrl).connect();
    /* 浏览器级 WebSocket 必须先附着到一个页面 target，否则 Page/Runtime 域不可用 */
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    cdp.sessionId = attached.sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    console.log("[Chrome] " + path.basename(chrome) + " headless · 调试端口 " + port +
      " · 静态服务端口 " + srv.port);

    for (const p of pages) {
      let entry = null, lastErr = null;
      for (let attempt = 0; attempt < 3 && !entry; attempt++) {
        try {
          entry = await renderOne(p, attempt > 0);
        } catch (e) {
          lastErr = e;
          console.log("[重试] " + p.pageId + " 第 " + (attempt + 1) + " 次失败: " + e.message);
          await new Promise(r => setTimeout(r, 800));
        }
      }
      if (!entry) { throw new Error(p.pageId + " 连续 3 次失败: " + (lastErr && lastErr.message)); }
      manifest.pages.push(entry);
      fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      done++;
      console.log("[截图] " + done + "/" + total + "  " + p.pageId);
    }
  } finally {
    if (cdp) { cdp.close(); }
    try { child.kill(); } catch (e) { }
    srv.server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
  }
  console.log("");
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const imgCount = pages.length * profiles.length;
  console.log("[完成] 图片 " + imgCount + " 张，Ground Truth " + pages.length + " 份");
  console.log("[输出] " + path.relative(process.cwd(), OUT));
  console.log("        images/<profile>/…   groundtruth/…   manifest.json");
  console.log("[下一步] 设备可用时：");
  console.log("        adb push testbench/.generated/images /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/images");
  console.log("        cd android && gradlew.bat connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.profile=ceiling");
  console.log("        node testbench/harness/run_benchmark.js --profile ceiling");
}

if (require.main === module) {
  main().catch(e => { console.error("[失败] " + e.message); process.exit(1); });
}
module.exports = { PROFILES, startStaticServer, CDP, findChrome };
