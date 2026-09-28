/* test_sample_db.js —— SAMPLE_DATABASE_V1 自检（SDB-*）
   运行: node tools/sample_db/test_sample_db.js   （退出码 0 = 全部通过）
   全程写入 os.tmpdir() 随机目录，结束清理，不触碰 real_samples / data/。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const samplesDb = require("./store.js");
const serverModule = require("../sample_collector/server.js");
const backupTool = require("../db/backup.js");

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/* 真实形状的 run.json 夹具（字段对照 real_samples 实测样本） */
function makeRunJson(sampleId, overrides) {
  const o = overrides || {};
  return Object.assign({
    schemaVersion: 1,
    sampleId: sampleId,
    capturedAt: "2026-09-24T03:22:14.862Z",
    pageType: "single",
    pageTypeMode: "auto",
    resolvedPageType: "single",
    pageTypeResolutionMethod: "match-quality",
    autoTypeConfidence: "strong",
    image: { filename: "capture.jpg" },
    ocr: { text: "题干内容（夹具）", width: 3000, height: 4000, lines: [] },
    blocks: [
      { screenNumber: "10", rawScreenNumber: "10", numberSource: "ocr", type: "single",
        label: "10", stemText: "s", optionsText: "o", rawText: "r",
        geometry: { top: 0, bottom: 100 }, finalBankId: 104, finalAnswer: "A",
        confidence: "high", matchedByOptions: false,
        candidates: [{ rank: 1, bankId: 104, score: 0.9, typeName: "single",
          answer: "A", stem: "s" }] },
      { screenNumber: "11", rawScreenNumber: "11", numberSource: "ocr", type: "single",
        label: "11", stemText: "s2", optionsText: "o2", rawText: "r2",
        geometry: { top: 100, bottom: 200 }, finalBankId: 238, finalAnswer: "D",
        confidence: "medium", matchedByOptions: true, candidates: [] },
      { screenNumber: "?", rawScreenNumber: null, numberSource: "fallback", type: "judge",
        label: null, stemText: "s3", optionsText: "", rawText: "r3",
        geometry: null, finalBankId: null, finalAnswer: null,
        confidence: "none", matchedByOptions: false, candidates: [] }
    ],
    timing: { ocrMs: 300, splitMs: 3, matchMs: 35, totalMs: 509 }
  }, o.patch || {});
}

function makeFixtureJpeg(width, height) {
  const be16 = (n) => [(n >> 8) & 255, n & 255];
  const seg = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
  const SOI = [0xFF, 0xD8];
  const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const DQT = seg(0xDB, [0x00, ...new Array(64).fill(8)]);
  const SOF0 = seg(0xC0, [0x08, ...be16(height), ...be16(width), 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const DHT = seg(0xC4, [0x00, ...new Array(16).fill(0), 0x00]);
  const SOS = seg(0xDA, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]);
  const EOI = [0xFF, 0xD9];
  return Buffer.from([SOI, APP0, DQT, SOF0, DHT, SOS, 0x00, 0x12, EOI].flat());
}

function hashTree(root) {
  const out = {};
  const walk = function (dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); }
      else {
        const st = fs.statSync(full);
        out[path.relative(root, full)] = st.size + ":" + st.mtimeMs;
      }
    }
  };
  walk(root);
  return out;
}

function request(port, method, reqPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: port, method: method, path: reqPath,
      headers: Object.assign(
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}, {})
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-sampledb-test-"));
  const dbPath = path.join(tmp, "samples.db");
  let opened = null;
  try {
    /* ---------- SDB-MIGRATION ---------- */
    section("SDB-MIGRATION 建库与重开");
    opened = samplesDb.openSamplesStore({ path: dbPath });
    check("全新建库成功", opened.ok);
    const mig = opened.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    check("schema_migrations v1", mig && mig.v === 1);
    opened.store.close();
    opened = samplesDb.openSamplesStore({ path: dbPath });
    check("重开幂等（不抛错）", opened.ok);
    const tables = opened.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(function (x) { return x.name; })
      .filter(function (t) { return t !== "sqlite_sequence"; });
    check("V1 五张表", tables.length === 5 &&
      ["sample_blocks", "sample_feedback", "sample_files", "samples", "schema_migrations"]
        .every(function (t) { return tables.indexOf(t) >= 0; }), tables.join(","));

    /* ---------- SDB-INGEST ---------- */
    section("SDB-INGEST run.json 字段映射");
    const SID = "20260924_112214_cb7799";
    let verdict = opened.store.recordSample({
      sampleId: SID, manifest: makeRunJson(SID),
      provider: "cos", objectKey: "samples/2026-09-24/" + SID + "/capture.jpg",
      sha256: "a".repeat(64), size: 2105978, width: 3000, height: 4000,
      localPath: path.join(tmp, SID, "capture.jpg"), nowMs: 1727157734862
    });
    check("首次写入 = inserted", verdict === "inserted", verdict);
    const srow = opened.store.getSample(SID);
    check("samples 字段映射", srow.page_type_mode === "auto" &&
      srow.detected_type === "single" && srow.question_count === 3 &&
      srow.confidence_high === 1 && srow.confidence_medium === 1 &&
      srow.confidence_low === 0 && srow.confidence_none === 1 &&
      srow.ocr_ms === 300 && srow.total_ms === 509, JSON.stringify(srow));
    check("received_at 来自 nowMs", srow.received_at === 1727157734862);
    const frow = opened.store.getFiles(SID).filter(function (f) { return f.kind === "capture"; })[0];
    check("sample_files 映射（provider/object_key/sha/size/宽高）", frow &&
      frow.provider === "cos" && frow.size === 2105978 &&
      frow.width === 3000 && frow.height === 4000 &&
      frow.sha256 === "a".repeat(64) &&
      frow.object_key === "samples/2026-09-24/" + SID + "/capture.jpg", JSON.stringify(frow));
    const blocks = opened.store.getBlocks(SID);
    check("sample_blocks 三行且按 block_index", blocks.length === 3 &&
      blocks[0].block_index === 0 && blocks[2].block_index === 2);
    check("block 字段映射（screen/final_bank_id/confidence/matched_by_options）",
      blocks[0].screen_number === "10" && blocks[0].final_bank_id === 104 &&
      blocks[0].confidence === "high" && blocks[0].matched_by_options === 0 &&
      blocks[1].matched_by_options === 1);
    check("未匹配块 bankId 为 NULL", blocks[2].final_bank_id === null);
    const cands = JSON.parse(blocks[0].candidates_json);
    check("candidates_json 可解析（Top3）", cands.length === 1 && cands[0].bankId === 104);
    check("block_json 为原 block 全量", JSON.parse(blocks[0].block_json).screenNumber === "10");

    /* ---------- SDB-IDEMPOTENCY ---------- */
    section("SDB-IDEMPOTENCY 同 commit 重试幂等");
    verdict = opened.store.recordSample({
      sampleId: SID, manifest: makeRunJson(SID),
      provider: "cos", objectKey: "samples/2026-09-24/" + SID + "/capture.jpg",
      sha256: "a".repeat(64), size: 2105978, width: 3000, height: 4000,
      localPath: path.join(tmp, SID, "capture.jpg"), nowMs: 1727157734862
    });
    check("同内容重写 = duplicate", verdict === "duplicate", verdict);
    check("blocks 不重复", opened.store.getBlocks(SID).length === 3);
    check("samples 不重复", opened.store.counts().samples === 1);

    section("SDB-IDEMPOTENCY raw 已有 + DB 缺失 → 重试补写");
    /* 模拟 DB 丢失：清空所有行（raw 假定仍在） */
    opened.db.exec("DELETE FROM sample_blocks; DELETE FROM sample_files;" +
      " DELETE FROM sample_feedback; DELETE FROM samples;");
    verdict = opened.store.recordSample({
      sampleId: SID, manifest: makeRunJson(SID),
      provider: "cos", objectKey: "samples/2026-09-24/" + SID + "/capture.jpg",
      sha256: "a".repeat(64), size: 2105978, width: 3000, height: 4000,
      localPath: path.join(tmp, SID, "capture.jpg"), nowMs: 1727157734862
    });
    check("补写成功 = inserted", verdict === "inserted", verdict);
    check("补写后行数完整", opened.store.counts().samples === 1 &&
      opened.store.counts().blocks === 3);

    section("SDB-IDEMPOTENCY manifest 变化 → updated（last-write-wins）");
    verdict = opened.store.recordSample({
      sampleId: SID, manifest: makeRunJson(SID, {
        patch: { timing: { ocrMs: 300, splitMs: 3, matchMs: 35, totalMs: 999 } }
      }),
      provider: "cos", objectKey: "samples/2026-09-24/" + SID + "/capture.jpg",
      sha256: "a".repeat(64), size: 2105978, width: 3000, height: 4000,
      localPath: path.join(tmp, SID, "capture.jpg"), nowMs: 1727157999999
    });
    check("内容变化 = updated", verdict === "updated", verdict);
    check("samples 仍只有一行", opened.store.counts().samples === 1);

    /* ---------- SDB-FEEDBACK ---------- */
    section("SDB-FEEDBACK 与 raw feedback 语义一致");
    opened.store.recordFeedback(SID, {
      schemaVersion: 2, sampleId: SID, updatedAt: "2026-09-24T04:00:00.000Z",
      pageIssues: [{ type: "missing_question" }, { type: "other" }],
      blockIssues: [{ blockIndex: 1, issue: "wrong_answer", screenNumber: "11",
        rawScreenNumber: "11", numberSource: "ocr", type: "single",
        finalAnswer: "D", confidence: "medium", finalBankId: 238, matchedByOptions: true }],
      legacy: null
    });
    let fb = opened.store.getFeedback(SID);
    check("page 两行 + block 一行", fb.filter(function (r) { return r.scope === "page"; }).length === 2 &&
      fb.filter(function (r) { return r.scope === "block"; }).length === 1, JSON.stringify(fb));
    check("block key 形如 '<idx>:<issue>'",
      fb.some(function (r) { return r.scope === "block" && r.key === "1:wrong_answer"; }));
    /* remove：页级清空 + 保留块级 */
    opened.store.recordFeedback(SID, {
      schemaVersion: 2, sampleId: SID, updatedAt: "2026-09-24T05:00:00.000Z",
      pageIssues: [], blockIssues: [{ blockIndex: 1, issue: "wrong_answer" }], legacy: null
    });
    fb = opened.store.getFeedback(SID);
    check("全量替换清掉 stale page 行", fb.filter(function (r) { return r.scope === "page"; }).length === 0 &&
      fb.filter(function (r) { return r.scope === "block"; }).length === 1);
    /* legacy 形状 */
    opened.store.recordFeedback(SID, {
      schemaVersion: 2, sampleId: SID, updatedAt: null,
      pageIssues: [], blockIssues: [],
      legacy: { userFlag: "wrong_answer", screenNumbers: ["10", "11"] }
    });
    fb = opened.store.getFeedback(SID);
    const legacyRow = fb.filter(function (r) { return r.scope === "legacy"; })[0];
    check("legacy 行保存 userFlag/screenNumbers", legacyRow &&
      JSON.parse(legacyRow.value_json).screenNumbers.length === 2);

    /* ---------- 服务器双写集成（legacy /api/sample + /api/feedback） ---------- */
    section("SDB-INGEST 服务器双写（legacy /api/sample → samples.db）");
    const collector = serverModule.createCollector({
      out: path.join(tmp, "out"),
      allowAnonymousWrites: true,
      samplesDbPath: dbPath,
      telemetryRateLimitPerMin: 1000000
    });
    const port = await collector.listen("127.0.0.1", 0);
    const SID2 = "20260927_120000_aaa002";
    const jpg = makeFixtureJpeg(30, 40);
    let r = await request(port, "POST", "/api/sample", {
      sampleId: SID2,
      photoDataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
      manifest: makeRunJson(SID2, { patch: { capturedAt: "2026-09-27T04:00:00.000Z" } })
    });
    check("legacy commit 201", r.status === 201, r.status + " " + r.body);
    const srow2 = opened.store.getSample(SID2);
    check("commit 后 samples 行就位", srow2 && srow2.question_count === 3, JSON.stringify(srow2));
    const frow2 = opened.store.getFiles(SID2)[0];
    check("legacy provider=local 且 local_path 指向落盘文件", frow2 &&
      frow2.provider === "local" && frow2.local_path !== null &&
      frow2.width === 30 && frow2.height === 40,
      JSON.stringify(frow2));
    /* 同内容重传 → 200 alreadyExists + duplicate（无重复行） */
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID2,
      photoDataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
      manifest: makeRunJson(SID2, { patch: { capturedAt: "2026-09-27T04:00:00.000Z" } })
    });
    check("重传 200 alreadyExists", r.status === 200);
    check("无重复行", opened.store.counts().samples === 2 && opened.store.counts().blocks === 6);

    section("SDB-FEEDBACK 服务器 feedback 三分支同步");
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SID2, action: "set", scope: "page", issueTypes: ["wrong_page_type"]
    });
    check("v2 set 200", r.status === 200, r.status);
    check("页反馈入库", opened.store.getFeedback(SID2)
      .some(function (x) { return x.scope === "page" && x.key === "wrong_page_type"; }));
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SID2, action: "set", scope: "block", issue: "wrong_answer", blockIndex: 0,
      block: { screenNumber: "10", finalAnswer: "A", confidence: "high", finalBankId: 104 }
    });
    check("v2 block set 200", r.status === 200);
    check("块反馈入库", opened.store.getFeedback(SID2)
      .some(function (x) { return x.scope === "block" && x.key === "0:wrong_answer"; }));
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SID2, action: "remove", scope: "page"
    });
    check("v2 remove 200", r.status === 200);
    check("remove 后 DB 同步为空（与 raw 一致）",
      opened.store.getFeedback(SID2).filter(function (x) { return x.scope === "page"; }).length === 0);
    r = await request(port, "POST", "/api/feedback", {
      schemaVersion: 2, sampleId: SID2,
      pageIssues: [{ type: "missing_question" }], blockIssues: []
    });
    check("v2 全量替换 200", r.status === 200);
    check("全量替换与 raw 一致",
      opened.store.getFeedback(SID2).filter(function (x) { return x.scope === "page"; }).length === 1 &&
      opened.store.getFeedback(SID2).filter(function (x) { return x.scope === "block"; }).length === 0);
    /* v1 兼容请求 */
    r = await request(port, "POST", "/api/feedback", {
      sampleId: SID2, userFlag: "missing_question", screenNumbers: ["3"]
    });
    check("v1 兼容请求 200", r.status === 200);
    check("legacy 行入库", opened.store.getFeedback(SID2)
      .some(function (x) { return x.scope === "legacy"; }));

    section("SDB-IDEMPOTENCY DB 临时异常不影响既有链路");
    /* 注入 recordSample 抛异常：commit/feedback 必须照常成功 */
    const origRecord = opened.store.recordSample;
    opened.store.recordSample = function () { throw new Error("injected db failure"); };
    const SID3 = "20260927_120001_aaa003";
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID3,
      photoDataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
      manifest: makeRunJson(SID3)
    });
    check("recordSample 抛异常 → commit 仍 201", r.status === 201, r.status);
    opened.store.recordSample = origRecord;
    /* 恢复后重传同一 sample → DB 补写成功（raw 已有 + DB 缺失场景） */
    r = await request(port, "POST", "/api/sample", {
      sampleId: SID3,
      photoDataUrl: "data:image/jpeg;base64," + jpg.toString("base64"),
      manifest: makeRunJson(SID3)
    });
    check("恢复后重传 → 200 alreadyExists", r.status === 200);
    check("DB 补写完成", !!opened.store.getSample(SID3));

    /* r2 commit 出口（onCommit 回调）双写 */
    section("SDB-INGEST R2 commit 成功出口双写（onCommit）");
    const r2Store = require("../sample_collector/r2_store.js");
    const captured = [];
    const store2 = r2Store.createR2Store({
      outRoot: path.join(tmp, "r2out"),
      config: { sampleBucket: "b", region: "r2", provider: "r2", accessKeyId: "k",
        secretAccessKey: "s", endpoint: "https://e.example" },
      client: {
        presignPutUrl: function () { return { ok: true, url: "https://e/put",
          expiresAt: "x", expiresInSeconds: 300, requiredHeaders: {} }; },
        headObject: function () { return { ok: true, size: jpg.length,
          metadata: { sha256: "b".repeat(64) }, contentType: "image/jpeg", etag: "e" }; },
        deleteObject: function () { return { ok: true }; },
        getObjectToFile: function () { return { ok: false }; },
        putObject: function () { return { ok: true }; }
      },
      mirrorIntervalMs: 0,
      onCommit: function (info) { captured.push(info); }
    });
    const SID4 = "20260927_120002_aaa004";
    const ir = store2.initSample({ sampleId: SID4, captureSha256: "b".repeat(64),
      captureSize: jpg.length, contentType: "image/jpeg" });
    check("init ok（mock client）", ir.ok === true);
    const cr = await store2.commitSample({ sampleId: SID4, objectKey: ir.objectKey,
      captureSha256: "b".repeat(64), captureSize: jpg.length,
      manifest: makeRunJson(SID4) });
    check("commit 201", cr.ok && cr.status === 201, JSON.stringify(cr));
    check("onCommit 携带 provider/objectKey/manifest", captured.length === 1 &&
      captured[0].provider === "r2" && captured[0].sampleId === SID4 &&
      captured[0].captureSize === jpg.length &&
      captured[0].objectKey === ir.objectKey, JSON.stringify(captured[0] || {}));
    /* onCommit 内部异常绝不影响 commit 响应 */
    const captured2 = [];
    const store3 = r2Store.createR2Store({
      outRoot: path.join(tmp, "r2out2"),
      config: { sampleBucket: "b", region: "r2", provider: "r2", accessKeyId: "k",
        secretAccessKey: "s", endpoint: "https://e.example" },
      client: {
        presignPutUrl: function () { return { ok: true, url: "https://e/put",
          expiresAt: "x", expiresInSeconds: 300, requiredHeaders: {} }; },
        headObject: function () { return { ok: true, size: jpg.length,
          metadata: { sha256: "c".repeat(64) }, contentType: "image/jpeg", etag: "e" }; },
        deleteObject: function () { return { ok: true }; },
        getObjectToFile: function () { return { ok: false }; },
        putObject: function () { return { ok: true }; }
      },
      mirrorIntervalMs: 0,
      onCommit: function () { throw new Error("injected onCommit failure"); }
    });
    const SID5 = "20260927_120003_aaa005";
    const ir2 = store3.initSample({ sampleId: SID5, captureSha256: "c".repeat(64),
      captureSize: jpg.length, contentType: "image/jpeg" });
    const cr2 = await store3.commitSample({ sampleId: SID5, objectKey: ir2.objectKey,
      captureSha256: "c".repeat(64), captureSize: jpg.length,
      manifest: makeRunJson(SID5) });
    check("onCommit 抛异常 → commit 仍 201", cr2.ok && cr2.status === 201);

    await collector.close();

    /* ---------- SDB-BACKFILL ---------- */
    /* backfill.js 是 CLI（require 即执行 main），必须用子进程测：见文件末尾
       runBackfillTests()（tmp 夹具端到端）与 runRealSamplesReadOnlyCheck()（真实 raw）。 */
    opened.store.close();

    /* ---------- SDB-BACKUP ---------- */
    section("SDB-BACKUP backup API 一致性快照");
    const backupDir = path.join(tmp, "backups");
    const br = await backupTool.backupOne(dbPath, backupDir, "samples", 3, Date.now());
    check("备份产出文件", br.ok === true && fs.existsSync(br.dest), JSON.stringify(br));
    const bdb = samplesDb.openSamplesStore({ path: br.dest });
    check("备份可打开且行数一致", bdb.ok &&
      bdb.store.counts().samples === opened2Count(dbPath), JSON.stringify(bdb.store ? bdb.store.counts() : null));
    bdb.store.close();

    /* --keep 清理 */
    for (let i = 0; i < 5; i++) {
      await backupTool.backupOne(dbPath, backupDir, "samples", 3, Date.now() + i * 1000 + 10);
    }
    const kept = fs.readdirSync(backupDir).filter(function (f) { return f.startsWith("samples-"); });
    check("--keep 3 只保留 3 份", kept.length === 3, kept.join(","));
  } finally {
    if (opened) { try { opened.store.close(); } catch (e) { /* 已关闭 */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* SDB-BACKFILL 用子进程（backfill.js 是 CLI，main() 直接执行） */
  console.log("\n== SDB-BACKFILL 子进程端到端 ==");
  await runBackfillTests();
  console.log("\n== SDB-BACKFILL 真实 real_samples 抽样（READ ONLY 验证） ==");
  await runRealSamplesReadOnlyCheck();

  console.log("\n==============================================");
  if (fails.length) {
    console.log(`结果：${fails.length} 项失败 ✗`);
    fails.forEach((f) => console.log("  FAIL: " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
  process.exit(0);
}

/* 打开只读副本数（备份一致性断言辅助） */
function opened2Count(dbPath) {
  const o = samplesDb.openSamplesStore({ path: dbPath });
  try { return o.store.counts().samples; } finally { o.store.close(); }
}

async function runBackfillTests() {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-backfill-test-"));
  try {
    const root = path.join(tmp, "real_samples");
    const dbPath = path.join(tmp, "samples.db");
    /* 夹具：2 个完整样本（其一含 feedback）、1 个缺 capture、1 个坏 JSON、1 个 sampleId 不符 */
    const mk = function (sampleId, opts) {
      const o = opts || {};
      const dir = path.join(root, sampleId.slice(0, 4) + "-" + sampleId.slice(4, 6) + "-" +
        sampleId.slice(6, 8), sampleId);
      fs.mkdirSync(dir, { recursive: true });
      if (!o.noRun) {
        const run = makeRunJson(sampleId);
        if (o.blocks3) { run.blocks = run.blocks.concat(run.blocks, run.blocks); }
        fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
      }
      if (o.badJson) { fs.writeFileSync(path.join(dir, "run.json"), "{not json"); }
      if (o.idMismatch) {
        fs.writeFileSync(path.join(dir, "run.json"),
          JSON.stringify(makeRunJson("20260925_000000_zzzzzz")));
      }
      if (!o.noCapture) { fs.writeFileSync(path.join(dir, "capture.jpg"), makeFixtureJpeg(10, 10)); }
      if (o.feedback) {
        fs.writeFileSync(path.join(dir, "feedback.json"), JSON.stringify({
          schemaVersion: 2, sampleId: sampleId, updatedAt: "2026-09-27T00:00:00.000Z",
          pageIssues: [{ type: "missing_question" }], blockIssues: [], legacy: null
        }));
      }
      return dir;
    };
    mk("20260926_100000_bbb001", { feedback: true });
    mk("20260926_100001_bbb002", {});
    mk("20260926_100002_bbb003", { noCapture: true });
    mk("20260926_100003_bbb004", { badJson: true });
    mk("20260926_100004_bbb005", { idMismatch: true });

    const beforeTree = hashTree(root);
    const run = function (extraArgs) {
      const r = spawnSync(process.execPath,
        [path.join(__dirname, "backfill.js"), "--root", root, "--db", dbPath]
          .concat(extraArgs || []), { encoding: "utf8" });
      return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
    };

    let r = run(["--dry-run"]);
    check("dry-run 退出码 0", r.status === 0, r.out.slice(-200));
    check("dry-run 计数：scanned=5 valid=3 inserted=3 malformed=2 missing_capture=1",
      /scanned=5\s+valid=3\s+inserted=3\s+updated=0\s+duplicate=0/.test(r.out) &&
      /malformed=2\s+missing_capture=1\s+missing_run=0/.test(r.out) &&
      /feedback_count=1/.test(r.out), r.out);
    const dryDb = samplesDb.openSamplesStore({ path: dbPath });
    check("dry-run 零写入", dryDb.store.counts().samples === 0);
    dryDb.store.close();

    r = run(["--apply"]);
    check("apply 退出码 0", r.status === 0, r.out.slice(-200));
    check("apply inserted=3", /inserted=3/.test(r.out));
    const applyDb = samplesDb.openSamplesStore({ path: dbPath });
    check("apply 后样本 3 行", applyDb.store.counts().samples === 3);
    check("blocks 总数（3 样本 × 3 blocks = 9）", applyDb.store.counts().blocks === 9,
      JSON.stringify(applyDb.store.counts()));
    check("feedback 行数 = 1 样本 1 页反馈", applyDb.store.counts().feedback === 1);
    applyDb.store.close();

    const afterTree1 = hashTree(root);
    check("apply 未改动任何 raw 文件（内容+mtime）",
      JSON.stringify(beforeTree) === JSON.stringify(afterTree1));

    r = run(["--apply"]);
    check("二跑 inserted=0 updated=0 duplicate=3", /inserted=0\s+updated=0\s+duplicate=3/.test(r.out),
      r.out);
    const afterTree2 = hashTree(root);
    check("二跑仍未改动 raw", JSON.stringify(beforeTree) === JSON.stringify(afterTree2));
    const finalDb = samplesDb.openSamplesStore({ path: dbPath });
    check("二跑后行数不变", finalDb.store.counts().samples === 3);
    finalDb.store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* 真实 real_samples 只读验证：对生产 raw 跑 dry-run（天然零写入），并核对 raw 未动 */
async function runRealSamplesReadOnlyCheck() {
  const { spawnSync } = require("child_process");
  const root = path.resolve(__dirname, "..", "..", "real_samples");
  if (!fs.existsSync(root)) {
    console.log("  [SKIP] 本机无 real_samples/");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-backfill-real-"));
  try {
    const dbPath = path.join(tmp, "samples.db");
    const before = hashTree(root);
    const r = spawnSync(process.execPath,
      [path.join(__dirname, "backfill.js"), "--root", root, "--db", dbPath, "--dry-run"],
      { encoding: "utf8" });
    check("真实样本 dry-run 退出码 0", r.status === 0, (r.stdout || "").slice(-200));
    const m = /scanned=(\d+)\s+valid=(\d+)/.exec(r.stdout || "");
    check("真实样本扫描数 > 0（本机有历史样本）", m && Number(m[1]) > 0,
      m && m[0]);
    const after = hashTree(root);
    check("真实 raw 未被改动", JSON.stringify(before) === JSON.stringify(after));
    console.log("  （真实样本统计：" + (m && m[0]) + "）");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(function (e) {
  console.error("test harness error:", e);
  process.exit(1);
});
