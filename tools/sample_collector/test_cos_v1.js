#!/usr/bin/env node
/* test_cos_v1.js —— COS_SAMPLE_TRANSFER_V1 端到端真实集成测试
   运行: node tools/sample_collector/test_cos_v1.js
   退出码: 0 = 全部通过；1 = 失败；3 = 无 credential（PENDING）

   覆盖 COS-V1-1 ~ COS-V1-15。真实写 COS bucket，测试对象用真实日期目录并全部清理。
   PC mirror 写入 os.tmpdir() 随机目录，绝不触碰真实 real_samples/。
   测试 Collector 固定监听 127.0.0.1:8799（绝不碰生产 8787）。

   不打印 Secret / 完整 presigned URL / 签名 query。 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const cos = require("../cos/cos.js");
const r2 = require("../r2/r2.js");
const { createCollector } = require("./server.js");
const { createR2Store, objectKeyForSample } = require("./r2_store.js");
const { selectProvider } = require("./provider.js");

const WRITE_TOKEN = "a".repeat(64);
const fails = [];
const pending = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function markPending(name, detail) {
  console.log(`  [PENDING] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  pending.push(name);
}
function section(t) { console.log(`\n== ${t} ==`); }

/* 结构合法的最小 JPEG（服务器/镜像都只做标记级与字节校验） */
function makeJpeg(width, height, filler) {
  const be16 = (n) => [(n >> 8) & 255, n & 255];
  const seg = (m, p) => [0xFF, m, ...be16(p.length + 2), ...p];
  const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const DQT = seg(0xDB, [0x00, ...new Array(64).fill(8)]);
  const SOF0 = seg(0xC0, [0x08, ...be16(height), ...be16(width), 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const DHT = seg(0xC4, [0x00, ...new Array(16).fill(0), 0x00]);
  const SOS = seg(0xDA, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]);
  const pad = [];
  for (let i = 0; i < (filler || 0); i++) { pad.push((i * 7) & 0xFF); }
  return Buffer.from([0xFF, 0xD8, ...APP0, ...DQT, ...SOF0, ...DHT, ...SOS, 0x00, 0x12, ...pad, 0xFF, 0xD9]);
}
function sha256Hex(b) { return crypto.createHash("sha256").update(b).digest("hex"); }

function request(port, method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1", port, method, path: p,
      headers: Object.assign(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}, headers || {})
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}
function json(r) { try { return JSON.parse(r.body.toString("utf8")); } catch (e) { return null; } }
function auth() { return { Authorization: "Bearer " + WRITE_TOKEN }; }

/* 真实 presigned PUT 到 COS（模拟手机原生流式上传） */
function presignedPut(url, body, requiredHeaders) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = https_request(u.hostname, "PUT", u.pathname + u.search, body, requiredHeaders);
    req.then(resolve, reject);
  });
}
function https_request(host, method, path, body, headers) {
  const https = require("https");
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: host, port: 443, method, path,
      headers: Object.assign({ "Content-Length": String(body.length) }, headers || {}),
      timeout: 120_000
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const loaded = cos.loadConfig({});
  if (!loaded.ok) {
    markPending("COS-V1 全部（credential 缺失）", loaded.error);
    console.log("\n无 COS credential，无法做真实集成测试（不伪造 PASS）。");
    process.exit(3);
  }
  const provider = selectProvider({ provider: "cos" });
  const cfg = provider.config;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-cosv1-"));
  let collector = null;
  const createdKeys = [];

  try {
    collector = createCollector({
      out: tmp, writeTokens: [WRITE_TOKEN],
      providerResult: provider,
      mirrorIntervalMs: 0            /* 测试手动驱动 mirror */
    });
    const port = await collector.listen("127.0.0.1", 8799);
    check("测试 Collector 监听 8799（生产 8787 不受影响）", port === 8799);
    check("provider = cos", collector.providerName === "cos", collector.providerName);

    const now = new Date();
    const pad2 = (n) => (n < 10 ? "0" : "") + n;
    const dateStr = String(now.getFullYear()) + pad2(now.getMonth() + 1) + pad2(now.getDate());
    const t = (n) => dateStr + "_0000" + String(n).padStart(2, "0") + "_" +
      crypto.randomBytes(3).toString("hex");
    const SID = t(1);
    const jpeg = makeJpeg(900, 1400, 4096);
    const sha = sha256Hex(jpeg);
    const expectedKey = objectKeyForSample(SID);

    /* ---------- COS-V1-1: init ---------- */
    section("COS-V1-1 init 成功");
    let r = await request(port, "POST", "/api/sample/init", {
      sampleId: SID, captureSha256: sha, captureSize: jpeg.length, contentType: "image/jpeg"
    }, auth());
    let init = json(r);
    check("V1-1a init → 200", r.status === 200, "status=" + r.status);
    check("V1-1b objectKey 由服务器派生", init && init.objectKey === expectedKey,
      init && init.objectKey);
    check("V1-1c presigned URL 指向 COS virtual-hosted",
      init && new URL(init.presignedPutUrl).host.indexOf(cfg.bucket + ".cos.") === 0);
    check("V1-1d TTL 300s", init && init.expiresInSeconds === 300);
    check("V1-1e URL path 与 objectKey 一致（单对象授权）",
      init && new URL(init.presignedPutUrl).pathname === "/" + init.objectKey);
    check("V1-1f URL 不含 SecretKey",
      init && init.presignedPutUrl.indexOf(cfg.secretAccessKey) < 0);

    /* ---------- COS-V1-2: Native PUT ---------- */
    section("COS-V1-2 Presigned PUT → COS 200");
    let put = await presignedPut(init.presignedPutUrl, jpeg, init.requiredHeaders);
    check("V1-2a PUT → 200", put.status === 200, "status=" + put.status);
    const head = await cos.headObject(cfg, cfg.bucket, expectedKey);
    check("V1-2b COS 上对象大小一致", head.ok && head.size === jpeg.length);
    check("V1-2c metadata.sha256 一致", head.ok && head.metadata.sha256 === sha);

    /* ---------- COS-V1-3: commit HeadObject 验证 ---------- */
    section("COS-V1-3 commit（HeadObject 验证，不下载 JPEG）");
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID, objectKey: expectedKey, captureSha256: sha,
      captureSize: jpeg.length,
      manifest: { pageType: "single", note: "cos-v1", ocrChars: 1234 }
    }, auth());
    let commit = json(r);
    check("V1-3a commit → 201", r.status === 201, "status=" + r.status);
    check("V1-3b mirror 状态 pending（后台，不阻塞响应）",
      commit && commit.mirrorStatus === "pending");

    /* ---------- COS-V1-4: run.json 保存 ---------- */
    section("COS-V1-4 run.json 保存");
    const runFile = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8), SID, "run.json");
    check("V1-4a run.json 已落盘", fs.existsSync(runFile));
    if (fs.existsSync(runFile)) {
      const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
      check("V1-4b run.json 含 r2 objectKey/sha256/storage",
        run.image && run.image.objectKey === expectedKey && run.image.sha256 === sha &&
        run.image.storage === "r2");
    }

    /* ---------- COS-V1-11: commit 幂等 ---------- */
    section("COS-V1-11 同 sample commit 重试幂等");
    const objCountBefore = await cos.listAllObjects(cfg, cfg.bucket, "samples/" +
      dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8) + "/" + SID + "/");
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID, objectKey: expectedKey, captureSha256: sha,
      captureSize: jpeg.length, manifest: { note: "retry" }
    }, auth());
    commit = json(r);
    check("V1-11a 重复 commit → 200 alreadyCommitted",
      r.status === 200 && commit && commit.alreadyCommitted === true, "status=" + r.status);
    const objCountAfter = await cos.listAllObjects(cfg, cfg.bucket, "samples/" +
      dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8) + "/" + SID + "/");
    check("V1-11b 未产生重复对象",
      objCountBefore.ok && objCountAfter.ok &&
      objCountBefore.contents.length === objCountAfter.contents.length);

    /* ---------- COS-V1-12: 同 sampleId 不同 SHA → 409 ---------- */
    section("COS-V1-12 同 sampleId 不同 SHA → 409");
    const otherJpeg = makeJpeg(640, 960, 2048);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID, objectKey: expectedKey, captureSha256: sha256Hex(otherJpeg),
      captureSize: otherJpeg.length, manifest: {}
    }, auth());
    check("V1-12a 冲突 → 409", r.status === 409, "status=" + r.status);

    /* ---------- COS-V1-5/6: PC mirror ---------- */
    section("COS-V1-5/6 PC mirror 最终得到 capture.jpg 且 SHA 一致");
    await collector.r2.whenMirrorIdle(60_000);
    await collector.r2.mirrorTick();
    const sampleDirLocal = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8), SID);
    const mirrored = path.join(sampleDirLocal, "capture.jpg");
    check("V1-5a mirror 后 capture.jpg 出现", fs.existsSync(mirrored));
    check("V1-6a mirror SHA256 与手机 capture 相同",
      fs.existsSync(mirrored) && sha256Hex(fs.readFileSync(mirrored)) === sha);
    check("V1-6b mirror 状态 done",
      collector.r2.mirrorStatusOf(SID) === "done", collector.r2.mirrorStatusOf(SID));

    /* ---------- COS-V1-7: feedback 在 commit 后上传 ---------- */
    section("COS-V1-7 feedback 在 sample committed 后上传");
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SID, action: "set", scope: "page", issueTypes: ["missing_question"]
    }, auth());
    check("V1-7a commit 后 feedback → 200", r.status === 200, "status=" + r.status);
    const fbFile = path.join(sampleDirLocal, "feedback.json");
    check("V1-7b feedback.json 已落盘", fs.existsSync(fbFile));

    /* ---------- COS-V1-8: COS PUT 失败 → 本地保留 ---------- */
    section("COS-V1-8 COS PUT 失败（未 PUT 就 commit）→ 本地不产生半成品");
    const SID2 = t(2);
    const jpeg2 = makeJpeg(700, 900, 1024);
    const sha2 = sha256Hex(jpeg2);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SID2, captureSha256: sha2, captureSize: jpeg2.length, contentType: "image/jpeg"
    }, auth());
    init = json(r);
    check("V1-8a init 仍成功（拿到 URL 但不 PUT）", r.status === 200);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID2, objectKey: init.objectKey, captureSha256: sha2,
      captureSize: jpeg2.length, manifest: {}
    }, auth());
    check("V1-8b 未 PUT 就 commit → 404", r.status === 404, "status=" + r.status);
    const dir2 = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8), SID2);
    check("V1-8c 未产生 run.json / r2state（不会假装成功）",
      !fs.existsSync(path.join(dir2, "run.json")) &&
      !fs.existsSync(collector.r2.stateFile(SID2)));

    /* ---------- COS-V1-10: presign 过期 → 重新 init ---------- */
    section("COS-V1-10 presign 过期后可重新 init 拿新 URL");
    const SID3 = t(3);
    const jpeg3 = makeJpeg(500, 600, 512);
    const sha3 = sha256Hex(jpeg3);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SID3, captureSha256: sha3, captureSize: jpeg3.length, contentType: "image/jpeg"
    }, auth());
    init = json(r);
    /* 直接 PUT 一个不同内容（模拟 URL 已被用过/过期场景的服务端拒绝路径） */
    const bad = await presignedPut(init.presignedPutUrl, Buffer.concat([jpeg3, Buffer.from([0])]),
      init.requiredHeaders);
    check("V1-10a 内容与 metadata 不符时 PUT 仍可能 200（COS 不校验内容）",
      bad.status === 200 || bad.status === 403, "status=" + bad.status);
    /* 重新 init：同 sampleId + 同 sha → 同 objectKey（幂等，可重新上传） */
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SID3, captureSha256: sha3, captureSize: jpeg3.length, contentType: "image/jpeg"
    }, auth());
    const initAgain = json(r);
    check("V1-10b 重新 init 返回相同 objectKey（幂等）",
      initAgain && initAgain.objectKey === init.objectKey);
    /* 用正确内容重新 PUT，然后 commit 成功 */
    const retryPut = await presignedPut(initAgain.presignedPutUrl, jpeg3, initAgain.requiredHeaders);
    check("V1-10c 重新 PUT → 200", retryPut.status === 200, "status=" + retryPut.status);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID3, objectKey: init.objectKey, captureSha256: sha3,
      captureSize: jpeg3.length, manifest: {}
    }, auth());
    check("V1-10d 重新上传后 commit → 201", r.status === 201, "status=" + r.status);
    createdKeys.push(init.objectKey);

    /* ---------- COS-V1-9: Collector 重启恢复 mirror ---------- */
    section("COS-V1-9 Collector 重启后 mirror 恢复");
    const SID4 = t(4);
    const jpeg4 = makeJpeg(480, 640, 256);
    const sha4 = sha256Hex(jpeg4);
    const key4 = objectKeyForSample(SID4);
    /* 先把对象真实放进 COS（镜像恢复需要能下载到它） */
    await cos.putObject(cfg, cfg.bucket, key4, jpeg4, {
      contentType: "image/jpeg", metadata: { sha256: sha4, "sample-id": SID4 }
    });
    const dir4 = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8), SID4);
    fs.mkdirSync(dir4, { recursive: true });
    /* 模拟「commit 已完成但 mirror 被打断」的磁盘状态 */
    fs.writeFileSync(collector.r2.stateFile(SID4), JSON.stringify({
      schemaVersion: 1, sampleId: SID4, objectKey: key4, captureSha256: sha4,
      captureSize: jpeg4.length, contentType: "image/jpeg",
      committedAt: new Date().toISOString(),
      mirror: { status: "pending", attempts: 0, lastError: null, nextRetryAt: null,
        mirroredAt: null, mirroredSha256: null }
    }, null, 2));
    /* 「重启」= 新建 store 实例（无内存状态），只靠磁盘 r2state.json */
    const restarted = createR2Store({
      outRoot: tmp, providerResult: provider, mirrorIntervalMs: 0, log: function () {}
    });
    await restarted.mirrorTick();
    check("V1-9a 重启后 mirror 恢复完成", restarted.mirrorStatusOf(SID4) === "done",
      restarted.mirrorStatusOf(SID4));
    check("V1-9b 重启后 capture.jpg 内容正确",
      fs.existsSync(path.join(dir4, "capture.jpg")) &&
      sha256Hex(fs.readFileSync(path.join(dir4, "capture.jpg"))) === sha4);

    /* ---------- COS-V1-13: 旧 pending queue 升级后能继续传 ----------
       真实场景：旧 sample 在手机 filesDir/sample_queue/，Collector 侧没有任何文件。
       旧 state.json 没有 captureUploaded/captureObjectKey/sampleCommitted 字段，
       但 objectKey 只由 sampleId 派生，所以升级后直接 init→PUT→commit 即可。 */
    section("COS-V1-13 旧 pending queue（无 COS 字段）升级后能继续传");
    const SID5 = t(5);
    const jpeg5 = makeJpeg(520, 700, 384);
    const sha5 = sha256Hex(jpeg5);
    const SID5_CLIENT_STATE = {   /* vc9 时代手机本地的 state：无任何 COS/R2 字段 */
      schemaVersion: 1, sampleId: SID5, createdAt: Date.now(),
      status: "pending", retryCount: 0, nextRetryAt: null,
      sampleUploaded: false, feedbackUploaded: true,
      lastError: null, sealed: false, feedbackRevision: 0
    };
    check("V1-13pre 旧 state 确实没有 COS/R2 字段",
      SID5_CLIENT_STATE.captureUploaded === undefined &&
      SID5_CLIENT_STATE.captureObjectKey === undefined &&
      SID5_CLIENT_STATE.sampleCommitted === undefined);
    /* Collector 侧必须没有任何该 sample 的文件（旧样本在手机上，不在 PC） */
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SID5, captureSha256: sha5, captureSize: jpeg5.length, contentType: "image/jpeg"
    }, auth());
    init = json(r);
    check("V1-13a 旧样本 init 成功（objectKey 只由 sampleId 派生）",
      r.status === 200 && init.objectKey === objectKeyForSample(SID5), "status=" + r.status);
    put = await presignedPut(init.presignedPutUrl, jpeg5, init.requiredHeaders);
    check("V1-13b 旧样本 PUT 成功", put.status === 200, "status=" + put.status);
    /* manifest 用旧客户端的 run.json 形状（无新字段），服务端必须原样接受 */
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID5, objectKey: init.objectKey, captureSha256: sha5,
      captureSize: jpeg5.length, manifest: SID5_CLIENT_STATE
    }, auth());
    check("V1-13c 旧样本 commit 成功", r.status === 201, "status=" + r.status);
    /* 服务端绝不删客户端数据：这里验证 PC 侧 run.json 保留了旧字段 */
    const run5 = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8),
      SID5, "run.json");
    check("V1-13d run.json 保留旧客户端字段",
      fs.existsSync(run5) &&
      JSON.parse(fs.readFileSync(run5, "utf8")).status === "pending");

    /* 交叉兼容：若同一 sampleId 早年已通过 legacy /api/sample 落盘 PC，
       内容一致时 commit 应返回 alreadyCommitted（数据已在 PC，无需重传）。 */
    const SID5B = t(7);
    const jpeg5b = makeJpeg(560, 720, 320);
    const legacyDir = path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8), SID5B);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "capture.jpg"), jpeg5b);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SID5B, objectKey: objectKeyForSample(SID5B),
      captureSha256: sha256Hex(jpeg5b), captureSize: jpeg5b.length, manifest: {}
    }, auth());
    check("V1-13e 已在 PC 的同内容样本 commit → 200 alreadyCommitted（不重复存储）",
      r.status === 200 && json(r) && json(r).alreadyCommitted === true, "status=" + r.status);

    /* ---------- COS-V1-14: legacy /api/sample 仍可用 ---------- */
    section("COS-V1-14 legacy /api/sample 兼容");
    const SID6 = t(6);
    const jpeg6 = makeJpeg(300, 400, 128);
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID6,
      photoDataUrl: "data:image/jpeg;base64," + jpeg6.toString("base64"),
      manifest: { legacy: true }
    }, auth());
    check("V1-14a legacy 认证后 → 201", r.status === 201, "status=" + r.status);
    check("V1-14b legacy 直接落盘",
      fs.existsSync(path.join(tmp, "2026-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8),
        SID6, "capture.jpg")));
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID6,
      photoDataUrl: "data:image/jpeg;base64," + jpeg6.toString("base64"),
      manifest: {}
    }, auth());
    check("V1-14c legacy 幂等重传 → 200", r.status === 200, "status=" + r.status);
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID6, photoDataUrl: "data:image/jpeg;base64," + jpeg6.toString("base64")
    });
    check("V1-14d legacy 未认证 → 401", r.status === 401, "status=" + r.status);

    /* ---------- 清理 COS 测试对象 ---------- */
    section("清理 COS 测试对象");
    const toClean = [SID, SID2, SID3, SID4, SID5, SID5B, SID6].map(function (sid) {
      return objectKeyForSample(sid);
    });
    let cleaned = 0;
    for (const k of toClean) {
      const d = await cos.deleteObject(cfg, cfg.bucket, k);
      if (d.ok) { cleaned++; }
    }
    console.log("  已删除 COS 对象 " + cleaned + "/" + toClean.length);
    /* 再扫一遍确认今天目录下没有本测试残留 */
    const todayPrefix = "samples/" + dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6) +
      "-" + dateStr.slice(6, 8) + "/";
    const left = await cos.listAllObjects(cfg, cfg.bucket, todayPrefix);
    let testLeft = 0;
    if (left.ok) {
      for (const c of left.contents) {
        /* 只清理本测试创建的 sampleId（_0000xx_ 前缀），不动真实数据 */
        if (/_0000\d\d_[0-9a-f]{6}\/capture\.jpg$/.test(c.key)) {
          await cos.deleteObject(cfg, cfg.bucket, c.key);
          testLeft++;
        }
      }
    }
    const after = await cos.listAllObjects(cfg, cfg.bucket, todayPrefix);
    const stillThere = after.ok
      ? after.contents.filter((c) => /_0000\d\d_[0-9a-f]{6}\/capture\.jpg$/.test(c.key)).length
      : -1;
    check("V1-15a 测试用 COS 对象全部清理", stillThere === 0, "remaining=" + stillThere);

    await collector.close();
  } catch (e) {
    console.error("\n[异常] " + (e && e.stack || e));
    fails.push("unexpected exception");
    try { if (collector) { await collector.close(); } } catch (e2) { /* 忽略 */ }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
  }

  console.log("\n==============================================");
  if (pending.length) { console.log("PENDING：" + pending.length + " 项"); }
  if (fails.length) {
    console.log("结果：失败 " + fails.length + " 项");
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
  process.exit(0);
}

main().catch(function (e) {
  console.error("test_cos_v1 异常：" + (e && e.stack || e));
  process.exit(1);
});
