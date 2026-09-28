#!/usr/bin/env node
/* report.js —— USAGE_TELEMETRY_V1 本地 CLI 报表（DATA_PLATFORM_V1_DESIGN.md §A13）
   不做公网 Admin 页面（Collector 经 Tunnel 对外，统计后台绝不暴露）——只在本机跑：

     node tools/telemetry/report.js --days 1|7|30 [--json] [--recompute]

   输出：活跃设备 DAU/WAU/MAU、新设备、冷启动、文字搜题（有结果率/无结果率/详情打开）、
   拍题（尝试/成功/取消/失败）、识别题量与置信度分布、AUTO 题型分布、人工题型纠正、
   反馈类型分布、学习模式使用、错误计数、版本分布、直方图分布。
   --recompute：从 telemetry_batches.payload 全量重建两张 daily 聚合表（batch 可重算）。
   只读查询（除 --recompute），绝不修改 raw batches。 */
"use strict";

const path = require("path");
const store = require("./store.js");

function parseArgs(argv) {
  const args = { days: 7, json: false, recompute: false, db: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") { args.days = Number(argv[++i]) || 7; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--recompute") { args.recompute = true; }
    else if (a === "--db") { args.db = argv[++i]; }
    else if (a === "--help" || a === "-h") { args.help = true; }
  }
  return args;
}

function localDayString(ms) {
  const d = new Date(ms);
  const p2 = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function pct(part, total) {
  if (!total) { return "—"; }
  return Math.round(part / total * 1000) / 10 + "%";
}

function histogramName(metric) {
  const at = metric.indexOf("|");
  return at < 0 ? null : { name: metric.slice(0, at), bucket: metric.slice(at + 1) };
}

function buildReport(db, days, nowMs) {
  const fromDay = localDayString(nowMs - (days - 1) * 86400000);
  const fromEpoch = nowMs - days * 86400000;
  const out = {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    fromDay: fromDay,
    dau: db.activeDevices(localDayString(nowMs - 0 * 86400000)),
    wau: db.activeDevices(localDayString(nowMs - 6 * 86400000)),
    mau: db.activeDevices(localDayString(nowMs - 29 * 86400000)),
    newDevicesInWindow: db.newDevices(fromEpoch),
    totalDevices: db.totalDevices()
  };
  const totals = {};
  for (const row of db.metricTotals(fromDay)) { totals[row.metric_name] = row.total; }
  const get = function (k) { return totals[k] || 0; };
  out.metrics = {};

  /* 概览计数 */
  out.coldStarts = get("app_cold_start");
  out.resumes = get("app_resume");

  /* 文字搜题 */
  out.search = {
    textSearch: get("text_search"),
    withResults: get("text_search_with_results"),
    noResult: get("text_search_no_result"),
    resultOpen: get("search_result_open"),
    withResultsRate: pct(get("text_search_with_results"), get("text_search")),
    noResultRate: pct(get("text_search_no_result"), get("text_search"))
  };

  /* 拍题 */
  out.photo = {
    attempt: get("photo_attempt"),
    captureSuccess: get("photo_capture_success"),
    cancel: get("photo_cancel"),
    failure: get("photo_failure"),
    processSuccess: get("photo_process_success"),
    processFailure: get("photo_process_failure")
  };

  /* 识别置信度 */
  out.recognition = {
    questionTotal: get("recognized_question_total"),
    confidenceHigh: get("confidence_high"),
    confidenceMedium: get("confidence_medium"),
    confidenceLow: get("confidence_low"),
    confidenceNone: get("confidence_none")
  };
  const qt = out.recognition.questionTotal;
  out.recognition.highRate = pct(out.recognition.confidenceHigh, qt);
  out.recognition.mediumRate = pct(out.recognition.confidenceMedium, qt);
  out.recognition.lowRate = pct(out.recognition.confidenceLow, qt);
  out.recognition.noneRate = pct(out.recognition.confidenceNone, qt);

  /* AUTO 与人工纠正 */
  out.auto = {
    single: get("auto_single"),
    multi: get("auto_multi"),
    judge: get("auto_judge"),
    manualCorrections: get("type_manual_correction")
  };

  /* 反馈 */
  out.feedback = {
    missingQuestion: get("feedback_missing_question"),
    wrongScreenNumber: get("feedback_wrong_screen_number"),
    wrongPageType: get("feedback_wrong_page_type"),
    wrongAnswer: get("feedback_wrong_answer"),
    other: get("feedback_other")
  };

  /* 学习模式 */
  out.modes = {
    sequence: get("mode_sequence_start"),
    random: get("mode_random_start"),
    single: get("mode_single_start"),
    multi: get("mode_multi_start"),
    judge: get("mode_judge_start"),
    wrong: get("mode_wrong_start"),
    recite: get("mode_recite_start"),
    exam: get("mode_exam_start")
  };

  /* 错误 */
  out.errors = {
    camera: get("camera_error"),
    ocr: get("ocr_error"),
    matcher: get("matcher_error"),
    telemetryUpload: get("telemetry_upload_error")
  };

  /* 直方图 */
  out.histograms = {};
  for (const metric of Object.keys(totals)) {
    const h = histogramName(metric);
    if (!h) { continue; }
    if (!out.histograms[h.name]) { out.histograms[h.name] = {}; }
    out.histograms[h.name][h.bucket] = totals[metric];
  }

  /* 版本分布 */
  out.versionDistribution = db.versionDistribution(fromEpoch);
  return out;
}

function renderReport(r) {
  const L = [];
  L.push("MSQ 使用统计（DATA_PLATFORM_V1，本地报表）");
  L.push("窗口：" + r.fromDay + " 起 " + r.windowDays + " 天（客户端本地日）· 生成于 " + r.generatedAt);
  L.push("");
  L.push("== 活跃设备 ==");
  L.push("  DAU（今日）        " + r.dau);
  L.push("  WAU（近 7 天）     " + r.wau);
  L.push("  MAU（近 30 天）    " + r.mau);
  L.push("  窗口内新设备       " + r.newDevicesInWindow);
  L.push("  累计设备           " + r.totalDevices);
  L.push("  冷启动 / 恢复      " + r.coldStarts + " / " + r.resumes);
  L.push("");
  L.push("== 文字搜题 ==");
  L.push("  搜题次数           " + r.search.textSearch);
  L.push("  有结果率           " + r.search.withResultsRate + "（" + r.search.withResults + "）");
  L.push("  无结果率           " + r.search.noResultRate + "（" + r.search.noResult + "）");
  L.push("  搜索结果打开       " + r.search.resultOpen);
  L.push("");
  L.push("== 拍题 ==");
  L.push("  尝试 / 拍摄成功    " + r.photo.attempt + " / " + r.photo.captureSuccess);
  L.push("  取消 / 失败        " + r.photo.cancel + " / " + r.photo.failure);
  L.push("  处理成功 / 失败    " + r.photo.processSuccess + " / " + r.photo.processFailure);
  L.push("");
  L.push("== 整页识别 ==");
  L.push("  识别题目总量       " + r.recognition.questionTotal);
  L.push("  高 / 中 / 低 / 未匹配  " +
    r.recognition.confidenceHigh + "（" + r.recognition.highRate + "） / " +
    r.recognition.confidenceMedium + "（" + r.recognition.mediumRate + "） / " +
    r.recognition.confidenceLow + "（" + r.recognition.lowRate + "） / " +
    r.recognition.confidenceNone + "（" + r.recognition.noneRate + "）");
  L.push("");
  L.push("== AUTO 题型 ==");
  L.push("  单选 / 多选 / 判断 " + r.auto.single + " / " + r.auto.multi + " / " + r.auto.judge);
  L.push("  人工题型纠正       " + r.auto.manualCorrections);
  L.push("");
  L.push("== 用户反馈 ==");
  L.push("  漏题               " + r.feedback.missingQuestion);
  L.push("  题号异常           " + r.feedback.wrongScreenNumber);
  L.push("  题型判断错误       " + r.feedback.wrongPageType);
  L.push("  答案有误（题目级） " + r.feedback.wrongAnswer);
  L.push("  其他               " + r.feedback.other);
  L.push("");
  L.push("== 学习模式启动 ==");
  const modeNames = ["sequence", "random", "single", "multi", "judge", "wrong", "recite", "exam"];
  const zh = { sequence: "顺序", random: "随机", single: "单选", multi: "多选",
    judge: "判断", wrong: "错题", recite: "背题", exam: "模拟考试" };
  L.push("  " + modeNames.map(function (m) { return zh[m] + " " + r.modes[m]; }).join(" ｜ "));
  L.push("");
  L.push("== 错误 ==");
  L.push("  相机 / OCR / 匹配器 / telemetry 上传  " +
    r.errors.camera + " / " + r.errors.ocr + " / " + r.errors.matcher + " / " +
    r.errors.telemetryUpload);
  for (const name of Object.keys(r.histograms)) {
    L.push("");
    L.push("== 直方图：" + name + " ==");
    for (const bucket of Object.keys(r.histograms[name])) {
      L.push("  " + bucket.padEnd(12) + " " + r.histograms[name][bucket]);
    }
  }
  L.push("");
  L.push("== App 版本分布（窗口内上报设备） ==");
  if (!r.versionDistribution.length) { L.push("  （无数据）"); }
  for (const v of r.versionDistribution) {
    L.push("  " + String(v.versionName).padEnd(16) + "vc" + v.versionCode +
      "  " + v.channel.padEnd(7) + "  设备 " + v.devices);
  }
  return L.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node tools/telemetry/report.js --days 1|7|30 [--json] [--recompute] [--db <path>]");
    process.exit(0);
  }
  const dbPath = args.db || path.resolve(__dirname, "..", "..", "data", "telemetry", "telemetry.db");
  const opened = store.openTelemetryStore({ path: dbPath });
  if (!opened.ok) {
    console.error("telemetry.db 不可用：" + opened.error);
    process.exit(1);
  }
  const db = opened.store;
  try {
    if (args.recompute) {
      const r = db.recomputeDaily();
      console.log("[recompute] 已从 " + r.batches + " 个 raw batch 重建 daily 聚合表");
    }
    const report = buildReport(db, args.days, Date.now());
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report));
    }
  } finally {
    db.close();
  }
}

if (require.main === module) { main(); }

module.exports = { buildReport: buildReport, renderReport: renderReport, parseArgs: parseArgs };
