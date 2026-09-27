#!/usr/bin/env node
/* store.js —— SAMPLE_DATABASE_V1 服务端存储（data/samples/samples.db）
   DATA_PLATFORM_V1_DESIGN.md §11/§12/§13。

   原则（任务书 B）：
   - 手机端 SampleQueue 零改动；raw artifact（capture.jpg/run.json/feedback.json）仍是
     source-of-truth，本库只是 index + query + analytics，Raw → DB 单向，绝不反写。
   - 图片绝不入 SQLite BLOB：只存 provider/object_key/local_path/sha256/size/width/height。
   - recordSample / recordFeedback 幂等：同 sampleId 重试不产生重复行；
     raw 已存在 + DB 缺失时重跑可补写（在线双写与 backfill 共用同一实现）。
   - 本模块的任何异常由调用方（server.js 双写挂点 / backfill）兜底吞掉，
     绝不影响既有 sample commit / feedback 链路。 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* 规范化 JSON（键递归排序）：content_hash 的稳定序列化 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) { return "[" + value.map(canonicalJson).join(",") + "]"; }
  const keys = Object.keys(value).sort();
  return "{" + keys.map(function (k) {
    return JSON.stringify(k) + ":" + canonicalJson(value[k]);
  }).join(",") + "}";
}

function numOrNull(v) {
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

function strOrNull(v, max) {
  if (v === null || v === undefined) { return null; }
  const s = String(v);
  return s.length ? s.slice(0, max || 200) : null;
}

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS samples (
         sample_id TEXT PRIMARY KEY,
         captured_at TEXT,
         received_at INTEGER NOT NULL,
         app_version_name TEXT,
         version_code INTEGER,
         channel TEXT,
         page_type_mode TEXT,
         detected_type TEXT,
         question_count INTEGER,
         confidence_high INTEGER NOT NULL DEFAULT 0,
         confidence_medium INTEGER NOT NULL DEFAULT 0,
         confidence_low INTEGER NOT NULL DEFAULT 0,
         confidence_none INTEGER NOT NULL DEFAULT 0,
         ocr_ms INTEGER,
         split_ms INTEGER,
         match_ms INTEGER,
         total_ms INTEGER,
         content_hash TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sample_files (
         sample_id TEXT NOT NULL REFERENCES samples(sample_id),
         kind TEXT NOT NULL,
         provider TEXT,
         object_key TEXT,
         local_path TEXT,
         sha256 TEXT,
         size INTEGER,
         width INTEGER,
         height INTEGER,
         PRIMARY KEY(sample_id, kind))`,
      `CREATE TABLE IF NOT EXISTS sample_blocks (
         sample_id TEXT NOT NULL REFERENCES samples(sample_id),
         block_index INTEGER NOT NULL,
         screen_number TEXT,
         raw_screen_number TEXT,
         number_source TEXT,
         detected_type TEXT,
         final_bank_id NUMERIC,
         final_answer TEXT,
         confidence TEXT,
         matched_by_options INTEGER,
         candidates_json TEXT,
         block_json TEXT,
         PRIMARY KEY(sample_id, block_index))`,
      `CREATE TABLE IF NOT EXISTS sample_feedback (
         sample_id TEXT NOT NULL REFERENCES samples(sample_id),
         scope TEXT NOT NULL,
         key TEXT NOT NULL,
         value_json TEXT,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY(sample_id, scope, key))`,
      `CREATE INDEX IF NOT EXISTS idx_samples_captured ON samples(captured_at)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_bank ON sample_blocks(final_bank_id)`
    ]
  }
];

function loadSqlite() {
  try { return require("node:sqlite"); } catch (e) { return null; }
}

function openSamplesStore(options) {
  const opts = options || {};
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { ok: false, error: "node:sqlite unavailable in this Node runtime" };
  }
  try {
    fs.mkdirSync(path.dirname(opts.path), { recursive: true });
    const db = new sqlite.DatabaseSync(opts.path);
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
  /* ---- 派生记录（run.json → samples/sample_blocks/sample_files 行） ---- */

  function deriveSample(input) {
    const manifest = input.manifest || {};
    const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
    const timing = (manifest.timing && typeof manifest.timing === "object") ? manifest.timing : {};
    const conf = { high: 0, medium: 0, low: 0, none: 0 };
    for (const b of blocks) {
      const c = b && b.confidence;
      if (c === "high" || c === "medium" || c === "low") { conf[c] += 1; }
      else { conf.none += 1; }
    }
    const image = (manifest.image && typeof manifest.image === "object") ? manifest.image : {};
    const files = {
      kind: "capture",
      provider: strOrNull(input.provider, 20),
      object_key: strOrNull(input.objectKey, 300),
      local_path: input.localPath ? String(input.localPath) : null,
      sha256: strOrNull(input.sha256, 64),
      size: numOrNull(input.size),
      width: numOrNull(input.width !== undefined ? input.width : image.width),
      height: numOrNull(input.height !== undefined ? input.height : image.height)
    };
    const sample = {
      sample_id: input.sampleId,
      captured_at: strOrNull(manifest.capturedAt, 40),
      app_version_name: strOrNull(manifest.appVersionName, 40),
      version_code: numOrNull(manifest.versionCode),
      channel: strOrNull(manifest.channel, 20),
      page_type_mode: strOrNull(manifest.pageTypeMode, 20),
      detected_type: strOrNull(manifest.pageType, 20),
      question_count: blocks.length,
      confidence_high: conf.high,
      confidence_medium: conf.medium,
      confidence_low: conf.low,
      confidence_none: conf.none,
      ocr_ms: numOrNull(timing.ocrMs),
      split_ms: numOrNull(timing.splitMs),
      match_ms: numOrNull(timing.matchMs),
      total_ms: numOrNull(timing.totalMs)
    };
    const normBlocks = blocks.map(function (b, i) {
      const blk = b || {};
      return {
        block_index: i,
        screen_number: strOrNull(blk.screenNumber, 20),
        raw_screen_number: strOrNull(blk.rawScreenNumber, 20),
        number_source: strOrNull(blk.numberSource, 20),
        detected_type: strOrNull(blk.type, 20),
        final_bank_id: (blk.finalBankId === undefined) ? null : blk.finalBankId,
        final_answer: strOrNull(blk.finalAnswer, 40),
        confidence: strOrNull(blk.confidence, 20),
        matched_by_options: blk.matchedByOptions === true ? 1 : 0,
        candidates_json: canonicalJson(Array.isArray(blk.candidates) ? blk.candidates : []),
        block_json: canonicalJson(blk)
      };
    });
    return { sample: sample, files: files, blocks: normBlocks };
  }

  function contentHashOf(derived) {
    return sha256Hex(Buffer.from(canonicalJson({
      sample: derived.sample, files: derived.files, blocks: derived.blocks
    }), "utf8"));
  }

  /* ---- 只读判定（backfill --dry-run 用，零写入）：inserted | updated | duplicate ---- */
  function classifySample(input) {
    const derived = deriveSample(input);
    const hash = contentHashOf(derived);
    const existing = db.prepare(
      "SELECT content_hash FROM samples WHERE sample_id = ?").get(input.sampleId);
    if (!existing) { return "inserted"; }
    return existing.content_hash === hash ? "duplicate" : "updated";
  }

  /* ---- 幂等 upsert（§12）。返回 "inserted" | "updated" | "duplicate" ---- */
  function recordSample(input) {
    const now = (input && input.nowMs) || Date.now();
    const derived = deriveSample(input);
    const hash = contentHashOf(derived);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare(
        "SELECT content_hash FROM samples WHERE sample_id = ?").get(input.sampleId);
      if (existing && existing.content_hash === hash) {
        db.exec("COMMIT");
        return "duplicate";
      }
      if (!existing) {
        ensureSampleRow(derived.sample, hash, now);
      } else {
        updateSampleRow(derived.sample, hash, now);
      }
      db.prepare(
        `INSERT INTO sample_files
           (sample_id, kind, provider, object_key, local_path, sha256, size, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sample_id, kind) DO UPDATE SET
           provider = excluded.provider, object_key = excluded.object_key,
           local_path = excluded.local_path, sha256 = excluded.sha256,
           size = excluded.size, width = excluded.width, height = excluded.height`
      ).run(input.sampleId, derived.files.kind, derived.files.provider,
        derived.files.object_key, derived.files.local_path, derived.files.sha256,
        derived.files.size, derived.files.width, derived.files.height);
      db.prepare("DELETE FROM sample_blocks WHERE sample_id = ?").run(input.sampleId);
      const ins = db.prepare(
        `INSERT INTO sample_blocks
           (sample_id, block_index, screen_number, raw_screen_number, number_source,
            detected_type, final_bank_id, final_answer, confidence, matched_by_options,
            candidates_json, block_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const b of derived.blocks) {
        ins.run(input.sampleId, b.block_index, b.screen_number, b.raw_screen_number,
          b.number_source, b.detected_type, b.final_bank_id, b.final_answer,
          b.confidence, b.matched_by_options, b.candidates_json, b.block_json);
      }
      db.exec("COMMIT");
      return existing ? "updated" : "inserted";
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) { /* 已回滚 */ }
      throw e;
    }
  }

  function ensureSampleRow(s, hash, now) {
    db.prepare(
      `INSERT INTO samples
         (sample_id, captured_at, received_at, app_version_name, version_code, channel,
          page_type_mode, detected_type, question_count, confidence_high,
          confidence_medium, confidence_low, confidence_none,
          ocr_ms, split_ms, match_ms, total_ms, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.sample_id, s.captured_at, now, s.app_version_name, s.version_code, s.channel,
      s.page_type_mode, s.detected_type, s.question_count, s.confidence_high,
      s.confidence_medium, s.confidence_low, s.confidence_none,
      s.ocr_ms, s.split_ms, s.match_ms, s.total_ms, hash, now, now);
  }

  function updateSampleRow(s, hash, now) {
    db.prepare(
      `UPDATE samples SET
         captured_at = ?, app_version_name = ?, version_code = ?, channel = ?,
         page_type_mode = ?, detected_type = ?, question_count = ?,
         confidence_high = ?, confidence_medium = ?, confidence_low = ?, confidence_none = ?,
         ocr_ms = ?, split_ms = ?, match_ms = ?, total_ms = ?,
         content_hash = ?, updated_at = ?
       WHERE sample_id = ?`
    ).run(s.captured_at, s.app_version_name, s.version_code, s.channel,
      s.page_type_mode, s.detected_type, s.question_count, s.confidence_high,
      s.confidence_medium, s.confidence_low, s.confidence_none,
      s.ocr_ms, s.split_ms, s.match_ms, s.total_ms, hash, now, s.sample_id);
  }

  /* ---- 反馈同步（§12.3 / B6）：与 raw feedback.json v2 状态全量一致 ----
     state = readFeedbackState 形状：{ schemaVersion, pageIssues, blockIssues, legacy }
     单事务全量替换（DELETE + 重插），天然支持 set / remove / v2 全量替换语义。 */
  function recordFeedback(sampleId, state, nowMs) {
    const now = nowMs || Date.now();
    const st = state || {};
    const pageIssues = Array.isArray(st.pageIssues) ? st.pageIssues : [];
    const blockIssues = Array.isArray(st.blockIssues) ? st.blockIssues : [];
    const legacy = (st.legacy && typeof st.legacy === "object") ? st.legacy : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      /* feedback 可能先于本库首见（旧样本收到新反馈）：先保证 samples 行存在。
         content_hash='feedback-only' 占位，后续 recordSample 会以真实 hash 覆盖。 */
      db.prepare(
        `INSERT OR IGNORE INTO samples(sample_id, received_at, content_hash, created_at, updated_at)
         VALUES (?, ?, 'feedback-only', ?, ?)`
      ).run(sampleId, now, now, now);
      db.prepare("DELETE FROM sample_feedback WHERE sample_id = ?").run(sampleId);
      const ins = db.prepare(
        `INSERT INTO sample_feedback(sample_id, scope, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`);
      for (const p of pageIssues) {
        if (!p || typeof p.type !== "string") { continue; }
        ins.run(sampleId, "page", p.type, canonicalJson({ type: p.type }), now);
      }
      for (const b of blockIssues) {
        if (!b || typeof b.issue !== "string") { continue; }
        const idx = numOrNull(b.blockIndex);
        if (idx === null) { continue; }
        ins.run(sampleId, "block", idx + ":" + b.issue, canonicalJson(b), now);
      }
      if (legacy && (legacy.userFlag || (Array.isArray(legacy.screenNumbers) &&
          legacy.screenNumbers.length))) {
        ins.run(sampleId, "legacy", "userFlag", canonicalJson({
          userFlag: strOrNull(legacy.userFlag, 200),
          screenNumbers: Array.isArray(legacy.screenNumbers) ? legacy.screenNumbers : []
        }), now);
      }
      db.prepare("UPDATE samples SET updated_at = ? WHERE sample_id = ?").run(now, sampleId);
      db.exec("COMMIT");
      return { ok: true };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) { /* 已回滚 */ }
      throw e;
    }
  }

  /* ---- 统计 / 测试辅助 ---- */
  function counts() {
    return {
      samples: db.prepare("SELECT COUNT(*) AS n FROM samples").get().n,
      files: db.prepare("SELECT COUNT(*) AS n FROM sample_files").get().n,
      blocks: db.prepare("SELECT COUNT(*) AS n FROM sample_blocks").get().n,
      feedback: db.prepare("SELECT COUNT(*) AS n FROM sample_feedback").get().n
    };
  }

  function getSample(sampleId) {
    return db.prepare("SELECT * FROM samples WHERE sample_id = ?").get(sampleId) || null;
  }

  function getBlocks(sampleId) {
    return db.prepare(
      "SELECT * FROM sample_blocks WHERE sample_id = ? ORDER BY block_index").all(sampleId);
  }

  function getFiles(sampleId) {
    return db.prepare("SELECT * FROM sample_files WHERE sample_id = ?").all(sampleId);
  }

  function getFeedback(sampleId) {
    return db.prepare(
      "SELECT * FROM sample_feedback WHERE sample_id = ? ORDER BY scope, key").all(sampleId);
  }

  function close() {
    try { db.close(); } catch (e) { /* 尽力 */ }
  }

  return {
    recordSample: recordSample,
    classifySample: classifySample,
    recordFeedback: recordFeedback,
    counts: counts,
    getSample: getSample,
    getBlocks: getBlocks,
    getFiles: getFiles,
    getFeedback: getFeedback,
    close: close
  };
}

module.exports = {
  openSamplesStore: openSamplesStore,
  canonicalJson: canonicalJson
};
