#!/usr/bin/env node
/* publish.js —— DEV 更新发布工具（SELF_UPDATE_V1 + R2_FAST_TRANSFER_V1）
   零第三方依赖。工作流：
     node tools/dev_update/publish.js [--notes "..."] [--version-code N]
        [--version-name X.Y.Z] [--skip-sync] [--allow-new-signer]
        [--cos-cdn]     (APK_DELIVERY_COS_CDN_VC13_V1: 发布到腾讯 COS
                         私有桶 + CDN 验证，apkUrl=CDN 绝对 URL，附带 fallbackApkUrl)
        [--arm64-only]  (APK_SIZE_OPTIMIZATION_V1: 透传 -PDEV_ARM64_ONLY，
        发布构建仅保留 arm64-v8a；发布前用 aapt native-code 实测核验)
   步骤：确定下一 versionCode → cap sync → assembleDev（-P 注入版本）→
   aapt/apksigner 实测校验（包名/版本/label/签名证书）→ SHA256 →
   上传 APK 到 R2 downloads bucket（key 按 vc 唯一）→ R2 HeadObject 验证 →
   Custom Domain 轻量 HEAD + 前 1MB Range 比对 → 原子发布 latest.json（最后一步）
   → prune 旧 DEV APK（保留最新 3 个，绝不删 current latest）。

   R2_FAST_TRANSFER_V1 关键变化：
   - apkUrl 改为 R2 Custom Domain 的版本化绝对 URL，手机 OTA 不再经过 Tunnel
   - 发布验证**不再重新下载完整 52MB**（那正是之前把 ZCode 卡死的原因）：
     改为 HeadObject（Content-Length + metadata.sha256/versionCode）+ 公网 1MB 冒烟比对
   - 任何 R2 上传/验证失败 → latest.json 保持指向旧版本，绝不出现
     「latest 已指向 vcN 但 vcN APK 不可下载」

   签名/包名/版本校验与以前完全一致：不符合即拒绝发布，保留上一版更新不受影响。 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const r2 = require("../r2/r2.js");
const r2publish = require("./r2_publish.js");
const cospublish = require("./cos_publish.js");

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
/* APK 公网下载域（R2 Custom Domain，不经 Tunnel）。可用环境变量覆盖。 */
const DOWNLOAD_DOMAIN = (process.env.R2_DOWNLOAD_DOMAIN || r2publish.DEFAULT_DOMAIN).trim();
/* DEV APK 保留个数（publish 时 prune，绝不用 30 天无条件 Lifecycle） */
const DEV_APK_KEEP_COUNT = 3;

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
  const a = { notes: "", skipSync: false, allowNewSigner: false, r2: false,
    arm64Only: false, cosCdn: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--notes") { a.notes = argv[++i] || ""; }
    else if (k === "--version-code") { a.versionCode = Number(argv[++i]); }
    else if (k === "--version-name") { a.versionName = argv[++i]; }
    else if (k === "--skip-sync") { a.skipSync = true; }
    else if (k === "--allow-new-signer") { a.allowNewSigner = true; }
    else if (k === "--r2") { a.r2 = true; }
    else if (k === "--arm64-only") { a.arm64Only = true; }
    else if (k === "--cos-cdn") { a.cosCdn = true; }
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

async function main() {
  const args = parseArgs(process.argv);
  console.log("== MSQ DEV 更新发布 ==");

  /* 1) 下一 versionCode：显式指定 > max(现有 latest.json, 现有 DEV APK, R2 已有 vc) + 1 */
  let prevCode = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(LATEST_JSON, "utf8"));
    if (prev && typeof prev.versionCode === "number") { prevCode = prev.versionCode; }
  } catch (e) { /* 无上一版 */ }
  if (fs.existsSync(DEV_APK)) {
    const prevApk = aaptBadging(DEV_APK);
    if (prevApk.versionCode && prevApk.versionCode > prevCode) { prevCode = prevApk.versionCode; }
  }
  /* R2 上已有的 vc 也参与：本地 release/ 被清掉时不会重发同一 vc（内容不可变，重发会失败） */
  if (!args.versionCode) {
    const loadedForVersion = r2.loadConfig({ root: ROOT });
    if (loadedForVersion.ok) {
      try {
        const listed = await r2.listAllObjects(loadedForVersion.config,
          loadedForVersion.config.downloadBucket, r2publish.APK_PREFIX + "/");
        if (listed.ok) {
          const versions = r2publish.parseApkVersions(listed.contents);
          if (versions.length && versions[0].versionCode > prevCode) {
            prevCode = versions[0].versionCode;
            console.log("（R2 已有更高版本 vc" + prevCode + "，据此递增）");
          }
        }
      } catch (e) { /* R2 暂不可达：本地信息足够，后续上传会再校验 */ }
    }
  }
  const versionCode = args.versionCode || (prevCode + 1);
  if (!(Number.isInteger(versionCode) && versionCode > 0)) { fail("versionCode 无效"); }
  const versionNameBase = args.versionName || ("1.0." + versionCode);
  const versionName = versionNameBase + "-dev";
  console.log("目标版本：versionCode=" + versionCode + " versionName=" + versionName);

  /* 2) APK 数据面选择（COS_SAMPLE_TRANSFER_V1 约定）：
     本轮 APK 下载**不走** COS，仍用现有 SELF_UPDATE 链路（Collector 经 Tunnel 提供
     /api/update/dev/apk，apkUrl 保持相对路径）。R2 发布路径保留为可选 --r2，
     只有显式传 --r2 才要求 R2 credential —— R2 不是默认，也不再是阻塞项。 */
  const useR2 = args.r2 === true;
  /* APK_DELIVERY_COS_CDN_VC13_V1：--cos-cdn 数据面（腾讯 COS 私有桶 + CDN）。
     与 --r2 / local 互斥；凭据来自仓库根 .env.cos.updates.local（gitignored）。 */
  const useCosCdn = args.cosCdn === true;
  let cosConfig = null;
  let cosCdnBase = null;
  if (useCosCdn) {
    if (useR2) { fail("--cos-cdn 与 --r2 互斥"); }
    const loaded = cospublish.loadUpdatesConfig({});
    if (!loaded.ok) { fail("cos-cdn 发布需要 .env.cos.updates.local：" + loaded.error); }
    cosConfig = loaded.config;
    cosCdnBase = loaded.cdnBaseUrl;
    console.log("APK 数据面：腾讯 COS 私有桶 + CDN（bucket=" + cosConfig.bucket +
      " region=" + cosConfig.region + " cdn=" + cosCdnBase + "）");
  }
  if (useR2) {
    const loaded = r2.loadConfig({ root: ROOT });
    if (!loaded.ok) {
      fail("指定了 --r2 但未找到 R2 credential（" + loaded.error + "）。\n" +
        "  配置方法：复制 tools/sample_collector/.env.r2.example 为 .env.r2.local 并填入\n" +
        "  R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /\n" +
        "  R2_DOWNLOAD_BUCKET / R2_SAMPLE_BUCKET（该文件已在 .gitignore 中）。\n" +
        "  不加 --r2 则按现状经 Collector/Tunnel 提供 APK（本轮默认）。");
    }
    r2config = loaded.config;
    console.log("APK 数据面：R2 Custom Domain（显式 --r2），bucket=" +
      r2config.downloadBucket + " domain=" + DOWNLOAD_DOMAIN);
  } else {
    console.log("APK 数据面：现有 SELF_UPDATE 链路（Collector/Tunnel，apkUrl 相对路径）");
    console.log("  （样本 capture.jpg 的 COS 直传与 APK 下载是两条独立链路，本轮只动前者）");
  }

  /* 3) cap sync + 构建 */
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
  const gradleArgs = [":app:assembleDev",
    "-PDEV_VERSION_CODE=" + versionCode,
    "-PDEV_VERSION_NAME=" + versionNameBase,
    "-PMSQ_SAMPLE_WRITE_TOKEN=" + writeToken];
  if (args.arm64Only) {
    gradleArgs.push("-PDEV_ARM64_ONLY=1");
    console.log("→ DEV_ARM64_ONLY：本发布仅保留 arm64-v8a");
  }
  console.log("→ gradlew :app:assembleDev（样本写接口 token 已注入构建，值不打印）");
  const g = run(GRADLEW, gradleArgs, ANDROID);
  if (g.status !== 0) { fail("构建失败：" + (g.stderr || g.stdout).slice(-600)); }
  if (!fs.existsSync(OUT_APK)) { fail("构建产物缺失：" + OUT_APK); }

  /* 4) 实测校验构建产物（不信文件名） */
  const info = aaptBadging(OUT_APK);
  console.log("构建产物：", JSON.stringify(info));
  if (info.packageName !== EXPECTED_PACKAGE) { fail("packageName 不符：" + info.packageName); }
  if (info.versionCode !== versionCode) { fail("versionCode 不符：" + info.versionCode); }
  if (info.versionName !== versionName) { fail("versionName 不符：" + info.versionName); }
  if (info.label !== EXPECTED_LABEL) { fail("app label 不符：" + info.label); }
  /* APK_SIZE_OPTIMIZATION_V1：ABI 布局实测核验（aapt native-code，不信构建参数）。
     --arm64-only 时必须恰好 arm64-v8a，否则 30~50MB 级体积回退没人发现 */
  const nativeBadging = withAsciiCopy(OUT_APK, (p) => run(AAPT, ["dump", "badging", p]));
  const nativeCodes = /^native-code: *(.*)$/m.exec(nativeBadging.stdout || "");
  const nativeCodeStr = nativeCodes ? nativeCodes[1] : null;
  if (args.arm64Only && nativeCodeStr !== "'arm64-v8a'") {
    fail("DEV_ARM64_ONLY 核验失败：native-code=" + nativeCodeStr +
      "（期望只有 'arm64-v8a'）。拒绝发布。");
  }
  console.log("native-code：" + nativeCodeStr);

  /* 5) 签名证书与现有 DEV APK 一致性 */
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

  /* 6) SHA256 / size（本地一次算好：既做 payload hash，也写进 R2 metadata） */
  const apkBytes = fs.readFileSync(OUT_APK);
  const sha256 = crypto.createHash("sha256").update(apkBytes).digest("hex");
  const size = apkBytes.length;

  /* 7-9) 原子发布 latest.json（local 默认 / --r2 可选）
     全部顺序保证集中在 releaseApk()（可单测：失败绝不写 latest）。 */
  const rel = await releaseApk({
    mode: useR2 ? "r2" : (useCosCdn ? "cos-cdn" : "local"),
    config: useCosCdn ? cosConfig : r2config,
    domain: DOWNLOAD_DOMAIN,
    cdnBaseUrl: useCosCdn ? cosCdnBase : null,
    fallbackApkUrl: useCosCdn ? "/api/update/dev/apk" : null,
    versionCode: versionCode,
    versionName: versionName,
    packageName: EXPECTED_PACKAGE,
    apkBytes: apkBytes,
    sha256: sha256,
    notes: args.notes || "",
    keepCount: DEV_APK_KEEP_COUNT,
    prevCode: prevCode,
    log: console.log
  });
  if (!rel.ok) {
    fail("APK 发布失败（stage=" + rel.stage + "）：" + rel.error + "\n" +
      "  latest.json 未改动，仍指向上一版本（vc" + prevCode + "）。");
  }

  console.log("\n== 发布完成 ==");
  console.log("latest.json :", LATEST_JSON);
  console.log("updates APK :", UPDATES_APK);
  console.log("DEV APK     :", DEV_APK);
  console.log("versionCode :", versionCode);
  console.log("versionName :", versionName);
  console.log("size        :", size);
  console.log("sha256      :", sha256);
  console.log("signer      :", newSigner);
  if (rel.pub) {
    console.log("apkUrl      :", rel.publicUrl, "（R2 Custom Domain）");
    console.log("objectKey   :", rel.objectKey);
    console.log("cacheControl:", r2publish.APK_CACHE_CONTROL);
  } else {
    console.log("apkUrl      :", rel.publicUrl, "（相对路径，由 Collector 经 Tunnel 提供）");
  }
}

/* ---- 发布核心：APK 先可用，latest.json 最后才更新 ----
   mode="local"（默认）：走现有 SELF_UPDATE 链路，apkUrl 为相对路径
                        /api/update/dev/apk（由 Collector 从本地盘经 Tunnel 提供）。
   mode="r2"          ：上传 R2 + HeadObject + Custom Domain 冒烟，apkUrl 为绝对 URL。
                        只有显式 --r2 才走；任何失败都不写 latest.json。
   client / paths 可注入，便于单测「失败 → latest 不变」。 */
async function releaseApk(opts) {
  const o = opts || {};
  const paths = o.paths || {
    updatesDir: UPDATES_DIR, updatesApk: UPDATES_APK,
    latestJson: LATEST_JSON, devApk: DEV_APK
  };
  const client = o.client || {
    putObject: r2.putObject, headObject: r2.headObject,
    deleteObject: r2.deleteObject, listAllObjects: r2.listAllObjects
  };
  const pruneClient = o.pruneClient || {
    listAllObjects: r2.listAllObjects, deleteObject: r2.deleteObject
  };
  const log = o.log || function () {};
  const useR2 = o.mode === "r2";

  if (o.mode === "cos-cdn") {
    /* COS_PUT → COS_HEAD_VERIFY → CDN_FULL_DOWNLOAD(+SHA/size) 全过才可能走到
       writeManifestAndPrune；任何失败返回 ok:false，latest.json 保持不变 */
    const client = o.client || {
      putObject: r2.putObject, headObject: r2.headObject,
      deleteObject: r2.deleteObject, listAllObjects: r2.listAllObjects
    };
    const pub = await cospublish.publishApk({
      client: client, config: o.config, cdnBaseUrl: o.cdnBaseUrl,
      versionCode: o.versionCode, versionName: o.versionName,
      packageName: o.packageName, apkBytes: o.apkBytes, sha256: o.sha256,
      verifyCdn: o.verifyCdn
    });
    if (!pub.ok) {
      return { ok: false, stage: pub.stage, error: pub.error, wroteManifest: false,
        objectKey: pub.objectKey, publicUrl: pub.publicUrl };
    }
    log("  COS PUT + HeadObject 通过：size=" + pub.uploaded.size +
      " metadata.sha256=" + String(pub.uploaded.metadata.sha256).slice(0, 12) + "…");
    log("  CDN 全量下载验证通过：" + pub.cdn.bytes + " bytes，sha256 一致");
    return await writeManifestAndPrune(o, paths, pruneClient, log, {
      apkUrl: pub.publicUrl, fallbackApkUrl: o.fallbackApkUrl || null,
      objectKey: pub.objectKey, pub: pub, useR2: false
    });
  }

  if (useR2) {
    const objectKey = r2publish.apkObjectKey(o.versionCode);
    log("→ 上传 APK 到 R2：" + o.config.downloadBucket + "/" + objectKey);
    log("  （" + o.apkBytes.length + " bytes，metadata 携带 sha256/versionCode/packageName）");

    const pub = await r2publish.publishApk({
      client: client,
      config: o.config,
      domain: o.domain,
      versionCode: o.versionCode,
      versionName: o.versionName,
      packageName: o.packageName,
      apkBytes: o.apkBytes,
      sha256: o.sha256,
      verifyDomain: o.verifyDomain
    });
    if (!pub.ok) {
      /* 关键：此刻 latest.json 一个字节都还没动 */
      return { ok: false, stage: pub.stage, error: pub.error, wroteManifest: false,
        objectKey: objectKey, publicUrl: pub.publicUrl };
    }
    log("  R2 HeadObject 通过：size=" + pub.uploaded.size +
      " metadata.sha256=" + String(pub.uploaded.metadata.sha256).slice(0, 12) + "…" +
      " metadata.versionCode=" + pub.uploaded.metadata.versioncode);
    log("  Custom Domain 冒烟通过：" + pub.publicUrl);
    log("    HEAD status=" + pub.domain.head.status +
      " contentLength=" + pub.domain.head.contentLength +
      " cacheControl=" + (pub.domain.head.cacheControl || "(none)") +
      " cfCacheStatus=" + (pub.domain.cacheStatus || "(none)"));
    log("    Range 前 " + pub.domain.checkedBytes + " bytes 与本地 APK 逐字节一致" +
      "（status=" + pub.domain.range.status + "）");
    log("  验证方式：" + pub.verificationMethod);
    return await writeManifestAndPrune(o, paths, pruneClient, log, {
      apkUrl: pub.publicUrl, objectKey: pub.objectKey, pub: pub, useR2: true
    });
  }

  /* ---- local 模式：不经 R2，APK 由 Collector 从本地盘经 Tunnel 提供 ---- */
  log("→ 本地发布（现有 SELF_UPDATE 链路）：APK 由 Collector 经 Tunnel 提供");
  log("  apkUrl 保持相对路径 /api/update/dev/apk（手机 OTA 下载不依赖任何对象存储）");
  log("  本轮仅样本 capture.jpg 切到 COS 直传，APK 链路刻意不动");
  return await writeManifestAndPrune(o, paths, pruneClient, log, { useR2: false });
}

/* 原子写 latest.json + 本地 APK 副本 + prune。R2 模式下 PRUNE 也执行；local 模式无 R2 可 prune。 */
async function writeManifestAndPrune(o, paths, pruneClient, log, info) {
  const manifest = {
    schemaVersion: 1,
    channel: "dev",
    packageName: o.packageName,
    versionCode: o.versionCode,
    versionName: o.versionName,
    apkUrl: info.apkUrl || "/api/update/dev/apk",
    fallbackApkUrl: info.fallbackApkUrl || undefined,
    sha256: o.sha256,
    size: o.apkBytes.length,
    publishedAt: new Date().toISOString(),
    notes: o.notes || ""
  };
  fs.mkdirSync(paths.updatesDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.devApk), { recursive: true });
  writeAtomic(paths.updatesApk, o.apkBytes);
  writeAtomic(paths.latestJson, JSON.stringify(manifest, null, 2));
  writeAtomic(paths.devApk, o.apkBytes);

  let pruned = null;
  if (o.mode === "cos-cdn") {
    pruned = await cospublish.pruneOldApks({
      client: pruneClient,
      config: o.config,
      keepCount: o.keepCount,
      currentVersionCode: o.versionCode
    });
    if (!pruned.ok) {
      log("[警告] 旧 APK 清理失败（不影响本次发布）：" + pruned.error);
    } else {
      log("→ COS prune：共 " + pruned.total + " 个，保留 " + pruned.kept.length +
        " 个，删除 " + pruned.deleted.length + " 个（current 已保护）");
    }
  } else if (info.useR2) {
    pruned = await r2publish.pruneOldApks({
      client: pruneClient,
      config: o.config,
      keepCount: o.keepCount,
      currentVersionCode: o.versionCode
    });
    if (!pruned.ok) {
      log("[警告] 旧 APK 清理失败（不影响本次发布）：" + pruned.error);
    } else {
      log("→ APK 保留策略：共 " + pruned.total + " 个，保留 " + pruned.kept.length +
        " 个（keep=" + pruned.keepCount + "，current latest 已保护）");
      pruned.deleted.forEach(function (d) {
        log("    删除 vc" + d.versionCode + "：" + d.key);
      });
      if (pruned.failedToDelete.length) {
        log("    [警告] " + pruned.failedToDelete.length + " 个删除失败，下次发布再试");
      }
    }
  }

  return {
    ok: true, wroteManifest: true, manifest: manifest, pub: info.pub || null,
    pruned: pruned, objectKey: info.objectKey || null,
    publicUrl: info.apkUrl || manifest.apkUrl
  };
}

/* 仅直接执行时跑构建发布；被 require（单测）时只导出纯逻辑。 */
if (require.main === module) {
  main().catch(function (e) {
    fail("未预期错误：" + (e && e.stack || e));
  });
}

module.exports = {
  main: main,
  releaseApk: releaseApk,
  apkObjectKey: r2publish.apkObjectKey,
  apkPublicUrl: r2publish.apkPublicUrl,
  DEV_APK_KEEP_COUNT: DEV_APK_KEEP_COUNT,
  DOWNLOAD_DOMAIN: DOWNLOAD_DOMAIN,
  EXPECTED_PACKAGE: EXPECTED_PACKAGE,
  LATEST_JSON: LATEST_JSON,
  UPDATES_DIR: UPDATES_DIR
};
