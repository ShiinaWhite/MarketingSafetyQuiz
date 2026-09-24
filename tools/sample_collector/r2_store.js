#!/usr/bin/env node
/* r2_store.js —— Collector 侧 R2 逻辑（R2_FAST_TRANSFER_V1）

   职责：
   1. 由服务器派生 object key（客户端不得控制路径）
   2. 签发短时、单对象、仅 PUT 的 presigned URL
   3. commit 时用 HeadObject 验证对象（存在/大小/metadata.sha256），
      绝不把 JPEG 从 R2 拉回 PC 做同步校验（那会把大文件放回关键路径）
   4. 后台镜像 worker：R2 → real_samples/（.tmp → SHA256 → rename），
      绝不阻塞手机端 commit 响应；失败记录 mirror_pending 并自动重试

   安全：
   - 缺 R2 配置时 available()=false，调用方必须 FAIL CLOSED（503），不降级成匿名/隧道大文件
   - 日志只记 sampleId / objectKey / 过期时间，绝不打印 presigned query 签名 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const r2 = require("../r2/r2.js");

const SCHEMA_VERSION = 1;
const STATE_NAME = "r2state.json";
const CAPTURE_NAME = "capture.jpg";
const RUN_NAME = "run.json";

/* 单张 capture.jpg 上限。手机整页拍照 JPEG 通常 0.5~4MB，20MB 已非常宽松。 */
const DEFAULT_MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
/* presigned PUT 有效期（任务要求短时效，建议 5 分钟） */
const DEFAULT_PRESIGN_TTL_SECONDS = 300;
/* 镜像重试退避 */
const MIRROR_BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000];

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function validSha256(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

/* sampleId（YYYYMMDD_HHMMSS_hex6）→ 服务器派生 object key。
   日期段来自 sampleId 本身（已在 server.js 校验为真实日历日期）。
   客户端只能回传这个 key，不能自己造路径。 */
function objectKeyForSample(sampleId) {
  const date = sampleId.slice(0, 4) + "-" + sampleId.slice(4, 6) + "-" + sampleId.slice(6, 8);
  return "samples/" + date + "/" + sampleId + "/" + CAPTURE_NAME;
}

function sampleIdToDir(sampleId) {
  return sampleId.slice(0, 4) + "-" + sampleId.slice(4, 6) + "-" + sampleId.slice(6, 8) +
    "/" + sampleId;
}

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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

/* ---------------- R2 store ---------------- */

function createR2Store(options) {
  const opts = options || {};
  const outRoot = path.resolve(opts.outRoot || path.join(__dirname, "..", "..", "real_samples"));
  /* 测试可注入 config；生产按 env / .env.r2.local 装载 */
  const load = opts.config
    ? { ok: true, error: null, config: opts.config }
    : r2.loadConfig({ root: opts.root });
  const config = load.ok ? load.config : null;

  const maxCaptureBytes = opts.maxCaptureBytes || DEFAULT_MAX_CAPTURE_BYTES;
  const presignTtlSeconds = opts.presignTtlSeconds || DEFAULT_PRESIGN_TTL_SECONDS;
  /* 测试可注入：把 S3 动作指向本地 mock */
  const client = opts.client || {
    headObject: r2.headObject,
    putObject: r2.putObject,
    deleteObject: r2.deleteObject,
    getObjectToFile: r2.getObjectToFile,
    presignPutUrl: r2.presignPutUrl
  };
  const logger = opts.log || function () {};
  /* 镜像轮询间隔（毫秒）；0 = 不自动轮询（测试手动触发 tick） */
  const mirrorIntervalMs = opts.mirrorIntervalMs === undefined ? 30_000 : opts.mirrorIntervalMs;

  let mirrorTimer = null;
  let mirrorRunning = false;
  /* kickMirror 用 setImmediate 排队：在它真正开始前 whenMirrorIdle 也必须知道有待办 */
  let mirrorQueued = false;

  function available() {
    return !!config;
  }

  function unavailableReason() {
    return load.ok ? null : load.error;
  }

  function sampleDir(sampleId) {
    return path.join(outRoot, sampleIdToDir(sampleId));
  }

  function stateFile(sampleId) {
    return path.join(sampleDir(sampleId), STATE_NAME);
  }

  /* ---- Step 1: init —— 校验 + 派生 key + 签发 presigned PUT ---- */

  function initSample(input) {
    if (!config) {
      return { ok: false, status: 503, error: "sample upload backend unavailable" };
    }
    const sampleId = input.sampleId;
    const captureSha256 = input.captureSha256;
    const captureSize = Number(input.captureSize);
    const contentType = input.contentType || "image/jpeg";

    if (!validSha256(captureSha256)) {
      return { ok: false, status: 400, error: "invalid captureSha256" };
    }
    if (!Number.isFinite(captureSize) || captureSize <= 0 || Math.floor(captureSize) !== captureSize) {
      return { ok: false, status: 400, error: "invalid captureSize" };
    }
    if (captureSize > maxCaptureBytes) {
      return { ok: false, status: 413, error: "capture too large" };
    }
    if (contentType !== "image/jpeg") {
      return { ok: false, status: 400, error: "contentType must be image/jpeg" };
    }

    /* 幂等：同一 sampleId 永远映射到同一 objectKey（重试安全） */
    const objectKey = objectKeyForSample(sampleId);

    const signed = client.presignPutUrl(config, {
      bucket: config.sampleBucket,
      key: objectKey,
      expiresIn: presignTtlSeconds,
      contentType: contentType,
      metadata: {
        sha256: captureSha256,
        "sample-id": sampleId,
        "capture-size": String(captureSize)
      }
    });
    if (!signed.ok) {
      return { ok: false, status: 500, error: "failed to sign upload url" };
    }

    logger("r2 init sampleId=" + sampleId + " key=" + objectKey +
      " expiresAt=" + signed.expiresAt);

    return {
      ok: true,
      status: 200,
      sampleId: sampleId,
      objectKey: objectKey,
      presignedPutUrl: signed.url,
      expiresAt: signed.expiresAt,
      expiresInSeconds: signed.expiresInSeconds,
      requiredHeaders: signed.requiredHeaders
    };
  }

  /* ---- Step 2: commit —— HeadObject 验证后落 run.json，镜像交给后台 ---- */

  async function commitSample(input) {
    if (!config) {
      return { ok: false, status: 503, error: "sample upload backend unavailable" };
    }
    const sampleId = input.sampleId;
    const objectKey = input.objectKey;
    const captureSha256 = input.captureSha256;
    const captureSize = Number(input.captureSize);
    const manifest = input.manifest;

    if (!validSha256(captureSha256)) {
      return { ok: false, status: 400, error: "invalid captureSha256" };
    }
    if (!Number.isFinite(captureSize) || captureSize <= 0) {
      return { ok: false, status: 400, error: "invalid captureSize" };
    }
    /* objectKey 必须等于服务器派生的 key：杜绝客户端指向任意对象 */
    const expectedKey = objectKeyForSample(sampleId);
    if (objectKey !== expectedKey) {
      return { ok: false, status: 400, error: "objectKey does not match server-derived key" };
    }
    if (manifest === undefined || manifest === null || typeof manifest !== "object" ||
        Array.isArray(manifest)) {
      return { ok: false, status: 400, error: "manifest must be a JSON object" };
    }

    const dir = sampleDir(sampleId);
    const existing = readJson(stateFile(sampleId));

    /* 幂等：同 sampleId + 同 sha + 同 key → 200 alreadyCommitted，绝不重复写 */
    if (existing && existing.objectKey === objectKey &&
        existing.captureSha256 === captureSha256) {
      /* run.json 允许更新（manifest 可能带更多上下文），但捕获数据不重传 */
      writeRunJson(dir, sampleId, existing, manifest);
      kickMirror();
      return {
        ok: true, status: 200, alreadyCommitted: true, sampleId: sampleId,
        objectKey: objectKey, captureSha256: captureSha256,
        mirrorStatus: (existing.mirror && existing.mirror.status) || "pending"
      };
    }
    /* 同 sampleId 不同内容 → 409，绝不覆盖已有样本 */
    if (existing && existing.captureSha256 && existing.captureSha256 !== captureSha256) {
      return {
        ok: false, status: 409,
        error: "sampleId already committed with different content",
        sampleId: sampleId,
        existingSha256: existing.captureSha256,
        incomingSha256: captureSha256
      };
    }
    /* 旧 /api/sample 已直接落盘 capture.jpg：比对内容决定 200/409 */
    const legacyCapture = path.join(dir, CAPTURE_NAME);
    if (!existing && fs.existsSync(legacyCapture)) {
      let legacySha = null;
      try { legacySha = sha256Hex(fs.readFileSync(legacyCapture)); } catch (e) { legacySha = null; }
      if (legacySha === captureSha256) {
        const state = newState(sampleId, objectKey, captureSha256, captureSize, "done", legacySha);
        fs.mkdirSync(dir, { recursive: true });
        writeFileAtomic(stateFile(sampleId), JSON.stringify(state, null, 2));
        writeRunJson(dir, sampleId, state, manifest);
        return {
          ok: true, status: 200, alreadyCommitted: true, sampleId: sampleId,
          objectKey: objectKey, captureSha256: captureSha256, mirrorStatus: "done"
        };
      }
      return {
        ok: false, status: 409,
        error: "sampleId already exists with different content",
        sampleId: sampleId, existingSha256: legacySha, incomingSha256: captureSha256
      };
    }

    /* 真实验证：R2 HeadObject（不下载 JPEG） */
    let head;
    try {
      head = await client.headObject(config, config.sampleBucket, objectKey);
    } catch (e) {
      /* 网络层异常（R2 不可达/DNS/TLS）：如实 502，绝不假装成功 */
      return {
        ok: false, status: 502, error: "R2 unreachable",
        sampleId: sampleId, objectKey: objectKey
      };
    }
    if (!head.ok) {
      return {
        ok: false,
        status: head.notFound ? 404 : 502,
        error: head.notFound ? "capture object not found in R2" : "R2 head failed",
        sampleId: sampleId, objectKey: objectKey
      };
    }
    if (head.size !== captureSize) {
      /* 大小不符：对象不可信，删除避免留下垃圾，并拒绝 commit */
      await client.deleteObject(config, config.sampleBucket, objectKey).catch(function () {});
      return {
        ok: false, status: 409,
        error: "capture size mismatch",
        sampleId: sampleId, expectedSize: captureSize, actualSize: head.size
      };
    }
    const metaSha = head.metadata && head.metadata.sha256;
    if (!metaSha || metaSha.toLowerCase() !== captureSha256) {
      await client.deleteObject(config, config.sampleBucket, objectKey).catch(function () {});
      return {
        ok: false, status: 409,
        error: "capture sha256 metadata mismatch",
        sampleId: sampleId,
        expectedSha256: captureSha256,
        actualSha256: metaSha || null
      };
    }
    const metaSampleId = head.metadata && head.metadata["sample-id"];
    if (metaSampleId && metaSampleId !== sampleId) {
      await client.deleteObject(config, config.sampleBucket, objectKey).catch(function () {});
      return { ok: false, status: 409, error: "capture sample-id metadata mismatch" };
    }

    const state = newState(sampleId, objectKey, captureSha256, captureSize, "pending", null);
    state.r2 = {
      contentType: head.contentType || "image/jpeg",
      etag: head.etag || null,
      verifiedAt: new Date().toISOString()
    };
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(stateFile(sampleId), JSON.stringify(state, null, 2));
    writeRunJson(dir, sampleId, state, manifest);

    logger("r2 commit sampleId=" + sampleId + " key=" + objectKey +
      " bytes=" + captureSize + " mirror=pending");

    /* 后台镜像：绝不在 commit 响应路径里下载 */
    kickMirror();

    return {
      ok: true, status: 201, sampleId: sampleId, objectKey: objectKey,
      captureSha256: captureSha256, captureSize: captureSize, mirrorStatus: "pending"
    };
  }

  function newState(sampleId, objectKey, captureSha256, captureSize, mirrorStatus, mirroredSha) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sampleId: sampleId,
      objectKey: objectKey,
      captureSha256: captureSha256,
      captureSize: captureSize,
      contentType: "image/jpeg",
      committedAt: new Date().toISOString(),
      mirror: {
        status: mirrorStatus,
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        mirroredAt: mirrorStatus === "done" ? new Date().toISOString() : null,
        mirroredSha256: mirroredSha || null
      }
    };
  }

  function writeRunJson(dir, sampleId, state, manifest) {
    const existingRun = readJson(path.join(dir, RUN_NAME)) || {};
    const run = Object.assign({}, existingRun, manifest, {
      schemaVersion: 1,
      sampleId: sampleId,
      image: Object.assign({}, existingRun.image, {
        filename: CAPTURE_NAME,
        bytes: state.captureSize,
        sha256: state.captureSha256,
        storage: "r2",
        objectKey: state.objectKey
      }),
      collector: {
        version: 1,
        savedAt: new Date().toISOString(),
        transport: "r2-presigned-put"
      }
    });
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, RUN_NAME), JSON.stringify(run, null, 2));
    } catch (e) { /* run.json 写失败不阻塞 commit：镜像与状态已足以恢复 */ }
  }

  /* ---- 后台镜像 worker ---- */

  function listStateFiles() {
    const out = [];
    let dateDirs;
    try { dateDirs = fs.readdirSync(outRoot, { withFileTypes: true }); } catch (e) { return out; }
    for (const d of dateDirs) {
      if (!d.isDirectory()) { continue; }
      const datePath = path.join(outRoot, d.name);
      let sampleDirs;
      try { sampleDirs = fs.readdirSync(datePath, { withFileTypes: true }); } catch (e) { continue; }
      for (const s of sampleDirs) {
        if (!s.isDirectory()) { continue; }
        const f = path.join(datePath, s.name, STATE_NAME);
        if (fs.existsSync(f)) { out.push({ file: f, dir: path.join(datePath, s.name), sampleId: s.name }); }
      }
    }
    return out;
  }

  /* 处理一条待镜像样本。返回 "done" | "skipped" | "failed" | "notdue"。 */
  async function mirrorOne(entry, now) {
    const state = readJson(entry.file);
    if (!state || !state.objectKey) { return "skipped"; }
    const mirror = state.mirror || { status: "pending", attempts: 0 };
    if (mirror.status === "done") { return "skipped"; }
    if (mirror.nextRetryAt && Number(mirror.nextRetryAt) > now) { return "notdue"; }

    const target = path.join(entry.dir, CAPTURE_NAME);
    /* 本地已有且 sha 一致：无需下载（幂等/重启安全） */
    if (fs.existsSync(target)) {
      let localSha = null;
      try { localSha = sha256Hex(fs.readFileSync(target)); } catch (e) { localSha = null; }
      if (localSha && localSha === state.captureSha256) {
        mirror.status = "done";
        mirror.mirroredAt = mirror.mirroredAt || new Date().toISOString();
        mirror.mirroredSha256 = localSha;
        mirror.lastError = null;
        mirror.nextRetryAt = null;
        state.mirror = mirror;
        writeFileAtomic(entry.file, JSON.stringify(state, null, 2));
        return "done";
      }
    }

    const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
    let res;
    try {
      res = await client.getObjectToFile(config, config.sampleBucket, state.objectKey, tmp);
    } catch (e) {
      res = { ok: false, error: String(e && e.message) };
    }
    if (!res.ok) {
      try { fs.unlinkSync(tmp); } catch (e) { /* 尽力清理 */ }
      mirror.attempts = (mirror.attempts || 0) + 1;
      mirror.status = "failed";
      mirror.lastError = "download failed" + (res.status ? " HTTP " + res.status : "");
      mirror.nextRetryAt = now + MIRROR_BACKOFF_MS[
        Math.min(mirror.attempts - 1, MIRROR_BACKOFF_MS.length - 1)];
      state.mirror = mirror;
      try { writeFileAtomic(entry.file, JSON.stringify(state, null, 2)); } catch (e) { /* 下次再记 */ }
      logger("r2 mirror failed sampleId=" + entry.sampleId + " attempts=" + mirror.attempts);
      return "failed";
    }
    if (res.sha256 !== state.captureSha256) {
      try { fs.unlinkSync(tmp); } catch (e) { /* 尽力清理 */ }
      mirror.attempts = (mirror.attempts || 0) + 1;
      mirror.status = "failed";
      mirror.lastError = "sha256 mismatch after download";
      mirror.nextRetryAt = now + MIRROR_BACKOFF_MS[
        Math.min(mirror.attempts - 1, MIRROR_BACKOFF_MS.length - 1)];
      state.mirror = mirror;
      try { writeFileAtomic(entry.file, JSON.stringify(state, null, 2)); } catch (e) { /* 下次再记 */ }
      logger("r2 mirror sha mismatch sampleId=" + entry.sampleId);
      return "failed";
    }
    /* 校验通过才 rename 成正式文件（.tmp 绝不冒充完整样本） */
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* 尽力清理 */ }
      mirror.attempts = (mirror.attempts || 0) + 1;
      mirror.status = "failed";
      mirror.lastError = "rename failed";
      state.mirror = mirror;
      try { writeFileAtomic(entry.file, JSON.stringify(state, null, 2)); } catch (e2) { /* 下次再记 */ }
      return "failed";
    }
    mirror.status = "done";
    mirror.mirroredAt = new Date().toISOString();
    mirror.mirroredSha256 = res.sha256;
    mirror.lastError = null;
    mirror.nextRetryAt = null;
    state.mirror = mirror;
    writeFileAtomic(entry.file, JSON.stringify(state, null, 2));
    logger("r2 mirror done sampleId=" + entry.sampleId + " bytes=" + res.size);
    return "done";
  }

  /* 扫描一轮。Collector 重启后由这里继续未完成镜像。 */
  async function mirrorTick() {
    if (!config) { return { scanned: 0, done: 0, failed: 0 }; }
    if (mirrorRunning) { return { scanned: 0, done: 0, failed: 0, busy: true }; }
    mirrorRunning = true;
    mirrorQueued = false;
    const now = Date.now();
    const result = { scanned: 0, done: 0, failed: 0 };
    try {
      for (const entry of listStateFiles()) {
        result.scanned++;
        const r = await mirrorOne(entry, now);
        if (r === "done") { result.done++; }
        else if (r === "failed") { result.failed++; }
      }
    } finally {
      mirrorRunning = false;
    }
    return result;
  }

  /* 等待后台镜像安静下来（测试断言 / 优雅关闭用）。
     覆盖「已排队但尚未开始」与「正在跑」两种状态。 */
  async function whenMirrorIdle(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30_000);
    while ((mirrorRunning || mirrorQueued) && Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 5); });
    }
    return !(mirrorRunning || mirrorQueued);
  }

  function kickMirror() {
    if (!config) { return; }
    mirrorQueued = true;
    /* 立即跑一轮（不 await）：让刚 commit 的样本尽快落地 PC */
    setImmediate(function () {
      mirrorTick().catch(function () { /* 后台任务绝不冒泡 */ });
    });
  }

  function startMirrorWorker() {
    if (!config || mirrorTimer || !mirrorIntervalMs) { return; }
    mirrorTimer = setInterval(function () {
      mirrorTick().catch(function () { /* 忽略单轮失败 */ });
    }, mirrorIntervalMs);
    if (mirrorTimer.unref) { mirrorTimer.unref(); }
    /* 启动即扫一遍：Collector 重启后继续未镜像对象 */
    kickMirror();
  }

  function stopMirrorWorker() {
    if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; }
  }

  /* 单样本镜像状态（测试/诊断用） */
  function mirrorStatusOf(sampleId) {
    const st = readJson(stateFile(sampleId));
    if (!st) { return null; }
    return st.mirror ? st.mirror.status : null;
  }

  return {
    available: available,
    unavailableReason: unavailableReason,
    config: config,
    outRoot: outRoot,
    maxCaptureBytes: maxCaptureBytes,
    presignTtlSeconds: presignTtlSeconds,
    initSample: initSample,
    commitSample: commitSample,
    mirrorTick: mirrorTick,
    mirrorOne: mirrorOne,
    whenMirrorIdle: whenMirrorIdle,
    kickMirror: kickMirror,
    startMirrorWorker: startMirrorWorker,
    stopMirrorWorker: stopMirrorWorker,
    mirrorStatusOf: mirrorStatusOf,
    listStateFiles: listStateFiles,
    sampleDir: sampleDir,
    stateFile: stateFile
  };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  STATE_NAME: STATE_NAME,
  CAPTURE_NAME: CAPTURE_NAME,
  DEFAULT_MAX_CAPTURE_BYTES: DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_PRESIGN_TTL_SECONDS: DEFAULT_PRESIGN_TTL_SECONDS,
  MIRROR_BACKOFF_MS: MIRROR_BACKOFF_MS,
  objectKeyForSample: objectKeyForSample,
  sampleIdToDir: sampleIdToDir,
  validSha256: validSha256,
  sha256Hex: sha256Hex,
  createR2Store: createR2Store
};
