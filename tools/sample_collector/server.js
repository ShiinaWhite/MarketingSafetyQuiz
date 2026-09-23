#!/usr/bin/env node
/* server.js —— MSQ 真实样本接收器（Sample Collector）
   零第三方依赖，仅 Node 标准库。启动：
     node tools/sample_collector/server.js [--host 0.0.0.0] [--port 8787] [--out <dir>]
   API：
     GET  /health                    存活探测
     POST /api/sample                { sampleId, photoDataUrl, manifest } → 落盘 capture.jpg + run.json
     POST /api/feedback              { sampleId, userFlag, screenNumbers? } → 落盘 feedback.json
     GET  /api/update/<channel>/latest   应用内更新 manifest（只读，channel ∈ {dev, stable}）
     GET  /api/update/<channel>/apk      应用内更新 APK（只读，固定文件名映射）
   更新接口安全：
     channel 白名单 + 固定文件名映射，无任意路径/查询参数，纯只读；
     每次请求实时读盘，发布新 APK 后 Collector 无需重启。
   安全：
     - sampleId 必须严格匹配 YYYYMMDD_HHMMSS_hex6，目录名由其派生，天然阻断 ../ 穿越；
     - 只接受 image/jpeg data URL；body 有大小上限；不执行任何上传内容；无任意文件读取接口；
     - 已存在的 sampleId 拒绝覆盖（409）；文件先写临时名再 rename，避免半文件。 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const SERVICE = "msq-sample-collector";
const VERSION = 1;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BODY_BYTES = 40 * 1024 * 1024; /* 40MB：base64 后约 30MB 照片，够 V1 用 */

const SAMPLE_ID_RE = /^([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})_[0-9a-f]{6}$/;
const JPEG_DATAURL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/* ---------------- 工具 ---------------- */

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* sampleId 合法且日期部分是真实日历日期（20260923 → 2026-09-23） */
function validSampleId(s) {
  if (typeof s !== "string") { return false; }
  const m = SAMPLE_ID_RE.exec(s);
  if (!m) { return false; }
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function sampleIdToDir(s) {
  return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) + "/" + s;
}

/* 只接受 image/jpeg base64 data URL，返回解码后的字节 */
function decodeJpegDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !JPEG_DATAURL_RE.test(dataUrl)) { return null; }
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch (e) { return null; }
  if (!buf || buf.length === 0 || !buf.slice(0, 2).equals(Buffer.from([0xFF, 0xD8]))) {
    return null;
  }
  return buf;
}

/* 解析 JPEG SOF 标记拿宽高（不解码整图；找不到返回 null） */
function jpegSize(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) { return null; }
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
        i += 2; continue;
      }
      if (marker === 0xD9 || marker === 0xDA) { break; } /* EOI / SOS 扫描开始，后面不看 */
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) { return null; }
      const isSof = (marker >= 0xC0 && marker <= 0xCF) &&
        marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof && i + 9 <= buf.length) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  } catch (e) { /* 结构异常按未知尺寸处理 */ }
  return null;
}

/* 临时文件 + rename，避免请求中断留下半文件 */
function writeFileAtomic(target, data) {
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 尽力清理 */ }
    throw e;
  }
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", function (c) {
      if (done) { return; } /* 超限后不再缓冲，排空剩余数据以便完整回出 413 */
      size += c.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      if (done) { return; }
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", function (e) {
      if (done) { return; }
      done = true;
      reject(e);
    });
  });
}

function lanIPv4Addresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (it) {
      if (it && it.family === "IPv4" && !it.internal) { out.push({ name: name, address: it.address }); }
    });
  });
  return out;
}

function parseArgs(argv) {
  const args = { host: DEFAULT_HOST, port: DEFAULT_PORT, out: null, maxBodyBytes: DEFAULT_MAX_BODY_BYTES };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") { args.host = argv[++i] || args.host; }
    else if (a === "--port") { args.port = Number(argv[++i]) || args.port; }
    else if (a === "--out") { args.out = argv[++i] || args.out; }
    else if (a === "--max-mb") { args.maxBodyBytes = (Number(argv[++i]) || 40) * 1024 * 1024; }
    else if (a === "--help" || a === "-h") { args.help = true; }
  }
  return args;
}

/* ---------------- HTTP 骨架 ---------------- */

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/* ---------------- 应用内更新（只读） ----------------
   channel 白名单 + 固定文件名映射：不存在任意路径读取/目录穿越面。
   文件每次请求实时读盘：publish.js 原子替换后 Collector 无需重启。 */
const UPDATE_CHANNELS = {
  dev: "营销安规刷题-DEV.apk",
  stable: "营销安规刷题.apk"
};

function sendLatest(res, updatesRoot, channel) {
  const file = path.join(updatesRoot, channel, "latest.json");
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) {
    sendJSON(res, 404, { ok: false, error: "update channel not available" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(raw);
}

function sendApk(res, updatesRoot, channel) {
  const file = path.join(updatesRoot, channel, UPDATE_CHANNELS[channel]);
  let stat;
  try { stat = fs.statSync(file); } catch (e) {
    sendJSON(res, 404, { ok: false, error: "update apk not available" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
    "ETag": '"' + stat.size + "-" + Math.floor(stat.mtimeMs) + '"',
    "Access-Control-Allow-Origin": "*"
  });
  const stream = fs.createReadStream(file);
  stream.on("error", function () { try { res.destroy(); } catch (e2) { /* 已断开 */ } });
  stream.pipe(res);
}

function handleCollector(req, res, ctx) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && p === "/health") {
    sendJSON(res, 200, { ok: true, service: SERVICE, version: VERSION });
    return;
  }

  const updateMatch = /^\/api\/update\/([^/]+)\/(latest|apk)$/.exec(p);
  if (req.method === "GET" && updateMatch) {
    const channel = decodeURIComponent(updateMatch[1]);
    if (!Object.prototype.hasOwnProperty.call(UPDATE_CHANNELS, channel)) {
      sendJSON(res, 404, { ok: false, error: "unknown update channel" });
      return;
    }
    if (updateMatch[2] === "latest") { sendLatest(res, ctx.updatesRoot, channel); }
    else { sendApk(res, ctx.updatesRoot, channel); }
    return;
  }

  if (req.method === "POST" && p === "/api/sample") {
    handleSample(req, res, ctx);
    return;
  }

  if (req.method === "POST" && p === "/api/feedback") {
    handleFeedback(req, res, ctx);
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST, OPTIONS", "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }
  sendJSON(res, 404, { ok: false, error: "not found" });
}

function handleSample(req, res, ctx) {
  readBody(req, ctx.maxBodyBytes).then(function (raw) {
    let body;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch (e) { sendJSON(res, 400, { ok: false, error: "malformed JSON" }); return; }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJSON(res, 400, { ok: false, error: "body must be a JSON object" }); return;
    }
    if (!validSampleId(body.sampleId)) {
      sendJSON(res, 400, { ok: false, error: "invalid sampleId" }); return;
    }
    const jpg = decodeJpegDataUrl(body.photoDataUrl);
    if (!jpg) {
      sendJSON(res, 400, { ok: false, error: "photoDataUrl must be an image/jpeg base64 data URL" }); return;
    }
    if (!body.manifest || typeof body.manifest !== "object" || Array.isArray(body.manifest)) {
      sendJSON(res, 400, { ok: false, error: "manifest must be a JSON object" }); return;
    }

    const dir = path.join(ctx.outRoot, sampleIdToDir(body.sampleId));
    if (fs.existsSync(dir)) {
      sendJSON(res, 409, { ok: false, error: "sampleId already exists" }); return;
    }

    const size = jpegSize(jpg);
    const run = Object.assign({}, body.manifest, {
      schemaVersion: VERSION,
      sampleId: body.sampleId,
      image: {
        filename: "capture.jpg",
        bytes: jpg.length,
        sha256: sha256Hex(jpg),
        width: size ? size.width : null,
        height: size ? size.height : null
      },
      collector: { version: VERSION, savedAt: new Date().toISOString() }
    });

    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, "capture.jpg"), jpg);
    writeFileAtomic(path.join(dir, "run.json"), JSON.stringify(run, null, 2));

    sendJSON(res, 201, {
      ok: true,
      sampleId: body.sampleId,
      bytes: jpg.length,
      sha256: run.image.sha256,
      width: run.image.width,
      height: run.image.height
    });
  }).catch(function (e) {
    if (e && e.code === "TOO_LARGE") {
      sendJSON(res, 413, { ok: false, error: "body too large" });
    } else {
      sendJSON(res, 500, { ok: false, error: "internal error" });
    }
  });
}

function handleFeedback(req, res, ctx) {
  readBody(req, ctx.maxBodyBytes).then(function (raw) {
    let body;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch (e) { sendJSON(res, 400, { ok: false, error: "malformed JSON" }); return; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJSON(res, 400, { ok: false, error: "body must be a JSON object" }); return;
    }
    if (!validSampleId(body.sampleId)) {
      sendJSON(res, 400, { ok: false, error: "invalid sampleId" }); return;
    }
    const dir = path.join(ctx.outRoot, sampleIdToDir(body.sampleId));
    if (!fs.existsSync(dir)) {
      sendJSON(res, 404, { ok: false, error: "sample not found" }); return;
    }
    const nums = Array.isArray(body.screenNumbers) ? body.screenNumbers
      .slice(0, 50).map(function (n) { return String(n).slice(0, 20); }) : [];
    const feedback = {
      sampleId: body.sampleId,
      userFlag: typeof body.userFlag === "string" ? body.userFlag.slice(0, 200) : "",
      screenNumbers: nums,
      savedAt: new Date().toISOString()
    };
    writeFileAtomic(path.join(dir, "feedback.json"), JSON.stringify(feedback, null, 2));
    sendJSON(res, 200, { ok: true, sampleId: body.sampleId });
  }).catch(function () {
    sendJSON(res, 500, { ok: false, error: "internal error" });
  });
}

/* ---------------- 入口 ---------------- */

function createCollector(options) {
  const opts = options || {};
  const ctx = {
    outRoot: path.resolve(opts.out || path.join(__dirname, "..", "..", "real_samples")),
    updatesRoot: path.resolve(opts.updatesRoot || path.join(__dirname, "..", "..", "release", "updates")),
    maxBodyBytes: opts.maxBodyBytes || DEFAULT_MAX_BODY_BYTES
  };
  const server = http.createServer(function (req, res) {
    try {
      handleCollector(req, res, ctx);
    } catch (e) {
      try { sendJSON(res, 500, { ok: false, error: "internal error" }); } catch (e2) { /* 已发送 */ }
    }
  });
  return {
    server: server,
    outRoot: ctx.outRoot,
    listen: function (host, port) {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(port, host, function () {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    }
  };
}

function printBanner(host, port, outRoot) {
  const lan = lanIPv4Addresses();
  console.log("Sample Collector running");
  console.log("");
  console.log("PC:");
  lan.forEach(function (it) {
    console.log("  http://" + it.address + ":" + port + "   (" + it.name + ")");
  });
  if (!lan.length) { console.log("  http://127.0.0.1:" + port + "   (no LAN IPv4 found)"); }
  console.log("");
  console.log("Health:");
  const first = lan.length ? lan[0].address : "127.0.0.1";
  console.log("  http://" + first + ":" + port + "/health");
  console.log("");
  console.log("Update (dev):");
  console.log("  http://" + first + ":" + port + "/api/update/dev/latest");
  console.log("");
  console.log("Output:");
  console.log("  " + outRoot);
}

module.exports = {
  SERVICE: SERVICE,
  VERSION: VERSION,
  createCollector: createCollector,
  validSampleId: validSampleId,
  decodeJpegDataUrl: decodeJpegDataUrl,
  jpegSize: jpegSize,
  sha256Hex: sha256Hex,
  parseArgs: parseArgs,
  lanIPv4Addresses: lanIPv4Addresses
};

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node tools/sample_collector/server.js [--host 0.0.0.0] [--port 8787] [--out <dir>] [--max-mb 40]");
    process.exit(0);
  }
  const collector = createCollector({ out: args.out, maxBodyBytes: args.maxBodyBytes });
  collector.listen(args.host, args.port).then(function (port) {
    printBanner(args.host, port, collector.outRoot);
  }, function (e) {
    console.error("failed to start: " + (e && e.message));
    process.exit(1);
  });
}
