#!/usr/bin/env node
/* store.js —— USAGE_TELEMETRY_V1 服务端存储（data/telemetry/telemetry.db）
   DATA_PLATFORM_V1_DESIGN.md §1/§2/§3/§9/§10。

   零第三方依赖：node:sqlite（Node ≥22.13 内置，本机 v22.23.2 实测可用）。
   require("node:sqlite") 失败 → isAvailable()=false，server.js 对 telemetry 端点
   FAIL CLOSED（503），其余业务端点完全不受影响。

   隐私红线（DATA_PLATFORM_V1_DESIGN.md §17）：
   - 本模块没有任何字段存储原始 ANDROID_ID；register 只做内存 HMAC 计算。
   - 日志绝不输出请求体；错误响应不含 DB 路径 / SQL / 堆栈。 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ---------------- METRIC_CATALOG_V1（服务端唯一 allowlist，§2） ---------------- */

const COUNTER_METRICS = [
  /* 生命周期 */
  "app_cold_start", "app_resume",
  /* 文字搜题 */
  "text_search", "text_search_with_results", "text_search_no_result", "search_result_open",
  /* 拍题 */
  "photo_attempt", "photo_capture_success", "photo_cancel", "photo_failure",
  "photo_process_success", "photo_process_failure",
  /* 整页识别 */
  "recognized_question_total", "confidence_high", "confidence_medium",
  "confidence_low", "confidence_none",
  /* AUTO */
  "auto_single", "auto_multi", "auto_judge", "type_manual_correction",
  /* 用户反馈 */
  "feedback_missing_question", "feedback_wrong_screen_number",
  "feedback_wrong_page_type", "feedback_wrong_answer", "feedback_other",
  /* 学习功能 */
  "mode_sequence_start", "mode_random_start", "mode_single_start", "mode_multi_start",
  "mode_judge_start", "mode_wrong_start", "mode_recite_start", "mode_exam_start",
  /* 错误 */
  "camera_error", "ocr_error", "matcher_error", "telemetry_upload_error"
];

const HISTOGRAM_METRICS = {
  photo_total_ms: ["<1000", "1000-2000", "2000-4000", "4000-8000", ">=8000"],
  ocr_ms: ["<500", "500-1000", "1000-2000", "2000-4000", ">=4000"]
};

const CHANNELS = ["dev", "stable", "unknown"];
const PACKAGES = {
  "com.jty.safetyquiz.dev": "dev",
  "com.jty.safetyquiz": "stable"
};

const MAX_BATCHES_PER_REQUEST = 20;
const MAX_COUNTER_KEYS = 40;
const MAX_COUNTER_VALUE = 1_000_000;
const MAX_PERIOD_SPAN_MS = 26 * 3600_000;
const PERIOD_FUTURE_SLACK_MS = 10 * 60_000;
const PERIOD_MAX_AGE_MS = 90 * 24 * 3600_000;

/* ---------------- 小工具 ---------------- */

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* 规范化 JSON（键递归排序）：content_hash / payload 的稳定序列化 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) { return "[" + value.map(canonicalJson).join(",") + "]"; }
  const keys = Object.keys(value).sort();
  return "{" + keys.map(function (k) {
    return JSON.stringify(k) + ":" + canonicalJson(value[k]);
  }).join(",") + "}";
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isIntInRange(v, min, max) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= min && v <= max;
}

/* YYYY-MM-DD 且为真实日历日期 */
function validDayString(s) {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) { return false; }
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) { return false; }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function utcDayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/* 两 YYYY-MM-DD 的间隔天数（a-b） */
function dayDiff(a, b) {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}

/* ---------------- 校验（§1/§2，纯函数，客户端与测试共用同一形状） ---------------- */

function validateRegisterBody(body) {
  if (!isPlainObject(body)) { return { ok: false, error: "body must be a JSON object" }; }
  if (body.schemaVersion !== 1) { return { ok: false, error: "unsupported schemaVersion" }; }
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.indexOf("androidId") < 0) {
    return { ok: false, error: "unknown or missing fields" };
  }
  if (typeof body.androidId !== "string" || !/^[0-9a-f]{16}$/i.test(body.androidId)) {
    return { ok: false, error: "invalid androidId" };
  }
  return { ok: true, androidId: body.androidId.toLowerCase() };
}

function validateBatchBody(body, nowMs) {
  if (!isPlainObject(body)) { return { ok: false, error: "body must be a JSON object" }; }
  if (body.schemaVersion !== 1) { return { ok: false, error: "unsupported schemaVersion" }; }
  /* DATA_PLATFORM_V1_1：顶层 = schemaVersion/deviceId/deviceToken/batches 四键。
     deviceToken 的值校验（64 hex）在此，匹配性校验由 server.js 用
     timing-safe compare 完成（需要 secret，纯函数不持有）。 */
  const topKeys = Object.keys(body);
  if (topKeys.length !== 4 ||
      topKeys.indexOf("deviceId") < 0 || topKeys.indexOf("batches") < 0 ||
      topKeys.indexOf("deviceToken") < 0) {
    return { ok: false, error: "unknown or missing top-level fields" };
  }
  if (typeof body.deviceId !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceId)) {
    return { ok: false, error: "invalid deviceId" };
  }
  if (typeof body.deviceToken !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceToken)) {
    return { ok: false, error: "invalid deviceToken" };
  }
  if (!Array.isArray(body.batches) || body.batches.length < 1 ||
      body.batches.length > MAX_BATCHES_PER_REQUEST) {
    return { ok: false, error: "batches must contain 1.." + MAX_BATCHES_PER_REQUEST + " items" };
  }
  /* 逐 batch 校验：全部合法才入库；任何一个非法 → 整请求 400（零入库），
     并逐 batch 返回 rejected 明细，客户端据此只丢弃被拒批次（§8） */
  const normalized = [];
  const rejected = [];
  for (let i = 0; i < body.batches.length; i++) {
    const one = validateSingleBatch(body.batches[i], nowMs);
    if (!one.ok) {
      rejected.push({
        batchId: (isPlainObject(body.batches[i]) &&
          typeof body.batches[i].batchId === "string")
          ? body.batches[i].batchId.toLowerCase() : null,
        batchIndex: i,
        error: one.error
      });
    } else {
      normalized.push(one.batch);
    }
  }
  if (rejected.length) {
    return { ok: false, error: "batch validation failed", rejected: rejected };
  }
  return { ok: true, deviceId: body.deviceId, batches: normalized };
}

function validateSingleBatch(b, nowMs) {
  if (!isPlainObject(b)) { return { ok: false, error: "batch must be an object" }; }
  const REQUIRED = ["batchId", "localDay", "periodStart", "periodEnd", "versionCode",
    "versionName", "channel", "packageName", "counters", "histograms"];
  for (const k of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) { return { ok: false, error: "missing " + k }; }
  }
  if (Object.keys(b).length !== REQUIRED.length) {
    return { ok: false, error: "unknown fields in batch" };
  }
  if (typeof b.batchId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.batchId)) {
    return { ok: false, error: "invalid batchId" };
  }
  if (!validDayString(b.localDay)) { return { ok: false, error: "invalid localDay" }; }
  if (!isIntInRange(b.periodStart, 1, Number.MAX_SAFE_INTEGER) ||
      !isIntInRange(b.periodEnd, 1, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "invalid period timestamps" };
  }
  if (b.periodStart > b.periodEnd) { return { ok: false, error: "periodStart after periodEnd" }; }
  if (b.periodEnd - b.periodStart > MAX_PERIOD_SPAN_MS) { return { ok: false, error: "period span too long" }; }
  if (b.periodEnd > nowMs + PERIOD_FUTURE_SLACK_MS) { return { ok: false, error: "periodEnd in the future" }; }
  if (b.periodStart < nowMs - PERIOD_MAX_AGE_MS) { return { ok: false, error: "period too old" }; }
  if (Math.abs(dayDiff(b.localDay, utcDayOf(b.periodEnd))) > 1) {
    return { ok: false, error: "localDay inconsistent with periodEnd" };
  }
  if (!isIntInRange(b.versionCode, 1, 1000000)) { return { ok: false, error: "invalid versionCode" }; }
  if (typeof b.versionName !== "string" || b.versionName.length === 0 ||
      b.versionName.length > 40 || !/^[A-Za-z0-9._\-()]+$/.test(b.versionName)) {
    return { ok: false, error: "invalid versionName" };
  }
  if (CHANNELS.indexOf(b.channel) < 0) { return { ok: false, error: "unknown channel" }; }
  if (typeof b.packageName !== "string" || !PACKAGES[b.packageName]) {
    return { ok: false, error: "unknown packageName" };
  }
  if (PACKAGES[b.packageName] !== b.channel) {
    return { ok: false, error: "channel/packageName mismatch" };
  }
  const counters = validateCounterMap(b.counters);
  if (!counters.ok) { return counters; }
  const histograms = validateHistogramMap(b.histograms);
  if (!histograms.ok) { return histograms; }
  return {
    ok: true,
    batch: {
      batchId: b.batchId.toLowerCase(),
      localDay: b.localDay,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      versionCode: b.versionCode,
      versionName: b.versionName,
      channel: b.channel,
      packageName: b.packageName,
      counters: counters.map,
      histograms: histograms.map
    }
  };
}

function validateCounterMap(m) {
  if (!isPlainObject(m)) { return { ok: false, error: "counters must be an object" }; }
  const keys = Object.keys(m);
  if (keys.length > MAX_COUNTER_KEYS) { return { ok: false, error: "too many counters" }; }
  for (const k of keys) {
    if (COUNTER_METRICS.indexOf(k) < 0) { return { ok: false, error: "unknown counter metric" }; }
    if (!isIntInRange(m[k], 1, MAX_COUNTER_VALUE)) {
      return { ok: false, error: "invalid counter value for " + k };
    }
  }
  return { ok: true, map: m };
}

function validateHistogramMap(m) {
  if (!isPlainObject(m)) { return { ok: false, error: "histograms must be an object" }; }
  const keys = Object.keys(m);
  if (keys.length > Object.keys(HISTOGRAM_METRICS).length) {
    return { ok: false, error: "too many histograms" };
  }
  for (const k of keys) {
    const buckets = HISTOGRAM_METRICS[k];
    if (!buckets) { return { ok: false, error: "unknown histogram metric" }; }
    const v = m[k];
    if (!isPlainObject(v)) { return { ok: false, error: "histogram value must be an object" }; }
    for (const label of Object.keys(v)) {
      if (buckets.indexOf(label) < 0) { return { ok: false, error: "unknown histogram bucket" }; }
      if (!isIntInRange(v[label], 1, MAX_COUNTER_VALUE)) {
        return { ok: false, error: "invalid histogram value for " + k };
      }
    }
  }
  return { ok: true, map: m };
}

/* ---------------- 设备身份（§3）：ANDROID_ID 只在此函数内存中出现 ---------------- */

function telemetryDeviceId(secret, androidIdLower) {
  return crypto.createHmac("sha256", secret)
    .update("msq-telemetry-v1:" + androidIdLower).digest("hex");
}

/* DATA_PLATFORM_V1_1：batch 端 deviceToken（服务端签发，客户端必带）。
   派生自同一 secret 但域分隔不同（跨协议不可复用）；该值是 HMAC 派生物，
   非原始 secret，允许保存在客户端本地 state。 */
function telemetryBatchToken(secret, deviceId) {
  return crypto.createHmac("sha256", secret)
    .update("telemetry-batch-v1:" + deviceId).digest("hex");
}

/* ---------------- secret 装载（环境变量优先，其次 .secrets/telemetry-hmac-key） ---------------- */

function loadTelemetrySecret(options) {
  const opts = options || {};
  if (opts.secret === null) { return null; }   /* 显式禁用（测试 FAIL CLOSED 用） */
  if (typeof opts.secret === "string" && opts.secret.length >= 32) { return opts.secret; }
  const fromEnv = (process.env.MSQ_TELEMETRY_HMAC_KEY || "").trim();
  if (fromEnv.length >= 32) { return fromEnv; }
  const file = opts.secretFile ||
    path.resolve(__dirname, "..", "..", ".secrets", "telemetry-hmac-key");
  try {
    const fromFile = fs.readFileSync(file, "utf8").trim();
    if (fromFile.length >= 32) { return fromFile; }
  } catch (e) { /* 文件不存在 */ }
  return null;
}

/* ---------------- admin allowlist（IN_APP_TELEMETRY_DASHBOARD_V1） ----------------
   MSQ_TELEMETRY_ADMIN_DEVICE_IDS：环境变量（逗号分隔）优先，其次
   .secrets/telemetry-admin-devices 文件（每行一个 64hex，# 注释）。
   只存完整 telemetryDeviceId（本身即 HMAC 派生物）；不进 Git、不打印、不进日志。 */
function parseAdminIdsText(text) {
  const out = [];
  const seen = {};
  String(text || "").split(/[\s,;]+/).forEach(function (tok) {
    const v = tok.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v) && !seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

function loadTelemetryAdminIds(options) {
  const opts = options || {};
  if (Array.isArray(opts.adminIds)) {
    return parseAdminIdsText(opts.adminIds.join(","));
  }
  const fromEnv = (process.env.MSQ_TELEMETRY_ADMIN_DEVICE_IDS || "").trim();
  if (fromEnv) { return parseAdminIdsText(fromEnv); }
  const file = opts.adminFile ||
    path.resolve(__dirname, "..", "..", ".secrets", "telemetry-admin-devices");
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
      .map(function (l) { return l.replace(/#.*$/, ""); }).join("\n");
    return parseAdminIdsText(lines);
  } catch (e) { /* 文件不存在 */ }
  return [];
}

/* ---------------- SQLite 存储 ---------------- */

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS devices (
         device_id TEXT PRIMARY KEY,
         first_seen_at INTEGER NOT NULL,
         last_seen_at INTEGER NOT NULL,
         first_version TEXT,
         last_version TEXT,
         first_channel TEXT,
         last_channel TEXT)`,
      `CREATE TABLE IF NOT EXISTS telemetry_batches (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         batch_id TEXT NOT NULL,
         device_id TEXT NOT NULL REFERENCES devices(device_id),
         local_day TEXT NOT NULL,
         period_start INTEGER NOT NULL,
         period_end INTEGER NOT NULL,
         received_at INTEGER NOT NULL,
         version_code INTEGER,
         version_name TEXT,
         channel TEXT,
         package_name TEXT,
         payload TEXT NOT NULL,
         UNIQUE(device_id, batch_id))`,
      `CREATE TABLE IF NOT EXISTS daily_device_metrics (
         device_id TEXT NOT NULL REFERENCES devices(device_id),
         day TEXT NOT NULL,
         metric_name TEXT NOT NULL,
         value INTEGER NOT NULL,
         PRIMARY KEY(device_id, day, metric_name))`,
      `CREATE TABLE IF NOT EXISTS daily_metric_values (
         day TEXT NOT NULL,
         metric_name TEXT NOT NULL,
         value INTEGER NOT NULL,
         PRIMARY KEY(day, metric_name))`,
      `CREATE INDEX IF NOT EXISTS idx_ddm_day ON daily_device_metrics(day)`,
      `CREATE INDEX IF NOT EXISTS idx_batches_received ON telemetry_batches(received_at)`
    ]
  }
];

function loadSqlite() {
  try { return require("node:sqlite"); } catch (e) { return null; }
}

/* 打开（并迁移）telemetry.db。失败返回 { ok:false, error }，绝不抛出。 */
function openTelemetryStore(options) {
  const opts = options || {};
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { ok: false, error: "node:sqlite unavailable in this Node runtime" };
  }
  const dbPath = opts.path;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
    return { ok: true, db: db, store: makeStore(db) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function migrate(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    const current = row && row.v ? row.v : 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) { continue; }
      for (const sql of m.statements) { db.exec(sql); }
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
        .run(m.version, new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (e2) { /* 已回滚 */ }
    throw e;
  }
}

function makeStore(db) {
  /* 单请求 = 单事务（§10）：一个 batch 重传 / 任何一步失败都不会部分落地 */
  function ingestBatches(body, nowMs) {
    const accepted = [];
    const alreadyAccepted = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const b of body.batches) {
        /* devices 先行（FK：telemetry_batches.device_id 引用 devices）。
           重传时 last_* 被再次刷新无语义影响（该设备确实再次上报）。 */
        upsertDevice(body.deviceId, nowMs, b);
        const info = db.prepare(
          `INSERT OR IGNORE INTO telemetry_batches
             (batch_id, device_id, local_day, period_start, period_end, received_at,
              version_code, version_name, channel, package_name, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(b.batchId, body.deviceId, b.localDay, b.periodStart, b.periodEnd, nowMs,
          b.versionCode, b.versionName, b.channel, b.packageName,
          canonicalJson({ counters: b.counters, histograms: b.histograms }));
        if (Number(info.changes) === 0) {
          alreadyAccepted.push(b.batchId);   /* 同 batch 重传：不重复聚合（幂等核心） */
          continue;
        }
        accepted.push(b.batchId);
        aggregateBatch(body.deviceId, b.localDay, b);
      }
      db.exec("COMMIT");
      return { ok: true, accepted: accepted, alreadyAccepted: alreadyAccepted };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) { /* 已回滚 */ }
      throw e;
    }
  }

  function upsertDevice(deviceId, nowMs, b) {
    db.prepare(
      `INSERT INTO devices
         (device_id, first_seen_at, last_seen_at, first_version, last_version,
          first_channel, last_channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_version = excluded.last_version,
         last_channel = excluded.last_channel`
    ).run(deviceId, nowMs, nowMs, b.versionName, b.versionName, b.channel, b.channel);
  }

  function aggregateBatch(deviceId, day, b) {
    const bumpDevice = db.prepare(
      `INSERT INTO daily_device_metrics(device_id, day, metric_name, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, day, metric_name) DO UPDATE
         SET value = value + excluded.value`);
    const bumpGlobal = db.prepare(
      `INSERT INTO daily_metric_values(day, metric_name, value)
       VALUES (?, ?, ?)
       ON CONFLICT(day, metric_name) DO UPDATE
         SET value = value + excluded.value`);
    for (const k of Object.keys(b.counters)) {
      bumpDevice.run(deviceId, day, k, b.counters[k]);
      bumpGlobal.run(day, k, b.counters[k]);
    }
    for (const h of Object.keys(b.histograms)) {
      for (const label of Object.keys(b.histograms[h])) {
        const name = h + "|" + label;
        bumpDevice.run(deviceId, day, name, b.histograms[h][label]);
        bumpGlobal.run(day, name, b.histograms[h][label]);
      }
    }
  }

  /* 从 telemetry_batches.payload 全量重建聚合表（batch 可重算，§10） */
  function recomputeDaily() {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM daily_device_metrics");
      db.exec("DELETE FROM daily_metric_values");
      const rows = db.prepare(
        "SELECT device_id, local_day, payload FROM telemetry_batches ORDER BY id").all();
      for (const r of rows) {
        let payload;
        try { payload = JSON.parse(r.payload); } catch (e) { continue; }
        aggregateBatch(r.device_id, r.local_day, {
          counters: payload.counters || {}, histograms: payload.histograms || {}
        });
      }
      db.exec("COMMIT");
      return { ok: true, batches: rows.length };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) { /* 已回滚 */ }
      throw e;
    }
  }

  /* ---- 报表查询（report.js 消费） ---- */
  function activeDevices(fromDay) {
    return db.prepare(
      "SELECT COUNT(DISTINCT device_id) AS n FROM daily_device_metrics WHERE day >= ?"
    ).get(fromDay).n;
  }

  function dailyActiveDevices() {
    return db.prepare(
      `SELECT day, COUNT(DISTINCT device_id) AS devices
       FROM daily_device_metrics GROUP BY day ORDER BY day`).all();
  }

  function metricTotals(fromDay) {
    return db.prepare(
      `SELECT metric_name, SUM(value) AS total
       FROM daily_metric_values WHERE day >= ? GROUP BY metric_name ORDER BY metric_name`
    ).all(fromDay);
  }

  function newDevices(fromEpochMs) {
    return db.prepare(
      "SELECT COUNT(*) AS n FROM devices WHERE first_seen_at >= ?").get(fromEpochMs).n;
  }

  function totalDevices() {
    return db.prepare("SELECT COUNT(*) AS n FROM devices").get().n;
  }

  /* 当前活跃版本分布（TELEMETRY_DASHBOARD_POLISH_V1）：
     窗口内每个 deviceId 只取 received_at 最新的一条 telemetry_batch
     （ORDER BY received_at DESC, id DESC，同刻并列由 id 较新者胜出），
     再按 version_name/version_code/channel 分组 —— 同一设备跨版本只计其当前
     版本 1 台；所有版本设备数之和 = 窗口内有 batch 的 distinct deviceId 数。
     历史 telemetry_batches 全部保留，本口径只是查询层。 */
  function versionDistribution(fromEpochMs) {
    return db.prepare(
      `SELECT version_name AS versionName, version_code AS versionCode, channel,
              COUNT(*) AS devices
       FROM (
         SELECT version_name, version_code, channel, device_id,
                ROW_NUMBER() OVER (
                  PARTITION BY device_id
                  ORDER BY received_at DESC, id DESC) AS rn
         FROM telemetry_batches
         WHERE received_at >= ?
       )
       WHERE rn = 1
       GROUP BY version_name, version_code, channel
       ORDER BY devices DESC`
    ).all(fromEpochMs);
  }

  function allDeviceIds() {
    return db.prepare("SELECT device_id FROM devices").all().map(function (r) { return r.device_id; });
  }

  function close() {
    try { db.close(); } catch (e) { /* 尽力 */ }
  }

  return {
    ingestBatches: ingestBatches,
    recomputeDaily: recomputeDaily,
    activeDevices: activeDevices,
    dailyActiveDevices: dailyActiveDevices,
    metricTotals: metricTotals,
    newDevices: newDevices,
    totalDevices: totalDevices,
    versionDistribution: versionDistribution,
    allDeviceIds: allDeviceIds,
    close: close
  };
}

module.exports = {
  COUNTER_METRICS: COUNTER_METRICS,
  HISTOGRAM_METRICS: HISTOGRAM_METRICS,
  CHANNELS: CHANNELS,
  PACKAGES: PACKAGES,
  MAX_BATCHES_PER_REQUEST: MAX_BATCHES_PER_REQUEST,
  canonicalJson: canonicalJson,
  validateRegisterBody: validateRegisterBody,
  validateBatchBody: validateBatchBody,
  validateSingleBatch: validateSingleBatch,
  telemetryDeviceId: telemetryDeviceId,
  telemetryBatchToken: telemetryBatchToken,
  loadTelemetrySecret: loadTelemetrySecret,
  loadTelemetryAdminIds: loadTelemetryAdminIds,
  parseAdminIdsText: parseAdminIdsText,
  openTelemetryStore: openTelemetryStore
};
