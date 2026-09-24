#!/usr/bin/env node
/* publish.js —— DEV 更新发布工具（SELF_UPDATE_V1）
   零第三方依赖。工作流：
     node tools/dev_update/publish.js [--notes "..."] [--version-code N]
        [--version-name X.Y.Z] [--skip-sync] [--allow-new-signer]
   步骤：确定下一 versionCode → cap sync → assembleDev（-P 注入版本）→
   aapt/apksigner 实测校验（包名/版本/label/签名证书）→ 原子发布
   release/updates/dev/（先 APK 后 latest.json）→ 同步 release/营销安规刷题-DEV.apk。
   任何校验不符：拒绝发布，保留上一版更新不受影响。 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const ANDROID = path.join(ROOT, "android");
const GRADLEW = path.join(ANDROID, "gradlew.bat");
const BT = path.join(ROOT, "_build", "android-sdk", "build-tools", "36.0.0");
const AAPT = path.join(BT, "aapt.exe");
const APKSIGNER = path.join(BT, "apksigner.bat");
const JAVA_FALLBACK = path.join(ROOT, "_build", "jdk", "jdk-21.0.12.1+1");
const OUT_APK = path.join(ANDROID, "app", "build", "outputs", "apk", "dev", "app-dev.apk");
const UPDATES_DIR = path.join(ROOT, "release", "updates", "dev");
const UPDATES_APK = path.join(UPDATES_DIR, "营销安规刷题-DEV.apk");
const LATEST_JSON = path.join(UPDATES_DIR, "latest.json");
const DEV_APK = path.join(ROOT, "release", "营销安规刷题-DEV.apk");

const EXPECTED_PACKAGE = "com.jty.safetyquiz.dev";
const EXPECTED_LABEL = "营销安规刷题 DEV";
const SECRET_FILE = path.join(ROOT, ".secrets", "sample-write-token");

/* PUBLIC_SAMPLE_AUTH_V1：读取样本写接口 secret（环境变量优先，其次 .secrets/）。
   缺失/过短 → 拒绝发布（避免产出无法认证上传的 APK）。 */
function loadSampleWriteToken() {
  const fromEnv = (process.env.MSQ_SAMPLE_WRITE_TOKEN || "").trim();
  if (fromEnv) { return fromEnv; }
  try { return fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) { return ""; }
}

function fail(msg) {
  console.error("\n[发布失败] " + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { notes: "", skipSync: false, allowNewSigner: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--notes") { a.notes = argv[++i] || ""; }
    else if (k === "--version-code") { a.versionCode = Number(argv[++i]); }
    else if (k === "--version-name") { a.versionName = argv[++i]; }
    else if (k === "--skip-sync") { a.skipSync = true; }
    else if (k === "--allow-new-signer") { a.allowNewSigner = true; }
    else fail("未知参数：" + k);
  }
  return a;
}

function javaEnv() {
  const env = Object.assign({}, process.env);
  if (!env.JAVA_HOME) { env.JAVA_HOME = JAVA_FALLBACK; }
  return env;
}

/* 运行命令；.bat/.cmd 走 cmd。返回 {status, stdout, stderr}。 */
function run(cmd, args, cwd) {
  const isScript = /\.(bat|cmd)$/i.test(cmd);
  const r = isScript
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/c", cmd, ...args],
        { cwd: cwd || ROOT, env: javaEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(cmd, args,
        { cwd: cwd || ROOT, env: javaEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/* aapt 对中文路径不稳：统一先复制到 ASCII 临时路径再调用 */
function withAsciiCopy(apkPath, fn) {
  const tmp = path.join(os.tmpdir(), "msq-publish-" + crypto.randomBytes(4).toString("hex") + ".apk");
  fs.copyFileSync(apkPath, tmp);
  try { return fn(tmp); } finally { try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ } }
}

function aaptBadging(apkPath) {
  const r = withAsciiCopy(apkPath, (p) => run(AAPT, ["dump", "badging", p]));
  if (r.status !== 0) { fail("aapt 无法读取 APK：" + (r.stderr || r.stdout).slice(0, 200)); }
  const out = r.stdout;
  const pkg = /^package: name='([^']*)' versionCode='(\d+)' versionName='([^']*)'/m.exec(out);
  const label = /^application-label:'([^']*)'/m.exec(out);
  return {
    packageName: pkg ? pkg[1] : null,
    versionCode: pkg ? Number(pkg[2]) : null,
    versionName: pkg ? pkg[3] : null,
    label: label ? label[1] : null
  };
}

function signerSha256(apkPath) {
  const r = withAsciiCopy(apkPath, (p) => run(APKSIGNER, ["verify", "--print-certs", p]));
  if (r.status !== 0) { fail("apksigner 无法读取 APK：" + (r.stderr || r.stdout).slice(0, 200)); }
  const m = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(r.stdout + r.stderr);
  return m ? m[1].toLowerCase() : null;
}

/* 原子写：tmp → rename。Windows 上目标正被读取（如手机经 Tunnel 下载中）会
   EPERM：短暂退避重试几次，仍失败则清理 tmp 并抛错（上一版更新保持可用）。 */
function writeAtomic(target, data) {
  const tmp = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM") { break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  throw lastErr || new Error("rename failed");
}

function main() {
  const args = parseArgs(process.argv);
  console.log("== MSQ DEV 更新发布 ==");

  /* 1) 下一 versionCode：显式指定 > max(现有 latest.json, 现有 DEV APK) + 1 */
  let prevCode = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(LATEST_JSON, "utf8"));
    if (prev && typeof prev.versionCode === "number") { prevCode = prev.versionCode; }
  } catch (e) { /* 无上一版 */ }
  if (fs.existsSync(DEV_APK)) {
    const prevApk = aaptBadging(DEV_APK);
    if (prevApk.versionCode && prevApk.versionCode > prevCode) { prevCode = prevApk.versionCode; }
  }
  const versionCode = args.versionCode || (prevCode + 1);
  if (!(Number.isInteger(versionCode) && versionCode > 0)) { fail("versionCode 无效"); }
  const versionNameBase = args.versionName || ("1.0." + versionCode);
  const versionName = versionNameBase + "-dev";
  console.log("目标版本：versionCode=" + versionCode + " versionName=" + versionName);

  /* 2) cap sync + 构建 */
  if (!args.skipSync) {
    console.log("→ npx cap sync android");
    const s = run("npx.cmd", ["cap", "sync", "android"], ROOT);
    if (s.status !== 0) { fail("cap sync 失败：" + (s.stderr || s.stdout).slice(0, 300)); }
  }
  const writeToken = loadSampleWriteToken();
  if (writeToken.length < 64) {
    fail("sample write secret missing —— 拒绝发布无法认证上传的 APK" +
      "（运行 node tools/sample_auth/init_secret.js 生成）");
  }
  console.log("→ gradlew :app:assembleDev（样本写接口 token 已注入构建，值不打印）");
  const g = run(GRADLEW, [":app:assembleDev",
    "-PDEV_VERSION_CODE=" + versionCode,
    "-PDEV_VERSION_NAME=" + versionNameBase,
    "-PMSQ_SAMPLE_WRITE_TOKEN=" + writeToken], ANDROID);
  if (g.status !== 0) { fail("构建失败：" + (g.stderr || g.stdout).slice(-600)); }
  if (!fs.existsSync(OUT_APK)) { fail("构建产物缺失：" + OUT_APK); }

  /* 3) 实测校验构建产物（不信文件名） */
  const info = aaptBadging(OUT_APK);
  console.log("构建产物：", JSON.stringify(info));
  if (info.packageName !== EXPECTED_PACKAGE) { fail("packageName 不符：" + info.packageName); }
  if (info.versionCode !== versionCode) { fail("versionCode 不符：" + info.versionCode); }
  if (info.versionName !== versionName) { fail("versionName 不符：" + info.versionName); }
  if (info.label !== EXPECTED_LABEL) { fail("app label 不符：" + info.label); }

  /* 4) 签名证书与现有 DEV APK 一致性 */
  const newSigner = signerSha256(OUT_APK);
  if (!newSigner) { fail("无法读取新 APK 签名证书"); }
  let baselineSigner = null;
  if (fs.existsSync(DEV_APK)) {
    baselineSigner = signerSha256(DEV_APK);
  }
  if (baselineSigner && baselineSigner !== newSigner && !args.allowNewSigner) {
    fail("签名证书与现有 DEV APK 不一致（old=" + baselineSigner + " new=" + newSigner +
      "）。禁止发布，否则手机无法覆盖安装。如确需换签请加 --allow-new-signer。");
  }
  console.log("签名证书 SHA-256：" + newSigner + (baselineSigner ? "（与上一版一致）" : "（作为基准记录）"));

  /* 5) SHA256 / size */
  const apkBytes = fs.readFileSync(OUT_APK);
  const sha256 = crypto.createHash("sha256").update(apkBytes).digest("hex");
  const size = apkBytes.length;

  /* 6) 原子发布：先 APK，最后 latest.json */
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  writeAtomic(UPDATES_APK, apkBytes);
  const manifest = {
    schemaVersion: 1,
    channel: "dev",
    packageName: EXPECTED_PACKAGE,
    versionCode: versionCode,
    versionName: versionName,
    apkUrl: "/api/update/dev/apk",
    sha256: sha256,
    size: size,
    publishedAt: new Date().toISOString(),
    notes: args.notes || ""
  };
  writeAtomic(LATEST_JSON, JSON.stringify(manifest, null, 2));
  writeAtomic(DEV_APK, apkBytes);

  console.log("\n== 发布完成 ==");
  console.log("latest.json :", LATEST_JSON);
  console.log("updates APK :", UPDATES_APK);
  console.log("DEV APK     :", DEV_APK);
  console.log("versionCode :", versionCode);
  console.log("versionName :", versionName);
  console.log("size        :", size);
  console.log("sha256      :", sha256);
  console.log("signer      :", newSigner);
}

main();
