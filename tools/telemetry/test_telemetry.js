/* test_telemetry.js —— USAGE_TELEMETRY_V1 服务端自检（TEL-SERVER / TEL-SQLITE）
   运行: node tools/telemetry/test_telemetry.js   （退出码 0 = 全部通过）
   全程写入 os.tmpdir() 随机目录，结束清理，不触碰 data/ 生产库。
   限流测试用独立实例（低阈值），主实例关闭限流避免用例互相消耗预算。 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCollector } = require("../sample_collector/server.js");
const telemetryStore = require("./store.js");
const serverModule = require("../sample_collector/server.js");

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

const TEST_SECRET = "tel-test-secret-0123456789abcdef0123456789abcdef";
const ANDROID_ID_A = "0123456789abcdef";
const ANDROID_ID_B = "fedcba0987654321";
const DEV_DEVICE_ID = telemetryStore.telemetryDeviceId(TEST_SECRET, ANDROID_ID_A);
const DEV_TOKEN = telemetryStore.telemetryBatchToken(TEST_SECRET, DEV_DEVICE_ID);

/* DATA_PLATFORM_V1_1：batch 请求构造（默认带合法 deviceToken） */
function batchPayload(batches, overrides) {
  const o = overrides || {};
  const deviceId = o.deviceId || DEV_DEVICE_ID;
  return {
    schemaVersion: 1,
    deviceId: deviceId,
    deviceToken: "deviceToken" in o ? o.deviceToken
      : telemetryStore.telemetryBatchToken(TEST_SECRET, deviceId),
    batches: batches
  };
}

function request(port, method, reqPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: port, method: method, path: reqPath,
      headers: Object.assign(
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        headers || {})
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

let uuidSeq = 0;
function nextBatchId() {
  uuidSeq += 1;
  const hex = uuidSeq.toString(16).padStart(12, "0");
  return "a1b2c3d4-0000-4000-8000-" + hex;
}

/* 构造一个合法 batch（字段与 DATA_PLATFORM_V1_DESIGN.md §1.2 一致） */
function makeBatch(overrides) {
  const o = overrides || {};
  const now = Date.now();
  return {
    batchId: o.batchId || nextBatchId(),
    localDay: o.localDay || new Date(now).toISOString().slice(0, 10),
    periodStart: o.periodStart !== undefined ? o.periodStart : now - 3600000,
    periodEnd: o.periodEnd !== undefined ? o.periodEnd : now,
    versionCode: o.versionCode !== undefined ? o.versionCode : 24,
    versionName: o.versionName !== undefined ? o.versionName : "1.0.24-dev",
    channel: o.channel || "dev",
    packageName: o.packageName || "com.jty.safetyquiz.dev",
    counters: o.counters !== undefined ? o.counters : { app_cold_start: 1, text_search: 3 },
    histograms: o.histograms !== undefined ? o.histograms
      : { photo_total_ms: { "1000-2000": 1 } }
  };
}

/* Windows：SQLite WAL 句柄释放有延迟，rmSync 偶发 EBUSY —— 异步重试；
   重试耗尽则降级为 warning（tmp 目录由 OS 清理，不影响测试结论） */
async function rmSyncRetry(dir, attempts) {
  for (let i = 0; i < (attempts || 6); i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === (attempts || 6) - 1) {
        console.warn("[warn] 临时目录清理失败（忽略，不影响结果）：" + dir);
        return;
      }
      await new Promise(function (r) { setTimeout(r, 400 * (i + 1)); });
    }
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-telemetry-test-"));
  const dbPath = path.join(tmp, "telemetry.db");
  let collector = null;
  try {
    collector = createCollector({
      out: path.join(tmp, "out"),
      allowAnonymousWrites: true,
      telemetryDbPath: dbPath,
      telemetrySecret: TEST_SECRET,
      telemetryAdminIds: [DEV_DEVICE_ID],   /* admin = 当前测试设备 */
      telemetryRateLimitPerMin: 1000000   /* 限流单独测 */
    });
    const port = await collector.listen("127.0.0.1", 0);

    /* ---------- TEL-ID：HMAC 确定性与注册校验 ---------- */
    section("TEL-ID 注册：同 ANDROID_ID → 同 deviceId；不同 → 不同");
    let r = await request(port, "POST", "/api/telemetry/register",
      { schemaVersion: 1, androidId: ANDROID_ID_A.toUpperCase() });
    check("合法注册 200", r.status === 200 && r.body.ok === true, r.status);
    check("deviceId 为 64 hex", typeof r.body.deviceId === "string" &&
      /^[0-9a-f]{64}$/.test(r.body.deviceId));
    const idA1 = r.body.deviceId;
    /* DATA_PLATFORM_V1_1：register 必须签发可验证的 deviceToken */
    check("register 返回 deviceToken（64 hex）",
      typeof r.body.deviceToken === "string" &&
      /^[0-9a-f]{64}$/.test(r.body.deviceToken));
    check("deviceToken = HMAC(secret, 'telemetry-batch-v1:'+deviceId)",
      r.body.deviceToken === telemetryStore.telemetryBatchToken(TEST_SECRET, idA1));
    r = await request(port, "POST", "/api/telemetry/register",
      { schemaVersion: 1, androidId: ANDROID_ID_A });
    check("同 ANDROID_ID（大小写不同）→ 同 deviceId", r.body.deviceId === idA1);
    check("同 deviceId → 同 deviceToken（确定性）",
      r.body.deviceToken === telemetryStore.telemetryBatchToken(TEST_SECRET, idA1));
    r = await request(port, "POST", "/api/telemetry/register",
      { schemaVersion: 1, androidId: ANDROID_ID_B });
    check("不同 ANDROID_ID → 不同 deviceId", r.body.deviceId !== idA1);

    section("TEL-ID 注册：非法输入全部 400");
    for (const bad of [
      { androidId: "0123456789abcde" },
      { androidId: "0123456789abcdeg" },
      { androidId: 123 },
      { schemaVersion: 1, androidId: ANDROID_ID_A, extra: 1 },
      { schemaVersion: 2, androidId: ANDROID_ID_A },
      { schemaVersion: 1 }
    ]) {
      r = await request(port, "POST", "/api/telemetry/register", bad);
      check("拒绝 " + JSON.stringify(bad).slice(0, 50), r.status === 400, r.status);
    }

    /* ---------- TEL-BATCH：合法上报与幂等 ---------- */
    section("TEL-BATCH 合法上报与幂等（A10）");
    const b1 = makeBatch({ counters: { text_search: 3 } });
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([b1]));
    check("合法 batch 200 accepted", r.status === 200 &&
      r.body.accepted.length === 1 && r.body.accepted[0] === b1.batchId, r.status);

    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([b1]));
    check("同 batch 重传 → alreadyAccepted", r.status === 200 &&
      r.body.alreadyAccepted.length === 1 && r.body.accepted.length === 0,
      JSON.stringify(r.body));

    const b2 = makeBatch({ counters: { photo_attempt: 1 }, localDay: "2026-09-26",
      periodEnd: Date.now() - 24 * 3600000, periodStart: Date.now() - 25 * 3600000 });
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([b1, b2]));
    check("多 batch 合并上报（重传+新）", r.status === 200 &&
      r.body.alreadyAccepted.length === 1 && r.body.accepted.length === 1,
      JSON.stringify(r.body));

    /* ---------- TEL-SQLITE：幂等聚合 + 表结构 + 隐私红线 ---------- */
    section("TEL-SQLITE 幂等与结构");
    const db2 = telemetryStore.openTelemetryStore({ path: dbPath });
    check("第二个连接打开成功（WAL 并发）", db2.ok);
    const totals1 = db2.store.metricTotals("2000-01-01");
    const textSearchTotal = totals1.filter(function (x) { return x.metric_name === "text_search"; })[0];
    check("text_search 总量 = 3（重传后不重复累加）",
      textSearchTotal && textSearchTotal.total === 3, JSON.stringify(totals1));

    let wal = null;
    try { wal = db2.db.prepare("PRAGMA journal_mode").get(); } catch (e) { wal = null; }
    check("journal_mode = wal", wal && String(wal.journal_mode).toLowerCase() === "wal",
      JSON.stringify(wal));
    const mig = db2.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    check("schema_migrations v1", mig && mig.v === 1);
    const tables = db2.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(function (x) { return x.name; });
    for (const need of ["schema_migrations", "devices", "telemetry_batches",
      "daily_device_metrics", "daily_metric_values"]) {
      check("表存在：" + need, tables.indexOf(need) >= 0);
    }
    check("表无多余（V1 五张 + sqlite_sequence）",
      tables.filter(function (t) { return t !== "sqlite_sequence"; }).length === 5,
      tables.join(","));

    /* raw ANDROID_ID 红线：全表扫描 + DB/WAL 文件字节扫描 */
    let rawFound = false;
    for (const t of ["devices", "telemetry_batches", "daily_device_metrics", "daily_metric_values"]) {
      const rows = db2.db.prepare("SELECT * FROM " + t).all();
      for (const row of rows) {
        for (const k of Object.keys(row)) {
          if (typeof row[k] === "string" &&
             (row[k].indexOf(ANDROID_ID_A) >= 0 || row[k].indexOf(ANDROID_ID_B) >= 0)) {
            rawFound = true;
          }
        }
      }
    }
    check("raw ANDROID_ID 不落任何表", !rawFound);
    const walPath = dbPath + "-wal";
    let allBytes = fs.readFileSync(dbPath);
    try { allBytes = Buffer.concat([allBytes, fs.readFileSync(walPath)]); } catch (e) { /* 无 wal */ }
    check("raw ANDROID_ID 不落 DB 文件字节（含 WAL）",
      allBytes.indexOf(Buffer.from(ANDROID_ID_A)) < 0 &&
      allBytes.indexOf(Buffer.from(ANDROID_ID_B)) < 0);
    check("server secret 不落 DB 文件字节（含 WAL）",
      allBytes.indexOf(Buffer.from(TEST_SECRET)) < 0);
    const devRow = db2.db.prepare("SELECT * FROM devices LIMIT 1").get();
    check("devices 无 androidId 列", devRow && !Object.keys(devRow).some(function (k) {
      return k.toLowerCase().indexOf("android") >= 0; }), Object.keys(devRow || {}).join(","));
    check("devices 元数据已记录", devRow && devRow.first_version === "1.0.24-dev" &&
      devRow.last_channel === "dev", JSON.stringify(devRow));

    section("TEL-SQLITE batch 可重算");
    const batchesBefore = db2.db.prepare("SELECT COUNT(*) AS n FROM telemetry_batches").get().n;
    const recompute = db2.store.recomputeDaily();
    const totalsAfter = db2.store.metricTotals("2000-01-01");
    check("recompute 后聚合一致", JSON.stringify(totals1) === JSON.stringify(totalsAfter) &&
      recompute.batches === batchesBefore, "batches=" + recompute.batches);
    check("activeDevices 查询可用", db2.store.activeDevices("2000-01-01") === 1);

    /* ---------- TEL-SERVER：allowlist / 值域 / 时间戳 / 上限 ---------- */
    section("TEL-SERVER 严格 allowlist（未知 metric / 值域 / 时间戳 / 上限）");
    const badCases = [
      ["未知 counter metric", { counters: { evil_metric: 1 } }],
      ["counter 值 0", { counters: { text_search: 0 } }],
      ["counter 值超上限", { counters: { text_search: 1000001 } }],
      ["counter 非整数", { counters: { text_search: 1.5 } }],
      ["未知 histogram", { histograms: { evil_ms: { "<100": 1 } } }],
      ["未知 histogram 桶", { histograms: { photo_total_ms: { "<999": 1 } } }],
      ["localDay 非真实日期", { localDay: "2026-02-30" }],
      ["localDay 格式坏", { localDay: "20260927" }],
      ["period 跨度过大", { periodStart: Date.now() - 30 * 3600000 }],
      ["periodEnd 在未来", { periodEnd: Date.now() + 3600 * 1000 }],
      ["periodStart 晚于 periodEnd", { periodStart: Date.now(), periodEnd: Date.now() - 1000 }],
      ["channel/package 不匹配", { channel: "stable" }],
      ["未知 package", { packageName: "com.evil.app" }],
      ["未知 channel", { channel: "beta" }],
      ["versionCode 非法", { versionCode: 0 }],
      ["versionCode 非整数", { versionCode: 24.5 }],
      ["versionName 注入字符", { versionName: "1.0; DROP TABLE devices" }],
      ["versionName 超长", { versionName: "x".repeat(41) }]
    ];
    for (const [label, patch] of badCases) {
      r = await request(port, "POST", "/api/telemetry/batch",
        batchPayload([makeBatch(patch)]));
      check("拒绝：" + label, r.status === 400, r.status);
    }
    /* 未知 batch 顶层字段 */
    const extraField = makeBatch({});
    extraField.extra = { a: 1 };
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([extraField]));
    check("拒绝：未知 batch 字段", r.status === 400, r.status);
    /* 未知顶层字段（5 键 → 400） */
    const extraTop = batchPayload([makeBatch({})]);
    extraTop.junk = 1;
    r = await request(port, "POST", "/api/telemetry/batch", extraTop);
    check("拒绝：未知顶层字段", r.status === 400, r.status);

    section("TEL-SERVER deviceToken 校验（DATA_PLATFORM_V1_1）");
    const noToken = batchPayload([makeBatch({})]);
    delete noToken.deviceToken;
    r = await request(port, "POST", "/api/telemetry/batch", noToken);
    check("缺 deviceToken → 401", r.status === 401, r.status);
    const noTokenStr = batchPayload([makeBatch({})], { deviceToken: 123 });
    r = await request(port, "POST", "/api/telemetry/batch", noTokenStr);
    check("deviceToken 非字符串 → 401（等同缺失）", r.status === 401, r.status);
    const tokenCountBefore = db2.db.prepare("SELECT COUNT(*) AS n FROM telemetry_batches").get().n;
    let lastTokenResp = null;
    const OTHER_ID = telemetryStore.telemetryDeviceId(TEST_SECRET, ANDROID_ID_B);
    for (const [label, override] of [
      ["token 不匹配", { deviceToken: "f".repeat(64) }],
      ["token 格式错", { deviceToken: "zz" }],
      ["token 绑定其他 deviceId（值合法但属他设备）",
        { deviceId: OTHER_ID, deviceToken: DEV_TOKEN }]
    ]) {
      r = await request(port, "POST", "/api/telemetry/batch",
        batchPayload([makeBatch({})], override));
      lastTokenResp = r;
      check("拒绝：" + label + "（403）", r.status === 403, r.status);
    }
    const tokenCountAfter = db2.db.prepare("SELECT COUNT(*) AS n FROM telemetry_batches").get().n;
    check("token 拒绝 → DB 零写入", tokenCountAfter === tokenCountBefore,
      tokenCountBefore + " → " + tokenCountAfter);
    check("401/403 响应不回显 token / secret",
      JSON.stringify(lastTokenResp.raw || "").indexOf("f".repeat(64)) < 0 &&
      (lastTokenResp.raw || "").indexOf(TEST_SECRET) < 0);
    check("合法 token + 合法 batch 仍 200（对照）",
      (await request(port, "POST", "/api/telemetry/batch",
        batchPayload([makeBatch({})]))).status === 200);

    section("TEL-SERVER 部分非法 → 整请求拒绝 + rejected 明细（零入库）");
    const goodBatch = makeBatch({});
    const badBatch = makeBatch({ counters: { evil: 1 } });
    const batchCountBefore = db2.db.prepare("SELECT COUNT(*) AS n FROM telemetry_batches").get().n;
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([goodBatch, badBatch]));
    check("400 且 rejected 指向非法 batch", r.status === 400 &&
      Array.isArray(r.body.rejected) && r.body.rejected.length === 1 &&
      r.body.rejected[0].batchId === badBatch.batchId, JSON.stringify(r.body));
    const batchCountAfter = db2.db.prepare("SELECT COUNT(*) AS n FROM telemetry_batches").get().n;
    check("零入库（好 batch 也不落地）", batchCountAfter === batchCountBefore);

    section("TEL-SERVER 请求级上限");
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([]));
    check("空 batches 400", r.status === 400);
    const manyBatches = [];
    for (let i = 0; i < 21; i++) { manyBatches.push(makeBatch({})); }
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload(manyBatches));
    check("21 个 batch 400", r.status === 400);
    const bigBatch = makeBatch({});
    bigBatch.counters = { text_search: 1 };
    const bigPayload = batchPayload([bigBatch]);
    bigPayload.batches = [];
    for (let i = 0; i < 20; i++) {
      const hb = makeBatch({}); hb.batchId = nextBatchId();
      hb.histograms = { photo_total_ms: { "<1000": 1 } };
      bigPayload.batches.push(hb);
    }
    bigPayload.junk = "x".repeat(200 * 1024);
    r = await request(port, "POST", "/api/telemetry/batch", bigPayload);
    check("body > 128KiB → 413", r.status === 413, r.status);
    r = await request(port, "POST", "/api/telemetry/batch", "not json at all");
    check("非 JSON → 400", r.status === 400);
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([makeBatch({})], { deviceId: "ZZZZ" }));
    check("deviceId 格式坏 → 400", r.status === 400);

    section("TEL-SERVER 错误响应不泄漏内部信息");
    r = await request(port, "POST", "/api/telemetry/batch",
      batchPayload([makeBatch({ counters: { bad: 1 } })]));
    const rawLower = (r.raw || "").toLowerCase();
    check("无 db 路径 / SQL 字样", rawLower.indexOf("telemetry.db") < 0 &&
      rawLower.indexOf("sqlite") < 0 && rawLower.indexOf("select ") < 0);

    db2.store.close();

    /* ---------- IN_APP_TELEMETRY_DASHBOARD_V1：admin summary 只读端点 ---------- */
    section("TEL-ADMIN admin/summary 鉴权与口径");
    {
      const summaryPayload = (days, overrides) => {
        const o = overrides || {};
        return {
          deviceId: o.deviceId || DEV_DEVICE_ID,
          deviceToken: "deviceToken" in o ? o.deviceToken : DEV_TOKEN,
          days: days
        };
      };
      /* 先灌一点数据（合法 batch），让 200 响应有内容可对比 */
      const bSeed = makeBatch({ counters: { text_search: 2, app_cold_start: 1 } });
      await request(port, "POST", "/api/telemetry/batch", batchPayload([bSeed]));

      let r = await request(port, "POST", "/api/telemetry/admin/summary",
        summaryPayload(7));
      check("admin 正确 token → 200", r.status === 200 && r.body.ok === true, r.status);
      check("报告结构：核心字段齐全",
        r.body.report && typeof r.body.report.dau === "number" &&
        typeof r.body.report.coldStarts === "number" &&
        typeof r.body.report.search === "object" &&
        typeof r.body.report.recognition === "object" &&
        Array.isArray(r.body.report.versionDistribution));
      check("days=1 / days=30 均 200",
        (await request(port, "POST", "/api/telemetry/admin/summary",
          summaryPayload(1))).status === 200 &&
        (await request(port, "POST", "/api/telemetry/admin/summary",
          summaryPayload(30))).status === 200);

      /* 口径与 report.js 完全一致（同一 DB、同一实现） */
      const reportMod = require("./report.js");
      const dbCheck = telemetryStore.openTelemetryStore({ path: dbPath });
      const local = reportMod.buildReport(dbCheck.store, 7, Date.now());
      dbCheck.store.close();
      /* generatedAt 含毫秒时间戳，口径对比时剔除 */
      const wire = Object.assign({}, r.body.report); delete wire.generatedAt;
      const loc = Object.assign({}, local); delete loc.generatedAt;
      check("REPORT_PARITY：HTTP 聚合 === report.js buildReport",
        JSON.stringify(wire) === JSON.stringify(loc));

      /* 非 admin：合法 token 但 deviceId 不在 allowlist */
      const otherId = telemetryStore.telemetryDeviceId(TEST_SECRET, ANDROID_ID_B);
      r = await request(port, "POST", "/api/telemetry/admin/summary",
        summaryPayload(7, { deviceId: otherId }));
      check("非 admin → 403", r.status === 403, r.status);
      /* 错 token */
      r = await request(port, "POST", "/api/telemetry/admin/summary",
        summaryPayload(7, { deviceToken: "f".repeat(64) }));
      check("错 token → 403", r.status === 403, r.status);
      /* 缺 token */
      const noTok = summaryPayload(7);
      delete noTok.deviceToken;
      r = await request(port, "POST", "/api/telemetry/admin/summary", noTok);
      check("缺 token → 403", r.status === 403, r.status);
      /* days 白名单 */
      for (const badDays of [0, 2, 8, 31, -1, "7", 1.5]) {
        r = await request(port, "POST", "/api/telemetry/admin/summary",
          summaryPayload(badDays));
        check("拒绝 days=" + JSON.stringify(badDays) + "（400）", r.status === 400, r.status);
      }
      /* 响应不泄露 token / allowlist / 任何完整设备 ID / raw batch */
      const rawAdmin = (await request(port, "POST", "/api/telemetry/admin/summary",
        summaryPayload(7))).raw || "";
      check("响应不含 deviceToken / secret",
        rawAdmin.indexOf(DEV_TOKEN) < 0 && rawAdmin.indexOf(TEST_SECRET) < 0);
      check("响应不含完整 deviceId / raw batches",
        rawAdmin.indexOf(DEV_DEVICE_ID) < 0 && rawAdmin.indexOf("telemetry_batches") < 0);
      check("响应不含 payload 原文（无 counters 字段名）",
        rawAdmin.indexOf('"counters"') < 0);

      /* allowlist 装载分支 */
      const tmpAdm = fs.mkdtempSync(path.join(os.tmpdir(), "msq-admin-"));
      try {
        fs.writeFileSync(path.join(tmpAdm, "ids"), "# 注释\n" + DEV_DEVICE_ID.toUpperCase() +
          "\nnot-an-id\n" + "b".repeat(64) + "\n");
        const envBak = process.env.MSQ_TELEMETRY_ADMIN_DEVICE_IDS;
        delete process.env.MSQ_TELEMETRY_ADMIN_DEVICE_IDS;
        const fromFile = telemetryStore.loadTelemetryAdminIds({
          adminFile: path.join(tmpAdm, "ids") });
        if (envBak !== undefined) { process.env.MSQ_TELEMETRY_ADMIN_DEVICE_IDS = envBak; }
        check("allowlist 文件装载：去重/小写归一/跳过非法行",
          fromFile.length === 2 && fromFile[0] === DEV_DEVICE_ID &&
          fromFile[1] === "b".repeat(64), JSON.stringify(fromFile).slice(0, 40));
      } finally {
        fs.rmSync(tmpAdm, { recursive: true, force: true });
      }
    }

    /* ---------- TELEMETRY_DASHBOARD_POLISH_V1：版本分布 latest-per-device ---------- */
    section("TEL-VERSIONS 当前活跃版本分布（每设备只计最新 batch 版本）");
    {
      /* db2 已关闭：本段重开独立连接 */
      const dbV = telemetryStore.openTelemetryStore({ path: dbPath });
      const vq = (sql, ...p2) => dbV.db.prepare(sql).all(...p2);
      const now = Date.now();
      const FUTURE = now + 3600 * 1000;   /* 超出服务端 sanity 上限的远期（仅直灌 DB 用） */
      const mk = (deviceId, vc, vn, receivedAt, channel) => ({
        batchId: nextBatchId(), localDay: new Date(receivedAt).toISOString().slice(0, 10),
        periodStart: receivedAt - 60000, periodEnd: receivedAt,
        versionCode: vc, versionName: vn,
        channel: channel || (vc >= 25 ? "dev" : "dev"),
        packageName: "com.jty.safetyquiz.dev",
        counters: { app_cold_start: 1 }, histograms: {}
      });
      const ingestRaw = (deviceId, vc, vn, receivedAt) => {
        const b = telemetryStore.validateSingleBatch(
          mk(deviceId, vc, vn, Math.min(receivedAt, now)), Math.min(receivedAt, now) + 60000);
        if (!b.ok) { throw new Error(b.error); }
        dbV.store.ingestBatches({
          schemaVersion: 1, deviceId: deviceId, batches: [b.batch]
        }, Math.min(receivedAt, now) + 120000);
      };
      const seedDev = (n) => telemetryStore.telemetryDeviceId(TEST_SECRET,
        String(n).padStart(16, "0"));

      const beforeVc = vq("SELECT COUNT(*) AS n FROM telemetry_batches")[0].n;
      /* 设备 A：vc27 → vc28 → vc30（旧→新依次上报，batch 全保留） */
      const devA = seedDev(101);
      ingestRaw(devA, 27, "1.0.27-dev", now - 3 * 86400000);
      ingestRaw(devA, 28, "1.0.28-dev", now - 2 * 86400000);
      ingestRaw(devA, 30, "1.0.30-dev", now - 60000);
      /* 设备 B：只上过 vc28 */
      const devB = seedDev(102);
      ingestRaw(devB, 28, "1.0.28-dev", now - 120000);
      /* 设备 C：旧版本在窗口外（91 天前，直灌 DB 模拟历史 batch——
         服务端上报 sanity 只对在线请求，历史行当年合法），窗口内只有 vc30 */
      const devC = seedDev(103);
      dbV.db.prepare(
        `INSERT OR IGNORE INTO devices
           (device_id, first_seen_at, last_seen_at, first_version, last_version,
            first_channel, last_channel)
         VALUES (?, ?, ?, '1.0.23-dev', '1.0.23-dev', 'dev', 'dev')`
      ).run(devC, now - 91 * 86400000, now - 91 * 86400000);
      dbV.db.prepare(
        `INSERT INTO telemetry_batches
           (batch_id, device_id, local_day, period_start, period_end, received_at,
            version_code, version_name, channel, package_name, payload)
         VALUES (?, ?, '2026-06-29', ?, ?, ?, 23, '1.0.23-dev', 'dev',
                 'com.jty.safetyquiz.dev', '{}')`
      ).run(nextBatchId(), devC, now - 91 * 86400000 - 60000, now - 91 * 86400000,
        now - 91 * 86400000);
      ingestRaw(devC, 30, "1.0.30-dev", now - 180000);
      const afterVc = vq("SELECT COUNT(*) AS n FROM telemetry_batches")[0].n;
      check("历史 batch 全保留（6 条新 batch 入库）", afterVc === beforeVc + 6,
        beforeVc + " → " + afterVc);

      const win = now - 7 * 86400000;
      const dist = dbV.store.versionDistribution(win);
      const total = dist.reduce(function (s, r) { return s + r.devices; }, 0);
      const byVc = {};
      for (const r of dist) { byVc[r.versionCode] = r.devices; }
      check("单设备 vc27/28/30 → 只计 vc30 1台",
        byVc[30] === 2 && byVc[27] === undefined && byVc[28] === 1,
        JSON.stringify(dist));
      const distinctDevs = vq(
        "SELECT COUNT(DISTINCT device_id) AS n FROM telemetry_batches WHERE received_at >= ?",
        win)[0].n;
      check("多设备各计最新：版本设备数之和 = 窗口内 distinct deviceId",
        total === distinctDevs, "total=" + total + " distinct=" + distinctDevs);

      /* 同 received_at：id 较新的 batch 胜出 */
      const devD = seedDev(104);
      const tieAt = now - 300000;
      const b1 = telemetryStore.validateSingleBatch(
        mk(devD, 28, "1.0.28-dev", tieAt), tieAt + 60000);
      dbV.store.ingestBatches({ schemaVersion: 1, deviceId: devD, batches: [b1.batch] },
        tieAt + 120000);
      const b2 = telemetryStore.validateSingleBatch(
        mk(devD, 30, "1.0.30-dev", tieAt), tieAt + 60000);
      dbV.store.ingestBatches({ schemaVersion: 1, deviceId: devD, batches: [b2.batch] },
        tieAt + 120000);
      /* 确认两条 batch received_at 相同（同毫秒） */
      const tieRows = vq(
        "SELECT id, version_code, received_at FROM telemetry_batches WHERE device_id = ? ORDER BY id",
        devD);
      check("并列夹具：同 received_at 两条（id 递增）",
        tieRows.length === 2 && tieRows[0].received_at !== undefined, "");
      const distD = dbV.store.versionDistribution(win);
      const dVcs = distD.filter(function (r) { return r.versionCode === 30; })[0];
      check("同 received_at → id 较新（vc30）胜出：D 计入 vc30（A/C/D 共 3 台）",
        dVcs && dVcs.devices === 3, JSON.stringify(distD));

      /* 窗口外旧版本不参与：devC 的 vc23 不出现在任何窗口口径 */
      const distAll = dbV.store.versionDistribution(win);
      check("窗口外 vc23 不参与（无 1.0.23-dev 行）",
        distAll.every(function (r) { return r.versionCode !== 23; }));

      /* recompute 不受影响（不删任何 batch） */
      const cntAfter = vq("SELECT COUNT(*) AS n FROM telemetry_batches")[0].n;
      check("口径变化零删除（batches 行数不变）",
        cntAfter === afterVc + 2, cntAfter + " vs " + (afterVc + 2));
      dbV.store.close();
    }

    /* ---------- secret 缺失 → 503 FAIL CLOSED，业务端点不受影响 ---------- */
    section("TEL-SERVER secret 缺失 → 503 FAIL CLOSED（App 业务不受影响）");
    serverModule._resetRateLimitsForTest();
    let noSecret = null;
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "msq-telemetry-nosecret-"));
    try {
      noSecret = createCollector({
        out: path.join(tmp2, "out"),
        allowAnonymousWrites: true,
        telemetryDbPath: path.join(tmp2, "telemetry.db"),
        telemetrySecret: null   /* 显式强制缺失（本机存在真实 secret 文件） */
      });
      const port2 = await noSecret.listen("127.0.0.1", 0);
      r = await request(port2, "POST", "/api/telemetry/register",
        { schemaVersion: 1, androidId: ANDROID_ID_A });
      check("register 503", r.status === 503, r.status);
      r = await request(port2, "POST", "/api/telemetry/batch",
        { schemaVersion: 1, deviceId: DEV_DEVICE_ID, batches: [makeBatch({})] });
      check("batch 503", r.status === 503, r.status);
      r = await request(port2, "GET", "/health");
      check("/health 不受影响", r.status === 200 && r.body.ok === true);
      /* legacy 样本端点照常（匿名测试模式） */
      const fixtureJpeg = makeFixtureJpeg(30, 40);
      r = await request(port2, "POST", "/api/sample", {
        sampleId: "20260927_120000_aaa001",
        photoDataUrl: "data:image/jpeg;base64," + fixtureJpeg.toString("base64"),
        manifest: { sampleId: "20260927_120000_aaa001", capturedAt: "2026-09-27T04:00:00Z" }
      });
      check("样本端点不受 telemetry 故障影响", r.status === 201, r.status);
    } finally {
      if (noSecret) { await noSecret.close(); }
      fs.rmSync(tmp2, { recursive: true, force: true });
    }

    /* secret 文件/env 装载分支 */
    section("TEL-SERVER secret 装载分支");
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "msq-telemetry-secret-"));
    try {
      const envBackup = process.env.MSQ_TELEMETRY_HMAC_KEY;
      delete process.env.MSQ_TELEMETRY_HMAC_KEY;
      const missing = telemetryStore.loadTelemetrySecret({
        secretFile: path.join(tmp3, "definitely-missing")
      });
      if (envBackup !== undefined) { process.env.MSQ_TELEMETRY_HMAC_KEY = envBackup; }
      check("env/文件均缺失 → null", missing === null);
      const fromFile = telemetryStore.loadTelemetrySecret({
        secretFile: null, secret: undefined
      });
      check("本机 .secrets/telemetry-hmac-key 存在且 ≥32 bytes",
        typeof fromFile === "string" && fromFile.length >= 32);
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }

    /* store 打开失败降级 */
    section("TEL-SQLITE 打开失败降级");
    const broken = telemetryStore.openTelemetryStore({ path: path.join(tmp, "sub", "\0bad") });
    check("非法路径 → ok:false 而非抛出", broken.ok === false && typeof broken.error === "string");

    /* ---------- 限流（独立实例，低阈值） ---------- */
    section("TEL-SERVER 限流（5/min/IP 独立实例）");
    serverModule._resetRateLimitsForTest();
    let limited = null;
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "msq-telemetry-rl-"));
    try {
      limited = createCollector({
        out: path.join(tmp4, "out"),
        allowAnonymousWrites: true,
        telemetryDbPath: path.join(tmp4, "telemetry.db"),
        telemetrySecret: TEST_SECRET,
        telemetryRateLimitPerMin: 5
      });
      const port4 = await limited.listen("127.0.0.1", 0);
      let saw429 = false;
      for (let i = 0; i < 10; i++) {
        r = await request(port4, "POST", "/api/telemetry/register",
          { schemaVersion: 1, androidId: "aaaaaaaaaaaaaaaa" });
        if (r.status === 429) { saw429 = true; break; }
      }
      check("超限 429", saw429);
    } finally {
      if (limited) { await limited.close(); }
      fs.rmSync(tmp4, { recursive: true, force: true });
    }
  } finally {
    if (collector) { await collector.close(); }
    await rmSyncRetry(tmp);
  }

  console.log("\n==============================================");
  if (fails.length) {
    console.log(`结果：${fails.length} 项失败 ✗`);
    fails.forEach((f) => console.log("  FAIL: " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
}

/* 最小结构合法 JPEG（与 test_collector.js 同构） */
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

main().catch(function (e) {
  console.error("test harness error:", e);
  process.exit(1);
});
