#!/usr/bin/env node
/* server.js —— MSQ 真实样本接收器（Sample Collector）
   零第三方依赖，仅 Node 标准库。启动：
     node tools/sample_collector/server.js [--host 0.0.0.0] [--port 8787] [--out <dir>]
   API：
     GET  /health                    存活探测（匿名）
     POST /api/sample                { sampleId, photoDataUrl, manifest } → 落盘 capture.jpg + run.json
     POST /api/sample/init           R2 直传第 1 步：校验 + 返回 presigned PUT URL（小请求）
     POST /api/sample/commit         R2 直传第 2 步：HeadObject 验证 + 落 run.json（小请求）
     POST /api/feedback              { sampleId, userFlag, screenNumbers? } → 落盘 feedback.json
     GET  /api/update/<channel>/latest   应用内更新 manifest（只读，channel ∈ {dev, stable}）
     GET  /api/update/<channel>/apk      应用内更新 APK（只读，固定文件名映射）

   R2_FAST_TRANSFER_V1（大文件数据面迁移）：
     capture.jpg 走 手机 → R2 presigned PUT → 私有 sample bucket，完全不经 Tunnel；
     控制面（init/commit/feedback/auth/latest）仍是本 Collector 的小请求。
     commit 只做 HeadObject（存在/大小/metadata.sha256），绝不把 JPEG 拉回 PC；
     PC real_samples 由后台 mirror worker 从 R2 拉取（.tmp → SHA256 → rename）。
     R2 配置缺失时 init/commit FAIL CLOSED（503），legacy /api/sample 不受影响。

   写接口认证（PUBLIC_SAMPLE_AUTH_V1）：
     POST /api/sample、/api/sample/init、/api/sample/commit、/api/feedback
     需要 Authorization: Bearer <token>。
     token 来源：环境变量 MSQ_SAMPLE_WRITE_TOKEN 优先，其次 .secrets/sample-write-token。
     支持 CURRENT + PREVIOUS 双 token 轮换；secret 缺失时写接口 FAIL CLOSED（503），
     绝不自动退回匿名写入。鉴权先于读取 body。
   更新接口安全：
     channel 白名单 + 固定文件名映射，无任意路径/查询参数，纯只读；
     每次请求实时读盘，发布新 APK 后 Collector 无需重启。
   安全：
     - sampleId 必须严格匹配 YYYYMMDD_HHMMSS_hex6，目录名由其派生，天然阻断 ../ 穿越；
     - R2 object key 由服务器派生，客户端只能回传、不能自造路径；
     - legacy 只接受 image/jpeg data URL；body 有大小上限；不执行任何上传内容；
       无任意文件读取接口；
     - 已存在的 sampleId 拒绝覆盖（409）；文件先写临时名再 rename，避免半文件。 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { createR2Store } = require("./r2_store.js");
const { selectProvider } = require("./provider.js");

const SERVICE = "msq-sample-collector";
const VERSION = 1;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BODY_BYTES = 40 * 1024 * 1024; /* 40MB：base64 后约 30MB 照片，够 V1 用 */
/* R2 直传的 commit body 只有 run.json（OCR 文本），远小于 legacy 的 base64 照片 */
const DEFAULT_MAX_COMMIT_BODY_BYTES = 8 * 1024 * 1024;
/* init 只发几个标量字段 */
const DEFAULT_MAX_INIT_BODY_BYTES = 64 * 1024;

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
    else if (a === "--write-tokens") { args.writeTokens = String(argv[++i] || "").split(",").filter(Boolean); }
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

/* ---------------- 写接口认证 + 轻量限流（PUBLIC_SAMPLE_AUTH_V1） ----------------
   - 鉴权先于读取 body：认证失败立刻 401，不读 JPEG/不建目录/不写临时文件
   - token 比较先比长度再 crypto.timingSafeEqual（恒定时间）
   - 支持 CURRENT + PREVIOUS 双 token（轮换过渡）
   - 限流为固定窗口计数（内存）：认证成功 sample 30/min、feedback 120/min；
     未认证/失败统一 15/min（超出 429）
   - 日志/响应绝不输出 token 内容 */

const RATE_LIMIT_UNAUTH_PER_MIN = 15;
const RATE_LIMIT_SAMPLE_PER_MIN = 30;
const RATE_LIMIT_FEEDBACK_PER_MIN = 120;

const rateBuckets = new Map();   // key → { windowStart, count }

function rateLimit(key, limit, now) {
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 10_000) {
      for (const [k, b] of rateBuckets) {
        if (now - b.windowStart >= 120_000) { rateBuckets.delete(k); }
      }
    }
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/* 真实客户端 IP：仅当请求带 CF-Ray（明显经 Cloudflare/Tunnel）才信任
   CF-Connecting-IP；否则用 socket 地址。不信任客户端自填 X-Forwarded-For。 */
function clientIp(req) {
  if (req.headers["cf-ray"] && req.headers["cf-connecting-ip"]) {
    return String(req.headers["cf-connecting-ip"]).slice(0, 64);
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) { return false; }   // 先比长度
  return crypto.timingSafeEqual(a, b);            // 再恒定时间比较
}

/* 校验 Authorization: Bearer <token>；对 CURRENT/PREVIOUS 逐一恒定时间比对。
   返回 { ok } 或 { ok:false, fail: "malformed"|"invalid" }。 */
function checkWriteAuth(req, ctx) {
  if (ctx.allowAnonymousWrites) { return { ok: true, anonymous: true }; }
  if (!ctx.writeTokens.length) {
    return { ok: false, fail: "unavailable" };   // secret 缺失：FAIL CLOSED
  }
  const header = req.headers["authorization"] || "";
  const m = /^Bearer\s+([A-Za-z0-9._-]{32,128})$/.exec(header);
  if (!m) { return { ok: false, fail: "malformed" }; }
  for (const token of ctx.writeTokens) {
    if (safeTokenEqual(m[1], token)) { return { ok: true }; }
  }
  return { ok: false, fail: "invalid" };
}

function rejectWrite(res, ctx, req, code, error, extraHeaders) {
  const ip = clientIp(req);
  if (code === 401 && rateLimit("unauth:" + ip, RATE_LIMIT_UNAUTH_PER_MIN, Date.now()) === false) {
    code = 429;
    error = "rate limited";
  }
  const headers = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(JSON.stringify({ ok: false, error: error }));
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
  /* 客户端断开（手机/Tunnel 中断下载）时必须销毁读流，否则 Windows 上文件句柄
     会一直被持有，publish 的原子替换 rename 将持续 EPERM */
  res.on("close", function () { stream.destroy(); });
}

function handleCollector(req, res, ctx) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  const isSampleLegacyPost = req.method === "POST" && p === "/api/sample";
  const isSampleInitPost = req.method === "POST" && p === "/api/sample/init";
  const isSampleCommitPost = req.method === "POST" && p === "/api/sample/commit";
  const isFeedbackPost = req.method === "POST" && p === "/api/feedback";
  if (isSampleLegacyPost || isSampleInitPost || isSampleCommitPost || isFeedbackPost) {
    /* PUBLIC_SAMPLE_AUTH_V1：鉴权先于读取 body（不读 JPEG/不建目录/不写临时文件）。
       R2 直传同样受同一 device credential 约束——presigned URL 只在认证通过后发放。 */
    const auth = checkWriteAuth(req, ctx);
    if (!auth.ok) {
      const now = Date.now();
      const ip = clientIp(req);
      if (rateLimit("unauth:" + ip, RATE_LIMIT_UNAUTH_PER_MIN, now)) {
        rejectWrite(res, ctx, req, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      } else {
        rejectWrite(res, ctx, req, 429, "rate limited");
      }
      return;
    }
    const now = Date.now();
    const ip = clientIp(req);
    const limit = isFeedbackPost ? RATE_LIMIT_FEEDBACK_PER_MIN : RATE_LIMIT_SAMPLE_PER_MIN;
    if (!rateLimit("authed:" + ip + ":" + (isFeedbackPost ? "fb" : "sample"), limit, now)) {
      rejectWrite(res, ctx, req, 429, "rate limited");
      return;
    }
    if (isSampleInitPost) { handleSampleInit(req, res, ctx); }
    else if (isSampleCommitPost) { handleSampleCommit(req, res, ctx); }
    else if (isSampleLegacyPost) { handleSample(req, res, ctx); }
    else { handleFeedback(req, res, ctx, ctx.maxFeedbackBodyBytes); }
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST, OPTIONS", "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }
  sendJSON(res, 404, { ok: false, error: "not found" });
}

/* ---------------- R2 直传（R2_FAST_TRANSFER_V1） ----------------
   Step 1 /api/sample/init   ：小请求，校验 + 服务器派生 key + 签发 presigned PUT
   Step 2 /api/sample/commit ：小请求，HeadObject 验证 + 落 run.json（capture 由后台镜像）
   两步都已通过 Device Auth（见 handleCollector 的写接口分支）。
   JPEG 本身只走 手机 → R2，绝不经过本进程。 */

function parseJsonBody(raw) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch (e) { return { ok: false, error: "malformed JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  return { ok: true, body: body };
}

function handleSampleInit(req, res, ctx) {
  if (!ctx.r2 || !ctx.r2.available()) {
    /* FAIL CLOSED：R2 未配置时不退回隧道大文件上传，也不假装成功 */
    sendJSON(res, 503, { ok: false, error: "sample upload backend unavailable" });
    return;
  }
  readBody(req, ctx.maxInitBodyBytes).then(function (raw) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJSON(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.body;
    if (!validSampleId(body.sampleId)) {
      sendJSON(res, 400, { ok: false, error: "invalid sampleId" }); return;
    }
    const r = ctx.r2.initSample({
      sampleId: body.sampleId,
      captureSha256: body.captureSha256,
      captureSize: body.captureSize,
      contentType: body.contentType
    });
    if (!r.ok) { sendJSON(res, r.status, { ok: false, error: r.error }); return; }
    sendJSON(res, 200, {
      ok: true,
      sampleId: r.sampleId,
      objectKey: r.objectKey,
      presignedPutUrl: r.presignedPutUrl,
      expiresAt: r.expiresAt,
      expiresInSeconds: r.expiresInSeconds,
      requiredHeaders: r.requiredHeaders
    });
  }).catch(function (e) {
    if (e && e.code === "TOO_LARGE") { sendJSON(res, 413, { ok: false, error: "body too large" }); }
    else { sendJSON(res, 500, { ok: false, error: "internal error" }); }
  });
}

function handleSampleCommit(req, res, ctx) {
  if (!ctx.r2 || !ctx.r2.available()) {
    sendJSON(res, 503, { ok: false, error: "sample upload backend unavailable" });
    return;
  }
  readBody(req, ctx.maxCommitBodyBytes).then(function (raw) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJSON(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.body;
    if (!validSampleId(body.sampleId)) {
      sendJSON(res, 400, { ok: false, error: "invalid sampleId" }); return;
    }
    return ctx.r2.commitSample({
      sampleId: body.sampleId,
      objectKey: body.objectKey,
      captureSha256: body.captureSha256,
      captureSize: body.captureSize,
      manifest: body.manifest
    }).then(function (r) {
      if (!r.ok) { sendJSON(res, r.status, Object.assign({ ok: false }, r)); return; }
      sendJSON(res, r.status, {
        ok: true,
        alreadyCommitted: r.alreadyCommitted === true,
        sampleId: r.sampleId,
        objectKey: r.objectKey,
        captureSha256: r.captureSha256,
        mirrorStatus: r.mirrorStatus
      });
    });
  }).catch(function (e) {
    if (e && e.code === "TOO_LARGE") { sendJSON(res, 413, { ok: false, error: "body too large" }); }
    else { sendJSON(res, 500, { ok: false, error: "internal error" }); }
  });
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
      /* 幂等（PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1）：at-least-once 重传是正常行为。
         同 sampleId + 同 capture 字节 → 200 alreadyExists（客户端视为上传成功）；
         同 sampleId 但内容不同 → 409 conflict（绝不覆盖已有数据）。 */
      const existingSha = (() => {
        try { return sha256Hex(fs.readFileSync(path.join(dir, "capture.jpg"))); }
        catch (e) { return null; }
      })();
      const incomingSha = sha256Hex(jpg);
      if (existingSha !== null && existingSha === incomingSha) {
        sendJSON(res, 200, {
          ok: true,
          alreadyExists: true,
          sampleId: body.sampleId,
          bytes: jpg.length,
          sha256: incomingSha
        });
        return;
      }
      sendJSON(res, 409, {
        ok: false,
        error: "sampleId already exists with different content",
        sampleId: body.sampleId,
        existingSha256: existingSha,
        incomingSha256: incomingSha
      });
      return;
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

/* feedback schema v2（REAL_SAMPLE_FEEDBACK_V2）：
   {
     schemaVersion: 2, sampleId, updatedAt,
     pageIssues:  [{ type }],                     // 白名单见 FEEDBACK_PAGE_TYPES
     blockIssues: [{ blockIndex, issue, ...稳定定位字段 }],
     legacy:      { userFlag, screenNumbers }     // 旧 v1 文件/请求的兼容保留
   }
   请求模型（幂等 upsert，兼容 v1 请求）：
     { sampleId, action:"set"|"remove", scope:"page", issueTypes:[...] }   // set=全量替换
     { sampleId, action:"set"|"remove", scope:"block", issue, blockIndex, block:{...} }
     { sampleId, userFlag, screenNumbers }                                  // 旧 App v1 请求
   同 key 重复 set 不产生重复项；remove 删除对应条目。 */
const FEEDBACK_PAGE_TYPES = ["missing_question", "wrong_screen_number", "wrong_page_type", "other"];
const FEEDBACK_BLOCK_ISSUES = ["wrong_answer"];

function emptyFeedbackV2(sampleId) {
  return { schemaVersion: 2, sampleId: sampleId, updatedAt: new Date().toISOString(),
    pageIssues: [], blockIssues: [], legacy: null };
}

/* 读现有 feedback.json：v1 文件迁移为 v2（历史数据保留在 legacy，不破坏） */
function readFeedbackState(dir, sampleId) {
  const file = path.join(dir, "feedback.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return emptyFeedbackV2(sampleId); }
  let old;
  try { old = JSON.parse(raw); } catch (e) { return emptyFeedbackV2(sampleId); }
  if (!old || typeof old !== "object") { return emptyFeedbackV2(sampleId); }
  if (old.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      sampleId: sampleId,
      updatedAt: old.updatedAt || null,
      pageIssues: Array.isArray(old.pageIssues) ? old.pageIssues : [],
      blockIssues: Array.isArray(old.blockIssues) ? old.blockIssues : [],
      legacy: old.legacy || null
    };
  }
  /* v1 文件：{ sampleId, userFlag, screenNumbers, savedAt } */
  return {
    schemaVersion: 2,
    sampleId: sampleId,
    updatedAt: old.savedAt || null,
    pageIssues: [],
    blockIssues: [],
    legacy: {
      userFlag: typeof old.userFlag === "string" ? old.userFlag : "",
      screenNumbers: Array.isArray(old.screenNumbers) ? old.screenNumbers : []
    }
  };
}

function cleanBlockFields(block) {
  const b = (block && typeof block === "object" && !Array.isArray(block)) ? block : {};
  const str = (v, max) => (v === null || v === undefined) ? null : String(v).slice(0, max);
  return {
    screenNumber: str(b.screenNumber, 20),
    rawScreenNumber: str(b.rawScreenNumber, 20),
    numberSource: str(b.numberSource, 20),
    type: str(b.type, 20),
    finalAnswer: str(b.finalAnswer, 40),
    confidence: str(b.confidence, 20),
    finalBankId: (typeof b.finalBankId === "number" && isFinite(b.finalBankId)) ? b.finalBankId
      : (b.finalBankId === null ? null : str(b.finalBankId, 20)),
    matchedByOptions: b.matchedByOptions === true
  };
}

function handleFeedback(req, res, ctx, maxBodyBytes) {
  readBody(req, maxBodyBytes || ctx.maxBodyBytes).then(function (raw) {
    if (raw.length > (maxBodyBytes || ctx.maxBodyBytes)) {
      sendJSON(res, 413, { ok: false, error: "payload too large" }); return;
    }
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

    const state = readFeedbackState(dir, body.sampleId);

    /* ---- v1 请求兼容：{ userFlag, screenNumbers } ---- */
    if (body.action === undefined && body.scope === undefined && body.userFlag !== undefined) {
      state.legacy = {
        userFlag: typeof body.userFlag === "string" ? body.userFlag.slice(0, 200) : "",
        screenNumbers: Array.isArray(body.screenNumbers)
          ? body.screenNumbers.slice(0, 50).map(function (n) { return String(n).slice(0, 20); })
          : []
      };
      state.updatedAt = new Date().toISOString();
      writeFileAtomic(path.join(dir, "feedback.json"), JSON.stringify(state, null, 2));
      sendJSON(res, 200, { ok: true, sampleId: body.sampleId });
      return;
    }

    /* ---- v2 请求：action set/remove × scope page/block ---- */
    const action = body.action;
    const scope = body.scope;
    if (action !== "set" && action !== "remove") {
      sendJSON(res, 400, { ok: false, error: "action must be set|remove" }); return;
    }
    if (scope !== "page" && scope !== "block") {
      sendJSON(res, 400, { ok: false, error: "scope must be page|block" }); return;
    }

    if (scope === "page") {
      if (action === "set") {
        if (!Array.isArray(body.issueTypes) || body.issueTypes.length === 0 ||
            body.issueTypes.length > FEEDBACK_PAGE_TYPES.length) {
          sendJSON(res, 400, { ok: false, error: "issueTypes must be a non-empty array" }); return;
        }
        const uniq = {};
        for (const t of body.issueTypes) {
          if (typeof t !== "string" || FEEDBACK_PAGE_TYPES.indexOf(t) < 0) {
            sendJSON(res, 400, { ok: false, error: "unknown page issue type: " + String(t).slice(0, 40) });
            return;
          }
          uniq[t] = true;
        }
        state.pageIssues = Object.keys(uniq).sort().map(function (t) { return { type: t }; });
      } else {
        /* remove：缺省清空全部；带 issueTypes 则只删指定 */
        if (body.issueTypes === undefined) {
          state.pageIssues = [];
        } else {
          if (!Array.isArray(body.issueTypes)) {
            sendJSON(res, 400, { ok: false, error: "issueTypes must be an array" }); return;
          }
          const drop = {};
          for (const t of body.issueTypes) {
            if (typeof t !== "string" || FEEDBACK_PAGE_TYPES.indexOf(t) < 0) {
              sendJSON(res, 400, { ok: false, error: "unknown page issue type: " + String(t).slice(0, 40) });
              return;
            }
            drop[t] = true;
          }
          state.pageIssues = state.pageIssues.filter(function (p) { return !drop[p.type]; });
        }
      }
    } else {
      /* block */
      const issue = body.issue;
      if (typeof issue !== "string" || FEEDBACK_BLOCK_ISSUES.indexOf(issue) < 0) {
        sendJSON(res, 400, { ok: false, error: "unknown block issue" }); return;
      }
      const blockIndex = body.blockIndex;
      if (typeof blockIndex !== "number" || !isFinite(blockIndex) ||
          blockIndex < 0 || Math.floor(blockIndex) !== blockIndex || blockIndex > 999) {
        sendJSON(res, 400, { ok: false, error: "blockIndex must be an integer 0..999" }); return;
      }
      if (action === "set" && (!body.block || typeof body.block !== "object" || Array.isArray(body.block))) {
        sendJSON(res, 400, { ok: false, error: "block must be an object" }); return;
      }
      state.blockIssues = state.blockIssues.filter(function (b) {
        return !(b.blockIndex === blockIndex && b.issue === issue);
      });
      if (action === "set") {
        const entry = Object.assign({ blockIndex: blockIndex, issue: issue },
          cleanBlockFields(body.block));
        state.blockIssues.push(entry);
        state.blockIssues.sort(function (a, b2) { return a.blockIndex - b2.blockIndex; });
      }
    }

    state.updatedAt = new Date().toISOString();
    writeFileAtomic(path.join(dir, "feedback.json"), JSON.stringify(state, null, 2));
    sendJSON(res, 200, { ok: true, sampleId: body.sampleId, feedback: {
      pageIssues: state.pageIssues, blockIssues: state.blockIssues
    } });
  }).catch(function () {
    sendJSON(res, 500, { ok: false, error: "internal error" });
  });
}

/* ---------------- 入口 ---------------- */

function createCollector(options) {
  const opts = options || {};
  const outRoot = path.resolve(opts.out || path.join(__dirname, "..", "..", "real_samples"));
  const ctx = {
    outRoot: outRoot,
    updatesRoot: path.resolve(opts.updatesRoot || path.join(__dirname, "..", "..", "release", "updates")),
    maxBodyBytes: opts.maxBodyBytes || DEFAULT_MAX_BODY_BYTES,
    maxFeedbackBodyBytes: opts.maxFeedbackBodyBytes || (1 * 1024 * 1024),
    maxInitBodyBytes: opts.maxInitBodyBytes || DEFAULT_MAX_INIT_BODY_BYTES,
    maxCommitBodyBytes: opts.maxCommitBodyBytes || DEFAULT_MAX_COMMIT_BODY_BYTES,
    /* 写接口 token（CURRENT 在前，PREVIOUS 在后）。空数组 = FAIL CLOSED。
       allowAnonymousWrites 仅限测试显式开启，生产绝不使用。 */
    writeTokens: Array.isArray(opts.writeTokens) ? opts.writeTokens.filter(Boolean) : [],
    allowAnonymousWrites: opts.allowAnonymousWrites === true
  };
  /* 样本数据面后端（COS_SAMPLE_TRANSFER_V1）：COS 优先，R2 后备，都没有则 FAIL CLOSED。
     测试可注入 r2Store 或 providerResult；对象操作与 provider 无关。 */
  const providerResult = opts.providerResult || selectProvider({ root: opts.root });
  const r2Store = opts.r2Store || createR2Store({
    outRoot: outRoot,
    root: opts.root,
    config: providerResult.ok ? providerResult.config : undefined,
    provider: providerResult.provider || undefined,
    client: opts.r2Client,
    maxCaptureBytes: opts.maxCaptureBytes,
    presignTtlSeconds: opts.presignTtlSeconds,
    mirrorIntervalMs: opts.mirrorIntervalMs,
    log: opts.log
  });
  ctx.r2 = r2Store;
  ctx.providerName = r2Store.provider;
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
    r2: r2Store,
    providerName: r2Store.provider,
    listen: function (host, port) {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(port, host, function () {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close: function () {
      r2Store.stopMirrorWorker();
      return new Promise(function (resolve) {
        server.close(function () { resolve(); });
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
  checkWriteAuth: checkWriteAuth,
  validSampleId: validSampleId,
  decodeJpegDataUrl: decodeJpegDataUrl,
  jpegSize: jpegSize,
  sha256Hex: sha256Hex,
  parseArgs: parseArgs,
  lanIPv4Addresses: lanIPv4Addresses
};
/* 写接口 token：环境变量优先，其次 .secrets/sample-write-token。
   均缺失 → writeTokens 为空 → 写接口 FAIL CLOSED（503），读接口不受影响。 */
function loadWriteTokens(explicit) {
  if (Array.isArray(explicit)) { return explicit.filter(Boolean); }
  const fromEnv = (process.env.MSQ_SAMPLE_WRITE_TOKEN || "").trim();
  if (fromEnv) { return [fromEnv]; }
  try {
    const file = path.resolve(__dirname, "..", "..", ".secrets", "sample-write-token");
    const fromFile = fs.readFileSync(file, "utf8").trim();
    if (fromFile) { return [fromFile]; }
  } catch (e) { /* 文件不存在 */ }
  return [];
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node tools/sample_collector/server.js [--host 0.0.0.0] [--port 8787] [--out <dir>] [--max-mb 40]");
    process.exit(0);
  }
  const writeTokens = loadWriteTokens(args.writeTokens);
  if (!writeTokens.length) {
    console.warn("[警告] 未找到样本写接口 secret（MSQ_SAMPLE_WRITE_TOKEN / .secrets/sample-write-token）：");
    console.warn("[警告] 写接口 FAIL CLOSED —— POST /api/sample、/api/feedback 将返回 503。");
    console.warn("[警告] 运行 node tools/sample_auth/init_secret.js 生成后重启 Collector。");
  }
  const collector = createCollector({
    out: args.out,
    maxBodyBytes: args.maxBodyBytes,
    writeTokens: writeTokens
  });
  collector.listen(args.host, args.port).then(function (port) {
    printBanner(args.host, port, collector.outRoot);
    if (!writeTokens.length) {
      console.log("");
      console.log("[警告] 写接口处于 FAIL CLOSED 状态（见上方警告）。");
    }
    console.log("");
    if (collector.r2 && collector.r2.available()) {
      console.log("样本直传：ENABLED（provider=" + collector.providerName +
        "，capture.jpg 经 presigned PUT 直传私有 bucket）");
      console.log("  sample bucket : " + collector.r2.config.sampleBucket);
      console.log("  region        : " + (collector.r2.config.region || "(default)"));
      console.log("  presign TTL   : " + collector.r2.presignTtlSeconds + "s");
      console.log("  PC 镜像       : 后台 worker（不阻塞手机）");
      collector.r2.startMirrorWorker();
    } else {
      console.log("样本直传：DISABLED（" +
        ((collector.r2 && collector.r2.unavailableReason()) || "not configured") + "）");
      console.log("  → POST /api/sample/init 与 /api/sample/commit 将返回 503（FAIL CLOSED）");
      console.log("  → legacy POST /api/sample 不受影响，仍可用");
      console.log("  → 配置方法：tools/sample_collector/.env.cos.local（见 .env.cos.example）");
    }
  }, function (e) {
    console.error("failed to start: " + (e && e.message));
    process.exit(1);
  });
}
