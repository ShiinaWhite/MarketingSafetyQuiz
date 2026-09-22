/* compare.js —— A/B 对比两份基准报告（harness 代码）。
   用法：node testbench/harness/compare.js <baseline.json> <candidate.json>
   输出 BASELINE / CANDIDATE / DELTA 表；并按优化约束判定是否可接受：
     - HIGH_CONFIDENCE_WRONG 不得高于 baseline
     - ANSWER_ACCURACY / TOP1_MATCH_ACCURACY 不得低于 baseline
     - TOTAL_PIPELINE_MS p95 不得超过 baseline 的 2 倍（性能护栏）
   判定为 PASS 时退出码 0，否则 1。 */
"use strict";
const fs = require("fs");

const metrics = [
  ["PAGE_SPLIT_COUNT_ACCURACY", "%", false],
  ["SCREEN_NUMBER_ACCURACY", "%", false],
  ["TYPE_ACCURACY", "%", false],
  ["TOP1_MATCH_ACCURACY", "%", true],          /* 硬约束：不得下降 */
  ["TOP3_MATCH_ACCURACY", "%", false],
  ["ANSWER_ACCURACY", "%", true],              /* 硬约束：不得下降 */
  ["ANSWER_COVERAGE", "%", false],
  ["ANSWERED_PRECISION", "%", false],
  ["HIGH_COUNT", "条", false],
  ["HIGH_PRECISION", "%", false],
  ["MEDIUM_COUNT", "条", false],
  ["MEDIUM_PRECISION", "%", false],
  ["LOW_COUNT", "条", false],
  ["LOW_PRECISION", "%", false],
  ["NONE_COUNT", "条", false],
  ["OVERALL_DISPLAY_COUNT", "条", false],
  ["OVERALL_DISPLAY_PRECISION", "%", false],
  ["OVERALL_DISPLAY_COVERAGE", "%", false],
  ["ANSWER_ACCURACY_RAW", "%", false],
  ["HIGH_CONFIDENCE_WRONG", "条", true],       /* 方向取反（越少越好），且为硬约束 */
  ["CONFIDENCE_FALSE_NEGATIVE", "条", false],
  ["MEDIUM_CONFIDENCE_WRONG", "条", false],
  ["LOW_CONFIDENCE_WRONG", "条", false]
];
const timingKeys = ["OCR_TIME_MS", "SPLIT_TIME_MS", "MATCH_TIME_MS", "TOTAL_PIPELINE_MS"];

function num(x) { return typeof x === "number" && isFinite(x) ? x : null; }
function f2(x) { return x === null ? "—" : (Math.round(x * 100) / 100).toFixed(2); }

function main() {
  const [, , aPath, bPath] = process.argv;
  if (!aPath || !bPath) {
    console.error("用法：node testbench/harness/compare.js <baseline_report.json> <candidate_report.json>");
    process.exit(1);
  }
  const A = JSON.parse(fs.readFileSync(aPath, "utf8")).metrics;
  const B = JSON.parse(fs.readFileSync(bPath, "utf8")).metrics;
  const lines = [];
  lines.push("指标                                  BASELINE      CANDIDATE     DELTA");
  lines.push("-".repeat(84));
  for (const [k, unit, invert] of metrics) {
    const a = num(A[k]), b = num(B[k]);
    if (a === null && b === null) { continue; }
    const d = a !== null && b !== null ? b - a : null;
    const tag = d === null ? "" : (Math.abs(d) < 1e-9 ? " =" : (d > 0 ? " +" : " "));
    lines.push(k.padEnd(36) + f2(a).padStart(10) + unit.padStart(3) + f2(b).padStart(12) +
      unit.padStart(3) + (d === null ? "     —" : tag + f2(Math.abs(d)).padStart(7) + " " + unit));
  }
  for (const tk of timingKeys) {
    const sa = (A.timing || {})[tk] || {}, sb = (B.timing || {})[tk] || {};
    lines.push((tk + ".p50").padEnd(36) + f2(num(sa.p50)).padStart(10) + "ms" + f2(num(sb.p50)).padStart(12) + "ms" +
      (num(sa.p50) !== null && num(sb.p50) !== null ? f2(num(sb.p50) - num(sa.p50)).padStart(9) : "     —"));
    lines.push((tk + ".p95").padEnd(36) + f2(num(sa.p95)).padStart(10) + "ms" + f2(num(sb.p95)).padStart(12) + "ms" +
      (num(sa.p95) !== null && num(sb.p95) !== null ? f2(num(sb.p95) - num(sa.p95)).padStart(9) : "     —"));
  }
  lines.push("-".repeat(84));
  console.log(lines.join("\n"));

  const checks = [];
  const hw = [num(A.HIGH_CONFIDENCE_WRONG), num(B.HIGH_CONFIDENCE_WRONG)];
  if (hw[0] !== null && hw[1] !== null) {
    checks.push(["HIGH_CONFIDENCE_WRONG 不高于 baseline", hw[1] <= hw[0],
      hw[0] + " -> " + hw[1]]);
  }
  for (const k of ["ANSWER_ACCURACY", "TOP1_MATCH_ACCURACY"]) {
    const v = [num(A[k]), num(B[k])];
    if (v[0] !== null && v[1] !== null) {
      checks.push([k + " 不低于 baseline", v[1] >= v[0], f2(v[0]) + " -> " + f2(v[1])]);
    }
  }
  const pa = num((A.timing || {}).TOTAL_PIPELINE_MS?.p95), pb = num((B.timing || {}).TOTAL_PIPELINE_MS?.p95);
  if (pa !== null && pb !== null) {
    checks.push(["TOTAL p95 ≤ baseline×2（性能护栏）", pb <= pa * 2 + 1, f2(pa) + "ms -> " + f2(pb) + "ms"]);
  }
  let ok = true;
  console.log("\n约束检查：");
  for (const [name, pass, detail] of checks) {
    if (!pass) { ok = false; }
    console.log("  [" + (pass ? "PASS" : "FAIL") + "] " + name + "  (" + detail + ")");
  }
  console.log(ok ? "\n结论：可接受（ACCEPT）" : "\n结论：不满足约束（REJECT）");
  process.exit(ok ? 0 : 1);
}
main();
