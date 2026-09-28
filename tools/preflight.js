#!/usr/bin/env node
/* preflight.js —— 统一发布前测试入口（STABLE_RELEASE_PREFLIGHT_HARDENING_V1）
   一个命令跑完整发布前测试：node tools/preflight.js [--quick]

   全量（默认）：
     test_core.js                       核心逻辑 + TEL 客户端 + STP 发布守卫
     tools/telemetry/test_telemetry.js  telemetry 服务端（含 admin/版本口径）
     tools/sample_db/test_sample_db.js  samples.db（幂等/反馈/backfill/备份）
     tools/sample_collector/test_collector.js / test_r2.js
     tools/sample_collector/test_cos_v1.js   真实 COS 端到端
     tools/dev_update/test_publish_cos.js / test_publish_r2.js
     tools/r2/secret_scan.js            provider secret 扫描
     gradlew :app:testDebugUnitTest     JVM 单测

   --quick：跳过真实 COS 与 JVM（快速循环用）。

   任一套件失败即退出码 1；全部通过退出码 0（自然退出）。 */
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const quick = process.argv.indexOf("--quick") >= 0;

const suites = [
  ["test_core", "node", ["test_core.js"]],
  ["telemetry-server", "node", ["tools/telemetry/test_telemetry.js"]],
  ["sample-db", "node", ["tools/sample_db/test_sample_db.js"]],
  ["collector", "node", ["tools/sample_collector/test_collector.js"]],
  ["r2-store", "node", ["tools/sample_collector/test_r2.js"]],
  ["secret-scan", "node", ["tools/r2/secret_scan.js"]],
  ["publish-cos", "node", ["tools/dev_update/test_publish_cos.js"]],
  ["publish-r2", "node", ["tools/dev_update/test_publish_r2.js"]],
  ["cos-live", "node", ["tools/sample_collector/test_cos_v1.js"]],
  ["jvm", path.join(ROOT, "android", "gradlew.bat"),
    [":app:testDebugUnitTest", "--console=plain"]]
];
if (quick) {
  const skip = new Set(["cos-live", "jvm"]);
  for (let i = suites.length - 1; i >= 0; i--) {
    if (skip.has(suites[i][0])) { suites.splice(i, 1); }
  }
}

const failed = [];
for (const [name, cmd, args] of suites) {
  process.stdout.write("== " + name + " … ");
  const isBat = /\\gradlew\.bat$/.test(cmd);
  const r = spawnSync(isBat ? "gradlew.bat" : cmd, args, {
    cwd: isBat ? path.join(ROOT, "android") : ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: isBat,
    env: Object.assign({}, process.env, isBat && !process.env.JAVA_HOME
      ? { JAVA_HOME: "D:/workSpace/MarketingSafetyQuiz/_build/jdk/jdk-21.0.12.1+1" } : {})
  });
  if (r.status === 0) {
    console.log("PASS");
  } else {
    failed.push(name);
    console.log("FAIL（exit " + r.status + "）");
    const tail = ((r.stdout || "") + "\n" + (r.stderr || "")).trim().split(/\r?\n/).slice(-15);
    for (const l of tail) { console.log("    " + l); }
  }
}

console.log("\n== preflight 结果 ==");
if (failed.length) {
  console.log("FAILED: " + failed.join(", "));
  process.exit(1);
}
console.log("全部通过 ✓（" + suites.length + " 套件）");
