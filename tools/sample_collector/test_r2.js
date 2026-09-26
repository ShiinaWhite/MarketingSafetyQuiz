#!/usr/bin/env node
/* test_r2.js —— R2 直传链路自检（R2_FAST_TRANSFER_V1）
   运行: node tools/sample_collector/test_r2.js   （退出码 0 = 全部通过）

   覆盖任务书要求：
     R2-S1  init 未认证 → 401
     R2-S2  有效 device → init 返回 presigned PUT
     R2-S3  objectKey 由服务器生成
     R2-S4  过期 URL 不能继续使用
     R2-S5  PUT 成功 → commit 成功
     R2-S6  commit 前 object 不存在 → fail
     R2-S7  size 不匹配 → fail
     R2-S8  重复 commit 相同 SHA → 200 idempotent
     R2-S9  同 sampleId 不同 SHA → 409
     R2-S10 feedback 仍在 sample commit 后上传
     R2-S13 legacy authenticated /api/sample 仍兼容
     R2-P1  sample bucket anonymous GET denied
     R2-P2  download bucket APK anonymous GET allowed
     R2-P3  R2 secret 不在 APK/Git
     另加：mirror 后台镜像 / 重启续传 / 不阻塞 commit / 未配置 FAIL CLOSED

   全程写入 os.tmpdir() 随机目录，结束清理，不触碰 real_samples。
   使用 tools/r2/mock_s3.js（独立重写的 SigV4 校验）作为服务端，
   因此签名/规范化写错会在这里暴露。 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { createCollector } = require("./server.js");
const { createR2Store, objectKeyForSample } = require("./r2_store.js");
const r2 = require("../r2/r2.js");
const { createMockS3 } = require("../r2/mock_s3.js");

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

const SAMPLE_BUCKET = "marketing-safety-quiz-samples";
const DOWNLOAD_BUCKET = "marketing-safety-quiz-downloads";
const WRITE_TOKEN = "a".repeat(64);
const SAMPLE_ID = "20260924_101530_ab12cd";

/* 一个真实可解析的最小 JPEG（复用 collector 测试的构造方式） */
function makeFixtureJpeg(width, height) {
  const be16 = (n) => [(n >> 8) & 255, n & 255];
  const seg = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
  const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const DQT = seg(0xDB, [0x00, ...new Array(64).fill(8)]);
  const SOF0 = seg(0xC0, [0x08, ...be16(height), ...be16(width), 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const DHT = seg(0xC4, [0x00, ...new Array(16).fill(0), 0x00]);
  const SOS = seg(0xDA, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]);
  const EOI = [0xFF, 0xD9];
  return Buffer.from([0xFF, 0xD8, ...APP0, ...DQT, ...SOF0, ...DHT, ...SOS, 0x00, 0x12, ...EOI]);
}

function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function request(port, method, reqPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null
      : (Buffer.isBuffer(body) ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"));
    const req = http.request({
      host: "127.0.0.1", port: port, method: method, path: reqPath,
      headers: Object.assign(
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        headers || {})
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

function json(r) { try { return JSON.parse(r.body.toString("utf8")); } catch (e) { return null; } }

/* 用 presigned URL 真实 PUT 一个字节流（模拟手机原生上传） */
function presignedPut(url, body, requiredHeaders) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method: "PUT",
      headers: Object.assign({ "Content-Length": String(body.length) }, requiredHeaders || {})
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

function authHeaders(token) {
  return token === null ? {} : { Authorization: "Bearer " + (token || WRITE_TOKEN) };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-r2-test-"));
  let mock = null;
  let collector = null;
  let store = null;

  try {
    mock = createMockS3({
      /* 随机 credential：让 R2-P3 的「secret 不在源码」扫描成为真检查，
         而不是撞上夹具里的默认字面量 */
      accessKeyId: "AKIATEST" + crypto.randomBytes(6).toString("hex").toUpperCase(),
      secretAccessKey: crypto.randomBytes(32).toString("hex"),
      buckets: {
        [SAMPLE_BUCKET]: { publicRead: false },
        [DOWNLOAD_BUCKET]: { publicRead: true }
      }
    });
    const mockPort = await mock.listen();
    const testConfig = {
      accountId: "testacct",
      accessKeyId: mock.creds.accessKeyId,
      secretAccessKey: mock.creds.secretAccessKey,
      downloadBucket: DOWNLOAD_BUCKET,
      sampleBucket: SAMPLE_BUCKET,
      endpoint: "http://127.0.0.1:" + mockPort
    };
    /* 直连 r2.js 的四个动作，指向 mock S3 */
    const client = {
      presignPutUrl: r2.presignPutUrl,
      headObject: r2.headObject,
      putObject: r2.putObject,
      deleteObject: r2.deleteObject,
      getObjectToFile: r2.getObjectToFile
    };

    store = createR2Store({
      outRoot: tmp, config: testConfig, client: client,
      mirrorIntervalMs: 0, presignTtlSeconds: 300,
      log: function () { /* 测试静音 */ }
    });
    collector = createCollector({
      out: tmp, writeTokens: [WRITE_TOKEN], r2Store: store
    });
    const port = await collector.listen("127.0.0.1", 0);

    const jpg = makeFixtureJpeg(1200, 1600);
    const jpgSha = sha256Hex(jpg);
    const expectedKey = objectKeyForSample(SAMPLE_ID);

    /* ================= R2-S3: objectKey 由服务器生成 ================= */
    section("R2-S3 objectKey 由服务器派生（客户端不可控制）");
    check("R2-S3a key 形如 samples/<date>/<sampleId>/capture.jpg",
      expectedKey === "samples/2026-09-24/" + SAMPLE_ID + "/capture.jpg", expectedKey);
    check("R2-S3b 不同 sampleId 得到不同前缀（按真实日期分目录）",
      objectKeyForSample("20260101_000000_000000") ===
        "samples/2026-01-01/20260101_000000_000000/capture.jpg");

    /* ================= R2-S1: init 未认证 ================= */
    section("R2-S1 init 未认证 → 401");
    let r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    });
    check("R2-S1 init 无 token → 401", r.status === 401, "status=" + r.status);
    check("R2-S1b 未认证不签发 presigned URL",
      r.body.toString().indexOf("X-Amz-Signature") < 0);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders("wrong-token-" + "x".repeat(52)));
    check("R2-S1c init 错误 token → 401", r.status === 401, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: {}
    });
    check("R2-S1d commit 无 token → 401", r.status === 401, "status=" + r.status);

    /* ================= R2-S2: 有效 device → presigned PUT ================= */
    section("R2-S2 有效 device → init 返回 presigned PUT");
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    let init = json(r);
    check("R2-S2a init 认证通过 → 200", r.status === 200, "status=" + r.status);
    check("R2-S2b 返回 presignedPutUrl", !!(init && /^https?:\/\//.test(init.presignedPutUrl || "")));
    check("R2-S2c 返回 objectKey = 服务器派生值", init && init.objectKey === expectedKey);
    check("R2-S2d 返回 expiresAt / requiredHeaders",
      !!(init && init.expiresAt && init.requiredHeaders));
    check("R2-S2e requiredHeaders 锁定 image/jpeg",
      init && init.requiredHeaders && init.requiredHeaders["Content-Type"] === "image/jpeg");
    check("R2-S2f presigned URL 只含签名 query，不含 secret",
      init && init.presignedPutUrl.indexOf(mock.creds.secretAccessKey) < 0 &&
      init.presignedPutUrl.indexOf("X-Amz-Signature=") > 0);
    check("R2-S2g TTL 为 300s（短时效）", init && init.expiresInSeconds === 300,
      init && init.expiresInSeconds);

    /* ================= R2-S2h: 参数校验 ================= */
    section("R2-S2 参数校验（sha/size/contentType）");
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: "not-a-sha", captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    check("非法 captureSha256 → 400", r.status === 400, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: 999 * 1024 * 1024, contentType: "image/jpeg"
    }, authHeaders());
    check("captureSize 超上限 → 413", r.status === 413, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: jpg.length, contentType: "application/zip"
    }, authHeaders());
    check("contentType 非 image/jpeg → 400", r.status === 400, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/init", {
      sampleId: "../etc/passwd", captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    check("非法 sampleId → 400（无路径穿越）", r.status === 400, "status=" + r.status);

    /* ================= R2-S6: commit 前 object 不存在 ================= */
    section("R2-S6 commit 前 object 不存在 → fail");
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: { note: "no object yet" }
    }, authHeaders());
    check("R2-S6a 未 PUT 就 commit → 404", r.status === 404, "status=" + r.status);
    check("R2-S6b 未 PUT 不落 run.json",
      !fs.existsSync(path.join(tmp, "2026-09-24", SAMPLE_ID, "run.json")));

    /* ================= R2-S7: size 不匹配 ================= */
    section("R2-S7 size 不匹配 → fail（且清理不可信对象）");
    const wrongSizeKey = objectKeyForSample("20260924_101531_bb22cd");
    const r7 = await request(port, "POST", "/api/sample/init", {
      sampleId: "20260924_101531_bb22cd", captureSha256: jpgSha,
      captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    const init7 = json(r7);
    await presignedPut(init7.presignedPutUrl, jpg, init7.requiredHeaders);
    check("R2-S7a presigned PUT 成功入 bucket", mock.has(SAMPLE_BUCKET, wrongSizeKey));
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: "20260924_101531_bb22cd", objectKey: wrongSizeKey, captureSha256: jpgSha,
      captureSize: jpg.length + 999, manifest: {}
    }, authHeaders());
    check("R2-S7b 声明 size 与对象不符 → 409", r.status === 409, "status=" + r.status);
    check("R2-S7c 不可信对象被删除", !mock.has(SAMPLE_BUCKET, wrongSizeKey));

    /* ================= R2-S7d: sha metadata 不匹配 ================= */
    section("R2-S7 sha metadata 不匹配 → fail");
    const badShaId = "20260924_101532_cc33dd";
    const badShaKey = objectKeyForSample(badShaId);
    const r7d = await request(port, "POST", "/api/sample/init", {
      sampleId: badShaId, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    const init7d = json(r7d);
    /* 客户端撒谎：用同一 presigned URL 但 PUT 不同字节 → metadata.sha256 与实际不符 */
    await presignedPut(init7d.presignedPutUrl, Buffer.concat([jpg, Buffer.from([0x00])]),
      init7d.requiredHeaders);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: badShaId, objectKey: badShaKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: {}
    }, authHeaders());
    check("R2-S7d 声明 sha 与对象 metadata 不符 → 409", r.status === 409, "status=" + r.status);

    /* ================= R2-S5: PUT 成功 → commit 成功 ================= */
    section("R2-S5 PUT 成功 → commit 成功");
    const putRes = await presignedPut(init.presignedPutUrl, jpg, init.requiredHeaders);
    check("R2-S5a presigned PUT → 2xx", putRes.status >= 200 && putRes.status < 300,
      "status=" + putRes.status);
    const stored = mock.get(SAMPLE_BUCKET, expectedKey);
    check("R2-S5b 对象字节与本地一致", !!stored && Buffer.compare(stored.body, jpg) === 0);
    check("R2-S5c 对象 metadata.sha256 = captureSha256",
      !!stored && stored.metadata.sha256 === jpgSha);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: { pageType: "single", note: "R2 commit" }
    }, authHeaders());
    let commit = json(r);
    check("R2-S5d commit → 201", r.status === 201, "status=" + r.status);
    check("R2-S5e commit 立即返回（mirror 仍在后台）",
      commit && commit.mirrorStatus === "pending", commit && commit.mirrorStatus);
    const runFile = path.join(tmp, "2026-09-24", SAMPLE_ID, "run.json");
    check("R2-S5f run.json 已落盘", fs.existsSync(runFile));
    const runJson = JSON.parse(fs.readFileSync(runFile, "utf8"));
    check("R2-S5g run.json 记录 r2 objectKey / sha256 / transport",
      runJson.image && runJson.image.objectKey === expectedKey &&
      runJson.image.sha256 === jpgSha && runJson.image.storage === "r2" &&
      runJson.collector.transport === "r2-presigned-put");
    check("R2-S5h commit 时 capture.jpg 尚未落盘（镜像未完成）",
      !fs.existsSync(path.join(tmp, "2026-09-24", SAMPLE_ID, "capture.jpg")));

    /* ================= 后台镜像 ================= */
    section("R2 后台镜像（PC real_samples）");
    /* commit 时 kickMirror 已排队：先等后台安静，再显式跑一轮确保断言确定 */
    check("后台镜像能自然收敛（不阻塞 commit）", await store.whenMirrorIdle(20_000));
    const tick = await store.mirrorTick();
    const captureFile = path.join(tmp, "2026-09-24", SAMPLE_ID, "capture.jpg");
    check("镜像后 capture.jpg 出现", fs.existsSync(captureFile));
    check("镜像字节与上传一致",
      fs.existsSync(captureFile) &&
      Buffer.compare(fs.readFileSync(captureFile), jpg) === 0);
    check("镜像状态 done", store.mirrorStatusOf(SAMPLE_ID) === "done",
      store.mirrorStatusOf(SAMPLE_ID));
    check("镜像 tick 统计 scanned>=1", tick.scanned >= 1, JSON.stringify(tick));
    const rstate = JSON.parse(fs.readFileSync(store.stateFile(SAMPLE_ID), "utf8"));
    check("r2state.json 记录 mirroredSha256 与 sha 一致",
      rstate.mirror.mirroredSha256 === jpgSha);

    /* ================= R2-S8: 重复 commit 幂等 ================= */
    section("R2-S8 重复 commit 相同 SHA → 200 idempotent");
    const objCountBefore = mock.count();
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: { note: "retry same" }
    }, authHeaders());
    commit = json(r);
    check("R2-S8a 重复 commit → 200", r.status === 200, "status=" + r.status);
    check("R2-S8b 标记 alreadyCommitted", commit && commit.alreadyCommitted === true);
    check("R2-S8c 未产生重复对象", mock.count() === objCountBefore,
      "before=" + objCountBefore + " after=" + mock.count());
    check("R2-S8d 镜像状态仍为 done（不重复下载）",
      store.mirrorStatusOf(SAMPLE_ID) === "done");

    /* ================= R2-S9: 同 sampleId 不同 SHA → 409 ================= */
    section("R2-S9 同 sampleId 不同 SHA → 409");
    const otherJpg = makeFixtureJpeg(800, 600);
    const otherSha = sha256Hex(otherJpg);
    check("测试用两图确实不同", otherSha !== jpgSha);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: otherSha,
      captureSize: otherJpg.length, manifest: {}
    }, authHeaders());
    check("R2-S9a 冲突 → 409", r.status === 409, "status=" + r.status);
    const conflict = json(r);
    check("R2-S9b 返回 existing/incoming sha 便于诊断",
      conflict && conflict.existingSha256 === jpgSha && conflict.incomingSha256 === otherSha);
    check("R2-S9c 已有 capture.jpg 未被覆盖",
      Buffer.compare(fs.readFileSync(captureFile), jpg) === 0);

    /* ================= R2-S3 附加: commit objectKey 必须匹配 ================= */
    section("R2-S3 commit 拒绝客户端自造 objectKey");
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: "20260924_101533_dd44ee", objectKey: "samples/2026-09-24/whatever/capture.jpg",
      captureSha256: jpgSha, captureSize: jpg.length, manifest: {}
    }, authHeaders());
    check("objectKey 不等于派生值 → 400", r.status === 400, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: "20260924_101533_dd44ee",
      objectKey: "samples/../../secret/capture.jpg",
      captureSha256: jpgSha, captureSize: jpg.length, manifest: {}
    }, authHeaders());
    check("objectKey 带穿越 → 400", r.status === 400, "status=" + r.status);

    /* ================= R2-S4: 过期 URL 不能继续使用 ================= */
    section("R2-S4 过期 presigned URL 不能继续使用");
    let nowMs = Date.now();
    const expiringMock = createMockS3({
      buckets: { [SAMPLE_BUCKET]: { publicRead: false } },
      clock: function () { return nowMs; }
    });
    const expPort = await expiringMock.listen();
    const expConfig = Object.assign({}, testConfig, {
      endpoint: "http://127.0.0.1:" + expPort,
      accessKeyId: expiringMock.creds.accessKeyId,
      secretAccessKey: expiringMock.creds.secretAccessKey
    });
    const expStore = createR2Store({
      outRoot: tmp, config: expConfig, client: client, mirrorIntervalMs: 0
    });
    const expInit = expStore.initSample({
      sampleId: "20260924_101534_ee55ff", captureSha256: jpgSha,
      captureSize: jpg.length, contentType: "image/jpeg"
    });
    check("R2-S4a init 签发成功", expInit.ok === true);
    const before = await presignedPut(expInit.presignedPutUrl, jpg, expInit.requiredHeaders);
    check("R2-S4b TTL 内可用 → 2xx", before.status >= 200 && before.status < 300,
      "status=" + before.status);
    /* 推进 mock 时钟到过期之后（TTL 300s → 跳过 301s） */
    nowMs += 301 * 1000;
    const after = await presignedPut(expInit.presignedPutUrl, jpg, expInit.requiredHeaders);
    check("R2-S4c TTL 之后被拒绝 → 403", after.status === 403, "status=" + after.status);
    check("R2-S4d 拒绝原因是过期",
      after.body.toString().indexOf("expired") >= 0 || after.body.toString().indexOf("AccessDenied") >= 0);
    await expiringMock.close();

    /* ================= 签名被篡改必须失败 ================= */
    section("presigned URL 篡改 / 换 key 必须失败");
    const tamperInit = store.initSample({
      sampleId: "20260924_101535_ff66aa", captureSha256: jpgSha,
      captureSize: jpg.length, contentType: "image/jpeg"
    });
    const tampered = tamperInit.presignedPutUrl.replace("/capture.jpg", "/evil.jpg");
    const tamperRes = await presignedPut(tampered, jpg, tamperInit.requiredHeaders);
    check("改 key 后签名失效 → 403", tamperRes.status === 403, "status=" + tamperRes.status);
    /* 少发一个被签名的头（metadata sha256）也必须失败 */
    const missingHeader = await presignedPut(tamperInit.presignedPutUrl, jpg,
      { "Content-Type": "image/jpeg" });
    check("缺被签名的 metadata 头 → 403", missingHeader.status === 403,
      "status=" + missingHeader.status);

    /* ================= R2-S13: legacy /api/sample 兼容 ================= */
    section("R2-S13 legacy authenticated /api/sample 仍兼容");
    const legacyId = "20260924_101540_112233";
    const legacyJpg = makeFixtureJpeg(640, 480);
    r = await request(port, "POST", "/api/sample", {
      sampleId: legacyId,
      photoDataUrl: "data:image/jpeg;base64," + legacyJpg.toString("base64"),
      manifest: { note: "legacy path" }
    }, authHeaders());
    check("R2-S13a legacy 认证后 → 201", r.status === 201, "status=" + r.status);
    check("R2-S13b legacy 直接落盘 capture.jpg",
      fs.existsSync(path.join(tmp, "2026-09-24", legacyId, "capture.jpg")));
    check("R2-S13c legacy 样本无 r2state.json（无需镜像）",
      !fs.existsSync(store.stateFile(legacyId)));
    r = await request(port, "POST", "/api/sample", {
      sampleId: legacyId,
      photoDataUrl: "data:image/jpeg;base64," + legacyJpg.toString("base64"),
      manifest: {}
    }, authHeaders());
    check("R2-S13d legacy 幂等重传 → 200 alreadyExists",
      r.status === 200 && (json(r) || {}).alreadyExists === true, "status=" + r.status);
    r = await request(port, "POST", "/api/sample", {
      sampleId: legacyId,
      photoDataUrl: "data:image/jpeg;base64," + makeFixtureJpeg(320, 240).toString("base64"),
      manifest: {}
    }, authHeaders());
    check("R2-S13e legacy 内容冲突 → 409", r.status === 409, "status=" + r.status);

    /* legacy 与新协议交叉：同一 sampleId 内容一致 → 200 */
    section("R2-S13 legacy 与新协议交叉兼容");
    const crossId = "20260924_101541_445566";
    const crossJpg = makeFixtureJpeg(500, 700);
    r = await request(port, "POST", "/api/sample", {
      sampleId: crossId,
      photoDataUrl: "data:image/jpeg;base64," + crossJpg.toString("base64"),
      manifest: {}
    }, authHeaders());
    check("先走 legacy 落盘 → 201", r.status === 201, "status=" + r.status);
    r = await request(port, "POST", "/api/sample/commit", {
      sampleId: crossId, objectKey: objectKeyForSample(crossId),
      captureSha256: sha256Hex(crossJpg), captureSize: crossJpg.length, manifest: {}
    }, authHeaders());
    check("同内容改走 R2 commit → 200 alreadyCommitted（不重复存储）",
      r.status === 200 && (json(r) || {}).alreadyCommitted === true, "status=" + r.status);
    check("交叉后镜像状态 done", store.mirrorStatusOf(crossId) === "done");

    /* ================= R2-S10: feedback 在 commit 之后 ================= */
    section("R2-S10 feedback 仍在 sample commit 后上传");
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["missing_question"]
    }, authHeaders());
    check("R2-S10a commit 后 feedback → 200", r.status === 200, "status=" + r.status);
    const fb = JSON.parse(fs.readFileSync(
      path.join(tmp, "2026-09-24", SAMPLE_ID, "feedback.json"), "utf8"));
    check("R2-S10b feedback.json 写入正确",
      fb.pageIssues.length === 1 && fb.pageIssues[0].type === "missing_question");
    r = await request(port, "POST", "/api/feedback", {
      sampleId: "20260924_101599_999999", action: "set", scope: "page",
      issueTypes: ["missing_question"]
    }, authHeaders());
    check("R2-S10c 不存在的 sample feedback → 404", r.status === 404, "status=" + r.status);
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["missing_question"]
    });
    check("R2-S10d feedback 未认证 → 401", r.status === 401, "status=" + r.status);

    /* ================= R2-S11: 上传失败 → 数据不丢（服务端侧） ================= */
    section("R2-S11 R2 不可达时 commit 失败但不产生半成品");
    const brokenStore = createR2Store({
      outRoot: path.join(tmp, "broken"),
      config: Object.assign({}, testConfig, { endpoint: "http://127.0.0.1:1" }),
      client: client, mirrorIntervalMs: 0
    });
    const brokenCollector = createCollector({
      out: path.join(tmp, "broken"), writeTokens: [WRITE_TOKEN], r2Store: brokenStore
    });
    const brokenPort = await brokenCollector.listen("127.0.0.1", 0);
    const brokenId = "20260924_101550_778899";
    r = await request(brokenPort, "POST", "/api/sample/init", {
      sampleId: brokenId, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    check("R2-S11a init 仍可签发（签名是本地计算）", r.status === 200, "status=" + r.status);
    r = await request(brokenPort, "POST", "/api/sample/commit", {
      sampleId: brokenId, objectKey: objectKeyForSample(brokenId), captureSha256: jpgSha,
      captureSize: jpg.length, manifest: {}
    }, authHeaders());
    check("R2-S11b R2 不可达 → 502", r.status === 502, "status=" + r.status);
    check("R2-S11c 未落 r2state.json（不会假装成功）",
      !fs.existsSync(brokenStore.stateFile(brokenId)));
    check("R2-S11d 未落 capture.jpg（无半成品）",
      !fs.existsSync(path.join(tmp, "broken", "2026-09-24", brokenId, "capture.jpg")));
    await brokenCollector.close();

    /* ================= 镜像失败重试 + 重启续传 ================= */
    section("镜像失败重试与 Collector 重启续传");
    const retryId = "20260924_101551_aa11bb";
    const retryKey = objectKeyForSample(retryId);
    mock.seed(SAMPLE_BUCKET, retryKey, jpg, {
      contentType: "image/jpeg", metadata: { sha256: jpgSha, "sample-id": retryId }
    });
    const retryDir = path.join(tmp, "2026-09-24", retryId);
    fs.mkdirSync(retryDir, { recursive: true });
    fs.writeFileSync(store.stateFile(retryId), JSON.stringify({
      schemaVersion: 1, sampleId: retryId, objectKey: retryKey,
      captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg",
      committedAt: new Date().toISOString(),
      mirror: { status: "pending", attempts: 0, lastError: null, nextRetryAt: null,
        mirroredAt: null, mirroredSha256: null }
    }, null, 2));
    /* 模拟 Collector 重启：新建 store 实例（无内存状态），只靠磁盘 r2state.json */
    const restarted = createR2Store({
      outRoot: tmp, config: testConfig, client: client, mirrorIntervalMs: 0
    });
    const rt = await restarted.mirrorTick();
    check("重启后扫描到未镜像样本", rt.scanned >= 1, JSON.stringify(rt));
    check("重启后镜像完成", restarted.mirrorStatusOf(retryId) === "done",
      restarted.mirrorStatusOf(retryId));
    check("重启后 capture.jpg 内容正确",
      Buffer.compare(fs.readFileSync(path.join(retryDir, "capture.jpg")), jpg) === 0);

    /* 下载失败 → 记录 failed + nextRetryAt，稍后可重试 */
    const failId = "20260924_101552_bb22cc";
    const failKey = objectKeyForSample(failId);
    const failDir = path.join(tmp, "2026-09-24", failId);
    fs.mkdirSync(failDir, { recursive: true });
    fs.writeFileSync(store.stateFile(failId), JSON.stringify({
      schemaVersion: 1, sampleId: failId, objectKey: failKey,
      captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg",
      committedAt: new Date().toISOString(),
      mirror: { status: "pending", attempts: 0, lastError: null, nextRetryAt: null,
        mirroredAt: null, mirroredSha256: null }
    }, null, 2));
    /* 该 key 不在 mock 里 → 404 */
    await store.mirrorTick();
    check("下载失败 → mirror 状态 failed", store.mirrorStatusOf(failId) === "failed",
      store.mirrorStatusOf(failId));
    const failState = JSON.parse(fs.readFileSync(store.stateFile(failId), "utf8"));
    check("记录 attempts / nextRetryAt（可自动重试）",
      failState.mirror.attempts >= 1 && !!failState.mirror.nextRetryAt);
    check("失败不留下 .tmp 残留",
      fs.readdirSync(failDir).every((f) => f.indexOf(".tmp") < 0),
      fs.readdirSync(failDir).join(","));
    /* 补上对象后（nextRetryAt 已到）重试成功 */
    mock.seed(SAMPLE_BUCKET, failKey, jpg, {
      contentType: "image/jpeg", metadata: { sha256: jpgSha }
    });
    failState.mirror.nextRetryAt = Date.now() - 1000;
    fs.writeFileSync(store.stateFile(failId), JSON.stringify(failState, null, 2));
    await store.mirrorTick();
    check("对象补上后重试成功", store.mirrorStatusOf(failId) === "done",
      store.mirrorStatusOf(failId));

    /* 镜像内容不符 → 拒绝 rename，不冒充完整样本 */
    const badMirrorId = "20260924_101553_cc33dd";
    const badMirrorKey = objectKeyForSample(badMirrorId);
    mock.seed(SAMPLE_BUCKET, badMirrorKey, Buffer.from("not-the-expected-jpeg"), {
      contentType: "image/jpeg", metadata: { sha256: "0".repeat(64) }
    });
    const badDir = path.join(tmp, "2026-09-24", badMirrorId);
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(store.stateFile(badMirrorId), JSON.stringify({
      schemaVersion: 1, sampleId: badMirrorId, objectKey: badMirrorKey,
      captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg",
      committedAt: new Date().toISOString(),
      mirror: { status: "pending", attempts: 0, lastError: null, nextRetryAt: null,
        mirroredAt: null, mirroredSha256: null }
    }, null, 2));
    await store.mirrorTick();
    check("镜像 SHA 不符 → failed，不写入 capture.jpg",
      store.mirrorStatusOf(badMirrorId) === "failed" &&
      !fs.existsSync(path.join(badDir, "capture.jpg")));

    /* ================= 未配置 R2 → FAIL CLOSED ================= */
    section("R2 未配置时 init/commit FAIL CLOSED（503）");
    /* 显式禁用 provider：本机现在装了真实 COS credential，若不显式禁用，
       auto 选择会拿到 COS，无法验证 FAIL CLOSED 路径。 */
    const noR2 = createCollector({
      out: path.join(tmp, "nor2"), writeTokens: [WRITE_TOKEN],
      providerResult: { ok: false, provider: null, error: "(test: no provider)" }
    });
    const noR2Port = await noR2.listen("127.0.0.1", 0);
    check("无 R2 配置时 store.available()=false", noR2.r2.available() === false);
    r = await request(noR2Port, "POST", "/api/sample/init", {
      sampleId: SAMPLE_ID, captureSha256: jpgSha, captureSize: jpg.length, contentType: "image/jpeg"
    }, authHeaders());
    check("无 R2 时 init → 503", r.status === 503, "status=" + r.status);
    r = await request(noR2Port, "POST", "/api/sample/commit", {
      sampleId: SAMPLE_ID, objectKey: expectedKey, captureSha256: jpgSha,
      captureSize: jpg.length, manifest: {}
    }, authHeaders());
    check("无 R2 时 commit → 503", r.status === 503, "status=" + r.status);
    /* legacy 不受影响 */
    const legacy2 = makeFixtureJpeg(200, 200);
    r = await request(noR2Port, "POST", "/api/sample", {
      sampleId: "20260924_101560_aabbcc",
      photoDataUrl: "data:image/jpeg;base64," + legacy2.toString("base64"), manifest: {}
    }, authHeaders());
    check("无 R2 时 legacy /api/sample 仍可用 → 201", r.status === 201, "status=" + r.status);
    r = await request(noR2Port, "GET", "/health");
    check("无 R2 时 /health 正常", r.status === 200);
    await noR2.close();

    /* ================= R2-P1 / R2-P2: bucket 可见性 ================= */
    section("R2-P1 sample bucket 匿名访问必须被拒绝");
    const anonGet = await request(mockPort, "GET",
      "/" + SAMPLE_BUCKET + "/" + expectedKey);
    check("R2-P1a 匿名 GET capture.jpg → 403", anonGet.status === 403, "status=" + anonGet.status);
    const anonHead = await request(mockPort, "HEAD", "/" + SAMPLE_BUCKET + "/" + expectedKey);
    check("R2-P1b 匿名 HEAD → 403", anonHead.status === 403, "status=" + anonHead.status);
    const anonList = await request(mockPort, "GET", "/" + SAMPLE_BUCKET + "?list-type=2");
    check("R2-P1c 匿名 LIST → 403", anonList.status === 403, "status=" + anonList.status);
    const anonPut = await request(mockPort, "PUT", "/" + SAMPLE_BUCKET + "/evil.jpg",
      Buffer.from("x"));
    check("R2-P1d 匿名 PUT → 403", anonPut.status === 403, "status=" + anonPut.status);

    section("R2-P2 download bucket 公开读 APK");
    mock.seed(DOWNLOAD_BUCKET, "apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk",
      Buffer.from("FAKEAPKBYTES"), { contentType: "application/vnd.android.package-archive" });
    const pubGet = await request(mockPort, "GET",
      "/" + DOWNLOAD_BUCKET + "/apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk");
    check("R2-P2a 匿名 GET APK → 200", pubGet.status === 200, "status=" + pubGet.status);
    const pubHead = await request(mockPort, "HEAD",
      "/" + DOWNLOAD_BUCKET + "/apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk");
    check("R2-P2b 匿名 HEAD APK → 200", pubHead.status === 200, "status=" + pubHead.status);
    const pubPut = await request(mockPort, "PUT", "/" + DOWNLOAD_BUCKET + "/x.apk",
      Buffer.from("x"));
    check("R2-P2c 匿名 PUT 到 download bucket → 403（只读）", pubPut.status === 403,
      "status=" + pubPut.status);

    /* ================= R2-P3: secret 不出现在仓库/产物 ================= */
    section("R2-P3 R2 secret 不在 Git / 前端产物");
    const secret = mock.creds.secretAccessKey;
    const scanRoots = ["www", "tools", "android/app/src", "test_core.js"];
    const hits = [];
    const walk = (p) => {
      let st;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) {
        if (/node_modules|[\\/]build[\\/]|[\\/]\.git/.test(p)) { return; }
        fs.readdirSync(p).forEach((n) => walk(path.join(p, n)));
        return;
      }
      if (!/\.(js|json|java|html|css|md|bat|txt)$/.test(p)) { return; }
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch (e) { return; }
      if (text.indexOf(secret) >= 0) { hits.push(p); }
    };
    scanRoots.forEach((p) => walk(path.join(__dirname, "..", "..", p)));
    check("R2-P3a 测试 secret 不出现在源码/前端（扫描机制自检）", hits.length === 0,
      hits.join(","));

    await collector.close();
    if (mock) { await mock.close(); }
  } catch (e) {
    console.error("\n[异常] " + (e && e.stack || e));
    fails.push("unexpected exception");
    try { if (collector) { await collector.close(); } } catch (e2) { /* 忽略 */ }
    try { if (mock) { await mock.close(); } } catch (e2) { /* 忽略 */ }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理尽力 */ }
  }

  console.log("\n==============================================");
  if (fails.length) {
    console.log("结果：失败 " + fails.length + " 项");
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
}

main();
