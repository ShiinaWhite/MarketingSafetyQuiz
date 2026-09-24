#!/usr/bin/env node
/* test_publish_r2.js —— DEV APK R2 发布流程自检（R2_FAST_TRANSFER_V1）
   运行: node tools/dev_update/test_publish_r2.js   （退出码 0 = 全部通过）

   覆盖任务书要求：
     R2-A1 publish APK object key 带 vc
     R2-A2 latest apkUrl 指向 download.shiinalab.top
     R2-A3 current DEV 能解析 absolute apkUrl（用真实 vc9 APK 内的 updater.js 验证）
     R2-A4 publishing R2 failure → latest 不变
     R2-A5 old APK prune 不删除 current latest

   全程写入 os.tmpdir() 随机目录，绝不触碰真实 release/ 与 R2。 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const r2 = require("../r2/r2.js");
const r2publish = require("./r2_publish.js");
const publish = require("./publish.js");
const { createMockS3, createPublicDomainProxy } = require("../r2/mock_s3.js");

const ROOT = path.resolve(__dirname, "..", "..");
const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

const DOWNLOAD_BUCKET = "marketing-safety-quiz-downloads";
const SAMPLE_BUCKET = "marketing-safety-quiz-samples";
const DOMAIN = "download.shiinalab.top";

/* 假 APK：结构无关，只要字节确定（发布逻辑只做字节搬运与哈希） */
function fakeApk(seed, size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) { buf[i] = (seed * 31 + i * 7) & 0xFF; }
  return buf;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-publish-test-"));
  let mock = null, proxy = null;

  try {
    mock = createMockS3({
      accessKeyId: "AKIAPUB" + crypto.randomBytes(6).toString("hex").toUpperCase(),
      secretAccessKey: crypto.randomBytes(32).toString("hex"),
      buckets: {
        [DOWNLOAD_BUCKET]: { publicRead: true },
        [SAMPLE_BUCKET]: { publicRead: false }
      }
    });
    const mockPort = await mock.listen();
    proxy = createPublicDomainProxy(mock, DOWNLOAD_BUCKET, { cacheStatus: "HIT" });
    const proxyPort = await proxy.listen();
    /* 用 http://127.0.0.1:PORT 冒充 download.shiinalab.top 的公网面 */
    const testDomain = "http://127.0.0.1:" + proxyPort;

    const config = {
      accountId: "testacct",
      accessKeyId: mock.creds.accessKeyId,
      secretAccessKey: mock.creds.secretAccessKey,
      downloadBucket: DOWNLOAD_BUCKET,
      sampleBucket: SAMPLE_BUCKET,
      endpoint: "http://127.0.0.1:" + mockPort
    };
    const client = {
      putObject: r2.putObject, headObject: r2.headObject,
      deleteObject: r2.deleteObject, listAllObjects: r2.listAllObjects
    };
    const paths = {
      updatesDir: path.join(tmp, "updates", "dev"),
      updatesApk: path.join(tmp, "updates", "dev", "营销安规刷题-DEV.apk"),
      latestJson: path.join(tmp, "updates", "dev", "latest.json"),
      devApk: path.join(tmp, "release", "营销安规刷题-DEV.apk")
    };
    fs.mkdirSync(paths.updatesDir, { recursive: true });

    /* ================= R2-A1: object key 带 vc ================= */
    section("R2-A1 publish APK object key 带 versionCode");
    check("R2-A1a vc10 key 含 vc10 且文件名含 vc10",
      r2publish.apkObjectKey(10) === "apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk",
      r2publish.apkObjectKey(10));
    check("R2-A1b 不同 vc 得到不同 key（内容不可变、URL 不复用）",
      r2publish.apkObjectKey(10) !== r2publish.apkObjectKey(11));
    check("R2-A1c key 不含会覆盖的固定名 app.apk/latest.apk/update.apk",
      !/(^|\/)(app|latest|update)\.apk$/.test(r2publish.apkObjectKey(10)));
    check("R2-A1d publish.js 使用的 key 生成器与之一致",
      publish.apkObjectKey(10) === r2publish.apkObjectKey(10));

    /* ================= R2-A2: apkUrl 指向 download.shiinalab.top ================= */
    section("R2-A2 latest apkUrl 指向 R2 Custom Domain");
    const url10 = r2publish.apkPublicUrl(DOMAIN, 10);
    check("R2-A2a URL host = download.shiinalab.top",
      url10 === "https://download.shiinalab.top/apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk",
      url10);
    check("R2-A2b 默认域名常量为 download.shiinalab.top",
      r2publish.DEFAULT_DOMAIN === "download.shiinalab.top", r2publish.DEFAULT_DOMAIN);
    check("R2-A2c publish.js 默认域名为 download.shiinalab.top",
      publish.DOWNLOAD_DOMAIN === "download.shiinalab.top", publish.DOWNLOAD_DOMAIN);
    check("R2-A2d apkUrl 是绝对 http(s)（不再依赖相对路径）",
      /^https:\/\//.test(url10));
    check("R2-A2e 不再出现 /api/update/dev/apk 作为新版本默认下载路径",
      fs.readFileSync(path.join(__dirname, "publish.js"), "utf8")
        .indexOf('apkUrl: "/api/update/dev/apk"') < 0);

    /* ================= 真实发布一次（成功路径） ================= */
    section("发布成功路径：上传 → HeadObject → 公网冒烟 → 写 latest → prune");
    /* 3MB 假 APK：明显大于 1MB 冒烟窗口，才能证明「没整包下载」 */
    const apkBytes = fakeApk(3, 3 * 1024 * 1024);
    const sha256 = r2publish.sha256Hex(apkBytes);
    const rel = await publish.releaseApk({
      config: config, domain: testDomain, versionCode: 10, versionName: "1.0.10-dev",
      packageName: publish.EXPECTED_PACKAGE, apkBytes: apkBytes, sha256: sha256,
      notes: "R2 test release", keepCount: 3, prevCode: 9, paths: paths,
      client: client, pruneClient: client, log: function () { }
    });
    check("发布返回 ok", rel.ok === true, rel.error || "");
    check("latest.json 已写入", fs.existsSync(paths.latestJson));
    const manifest = JSON.parse(fs.readFileSync(paths.latestJson, "utf8"));
    check("latest apkUrl 指向测试公网域",
      manifest.apkUrl === testDomain + "/" + r2publish.apkObjectKey(10), manifest.apkUrl);
    check("latest sha256/size 正确",
      manifest.sha256 === sha256 && manifest.size === apkBytes.length);
    check("latest versionCode=10 / versionName=1.0.10-dev",
      manifest.versionCode === 10 && manifest.versionName === "1.0.10-dev");
    check("对象确实在 downloads bucket",
      mock.has(DOWNLOAD_BUCKET, r2publish.apkObjectKey(10)));
    const obj = mock.get(DOWNLOAD_BUCKET, r2publish.apkObjectKey(10));
    check("对象字节与本地 APK 一致", Buffer.compare(obj.body, apkBytes) === 0);
    check("对象 Cache-Control 为 immutable 长缓存",
      obj.cacheControl === "public, max-age=31536000, immutable", obj.cacheControl);
    check("对象 Content-Type 为 Android 包类型",
      obj.contentType === "application/vnd.android.package-archive", obj.contentType);
    check("对象 metadata 含 sha256/versionCode/versionName/packageName",
      obj.metadata.sha256 === sha256 &&
      String(obj.metadata.versioncode) === "10" &&
      obj.metadata.versionname === "1.0.10-dev" &&
      obj.metadata.packagename === publish.EXPECTED_PACKAGE,
      JSON.stringify(obj.metadata));

    /* ================= 发布验证未整包下载 ================= */
    section("发布验证不重新下载完整 APK");
    const getCalls = proxy.seen.filter((c) => c.method === "GET");
    const headCalls = proxy.seen.filter((c) => c.method === "HEAD");
    check("公网侧只发生 HEAD + 一次小 Range GET",
      headCalls.length >= 1 && getCalls.length >= 1,
      "HEAD=" + headCalls.length + " GET=" + getCalls.length);
    check("公网 GET 带 Range（不是整包拉取）",
      getCalls.every((c) => !!c.range), JSON.stringify(getCalls.map((c) => c.range)));
    check("验证读取字节数 < 对象大小（未整包下载）",
      rel.pub.domain.checkedBytes <= r2publish.SMOKE_RANGE_BYTES &&
      rel.pub.domain.checkedBytes < apkBytes.length,
      rel.pub.domain.checkedBytes + " < " + apkBytes.length);
    check("验证方式声明为 HeadObject + 轻量冒烟",
      /HeadObject/.test(rel.pub.verificationMethod) &&
      /未整包下载/.test(rel.pub.verificationMethod), rel.pub.verificationMethod);

    /* ================= R2-A4: R2 失败 → latest 不变 ================= */
    section("R2-A4 R2 发布失败 → latest 不变（仍指向旧版本）");
    const beforeManifest = fs.readFileSync(paths.latestJson, "utf8");
    /* (a) 上传阶段失败：PUT 恒失败 */
    const failingPut = {
      putObject: async function () { return { ok: false, status: 500, error: "InjectedFailure" }; },
      headObject: client.headObject, deleteObject: client.deleteObject,
      listAllObjects: client.listAllObjects
    };
    let bad = await publish.releaseApk({
      config: config, domain: testDomain, versionCode: 11, versionName: "1.0.11-dev",
      packageName: publish.EXPECTED_PACKAGE, apkBytes: fakeApk(4, 1024),
      sha256: r2publish.sha256Hex(fakeApk(4, 1024)),
      keepCount: 3, prevCode: 10, paths: paths, client: failingPut, pruneClient: client,
      log: function () { }
    });
    check("R2-A4a PUT 失败 → ok:false stage=put",
      bad.ok === false && bad.stage === "put", bad.stage + " / " + bad.error);
    check("R2-A4b PUT 失败 → 未写 latest", bad.wroteManifest === false);
    check("R2-A4c latest.json 字节未变",
      fs.readFileSync(paths.latestJson, "utf8") === beforeManifest);
    check("R2-A4d latest 仍指向 vc10",
      JSON.parse(fs.readFileSync(paths.latestJson, "utf8")).versionCode === 10);

    /* (b) HeadObject 校验失败：R2 报告的 size 与本地不符 */
    const lyingHead = {
      putObject: client.putObject,
      headObject: async function () { return { ok: true, status: 200, size: 999999, metadata: {} }; },
      deleteObject: client.deleteObject, listAllObjects: client.listAllObjects
    };
    bad = await publish.releaseApk({
      config: config, domain: testDomain, versionCode: 12, versionName: "1.0.12-dev",
      packageName: publish.EXPECTED_PACKAGE, apkBytes: fakeApk(5, 2048),
      sha256: r2publish.sha256Hex(fakeApk(5, 2048)),
      keepCount: 3, prevCode: 10, paths: paths, client: lyingHead, pruneClient: client,
      log: function () { }
    });
    check("R2-A4e HeadObject size 不符 → ok:false stage=head",
      bad.ok === false && bad.stage === "head", bad.stage + " / " + bad.error);
    check("R2-A4f latest.json 仍未变",
      fs.readFileSync(paths.latestJson, "utf8") === beforeManifest);

    /* (b2) 声明 sha 与真实字节不符 → 网络请求之前就拒绝 */
    const mismatchBody = fakeApk(9, 4096);
    bad = await publish.releaseApk({
      config: config, domain: testDomain, versionCode: 16, versionName: "1.0.16-dev",
      packageName: publish.EXPECTED_PACKAGE, apkBytes: mismatchBody,
      sha256: "d".repeat(64),
      keepCount: 3, prevCode: 10, paths: paths, client: client, pruneClient: client,
      log: function () { }
    });
    check("R2-A4b2 声明 sha 与 APK 字节不符 → 拒绝（stage=precheck）",
      bad.ok === false && bad.stage === "precheck", bad.stage + " / " + bad.error);
    check("R2-A4b3 未把不符的 APK 传上 R2",
      !mock.has(DOWNLOAD_BUCKET, r2publish.apkObjectKey(16)));
    check("R2-A4b4 latest.json 仍未变",
      fs.readFileSync(paths.latestJson, "utf8") === beforeManifest);

    /* (c) Custom Domain 冒烟失败：公网拿不到对象 */
    const emptyProxy = createPublicDomainProxy(mock, SAMPLE_BUCKET);   /* 私有 bucket：对象不存在 */
    const emptyPort = await emptyProxy.listen();
    bad = await publish.releaseApk({
      config: config, domain: "http://127.0.0.1:" + emptyPort, versionCode: 13,
      versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
      apkBytes: fakeApk(6, 1024), sha256: r2publish.sha256Hex(fakeApk(6, 1024)),
      keepCount: 3, prevCode: 10, paths: paths, client: client, pruneClient: client,
      log: function () { }
    });
    check("R2-A4g 公网冒烟失败 → ok:false stage=domain",
      bad.ok === false && bad.stage === "domain", bad.stage + " / " + bad.error);
    check("R2-A4h latest.json 仍未变（R2 有对象但公网不可达也不放行）",
      fs.readFileSync(paths.latestJson, "utf8") === beforeManifest);
    await emptyProxy.close();

    /* (d) 公网字节与本地不符（模拟 CDN 发错对象）
       stub：PUT 假装成功但不写入（保留已 seed 的错误对象），
             HeadObject 谎报为正确的 size/metadata（让 R2 侧验证通过），
             于是唯一能拦住它的是公网字节比对。 */
    mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(15), Buffer.from("DIFFERENT-BYTES"));
    const mismatchApk = fakeApk(8, 8192);
    const mismatchSha = r2publish.sha256Hex(mismatchApk);
    const noPut = {
      putObject: async function () { return { ok: true, status: 200 }; },
      headObject: async function () {
        return {
          ok: true, status: 200, size: mismatchApk.length, contentType: "application/vnd.android.package-archive",
          cacheControl: r2publish.APK_CACHE_CONTROL,
          metadata: { sha256: mismatchSha, versioncode: "15", packagename: publish.EXPECTED_PACKAGE }
        };
      },
      deleteObject: client.deleteObject, listAllObjects: client.listAllObjects
    };
    bad = await publish.releaseApk({
      config: config, domain: testDomain, versionCode: 15, versionName: "1.0.15-dev",
      packageName: publish.EXPECTED_PACKAGE, apkBytes: mismatchApk, sha256: mismatchSha,
      keepCount: 3, prevCode: 10, paths: paths, client: noPut, pruneClient: client,
      log: function () { }
    });
    check("R2-A4j 公网字节与本地不符 → 拒绝发布（stage=domain）",
      bad.ok === false && bad.stage === "domain", bad.stage + " / " + bad.error);
    check("R2-A4k latest.json 仍未变",
      fs.readFileSync(paths.latestJson, "utf8") === beforeManifest);

    /* ================= R2-A5: prune 不删除 current latest ================= */
    section("R2-A5 prune 保留最新 3 个且绝不删除 current latest");
    /* 先清空 apk/dev/ 让断言确定，再造 6 个版本；
       latest 指向 vc10（不是最大 vc），专门验证「保护 current latest」不靠排序巧合 */
    const existing = await r2.listAllObjects(config, DOWNLOAD_BUCKET, r2publish.APK_PREFIX + "/");
    for (const c of existing.contents) {
      await r2.deleteObject(config, DOWNLOAD_BUCKET, c.key);
    }
    check("A5 前置：apk/dev 已清空",
      (await r2.listAllObjects(config, DOWNLOAD_BUCKET, r2publish.APK_PREFIX + "/")).contents.length === 0);
    for (const vc of [6, 7, 8, 9, 10, 11]) {
      mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(vc), fakeApk(vc, 256));
    }
    const pruned = await r2publish.pruneOldApks({
      client: client, config: config, keepCount: 3, currentVersionCode: 10
    });
    check("prune 执行成功", pruned.ok === true);
    const remaining = r2publish.parseApkVersions(
      (await r2.listAllObjects(config, DOWNLOAD_BUCKET, "apk/dev/")).contents
    ).map((v) => v.versionCode).sort((a, b) => b - a);
    check("A5a 保留最新 3 个 vc（11/10/9）",
      JSON.stringify(remaining) === JSON.stringify([11, 10, 9]), "remaining=" + remaining.join(","));
    check("A5b 更旧的 vc 被删除（8/7/6 不在）",
      remaining.indexOf(8) < 0 && remaining.indexOf(7) < 0 && remaining.indexOf(6) < 0,
      "remaining=" + remaining.join(","));
    check("A5c current latest 的 vc10 从未被删除", mock.has(DOWNLOAD_BUCKET, r2publish.apkObjectKey(10)));
    check("A5d 删除数量 = 总数 - 保留数",
      pruned.deleted.length === pruned.total - pruned.kept.length,
      "total=" + pruned.total + " kept=" + pruned.kept.length + " deleted=" + pruned.deleted.length);
    check("A5e latest.json 未被 prune 触碰（仍指向 vc10）",
      JSON.parse(fs.readFileSync(paths.latestJson, "utf8")).versionCode === 10);

    /* 极端场景：latest 指向最旧版本（长期未更新），prune 必须保护它 */
    section("R2-A5 极端场景：latest 指向最旧 vc 时仍受保护");
    mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(20), fakeApk(20, 128));
    mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(21), fakeApk(21, 128));
    mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(22), fakeApk(22, 128));
    mock.seed(DOWNLOAD_BUCKET, r2publish.apkObjectKey(23), fakeApk(23, 128));
    const pruned2 = await r2publish.pruneOldApks({
      client: client, config: config, keepCount: 3, currentVersionCode: 20
    });
    check("latest 指向的 vc20 被保护（未删除）",
      mock.has(DOWNLOAD_BUCKET, r2publish.apkObjectKey(20)) && pruned2.latestProtected === true);
    check("保护项计入 kept 而非 deleted",
      pruned2.kept.indexOf(r2publish.apkObjectKey(20)) >= 0);

    /* ================= R2-A3: current DEV 能解析 absolute apkUrl ================= */
    section("R2-A3 当前已安装 DEV 能解析 absolute apkUrl");
    /* 用真实 vc9 APK 内的 updater.js 验证（而不是当前工作树） */
    const apkCandidates = [
      path.join(ROOT, "release", "营销安规刷题-DEV.apk")
    ];
    const realApk = apkCandidates.find((p) => fs.existsSync(p));
    if (!realApk) {
      check("R2-A3 找到已安装 DEV APK 用于验证", false, "release/营销安规刷题-DEV.apk 缺失");
    } else {
      const updaterSrc = extractZipEntry(realApk, "assets/public/js/updater.js");
      check("R2-A3a 从真实 DEV APK 取出 updater.js", !!updaterSrc);
      if (updaterSrc) {
        check("R2-A3b updater.js 含绝对 URL 分支（/^https?:\\/\\// 判定）",
          /if \(\/\^https\?:\\\/\\\/\/i\.test\(apkUrl\)\) \{ return apkUrl; \}/.test(updaterSrc) ||
          /test\(apkUrl\)\) \{ return apkUrl/.test(updaterSrc));
        /* 真正执行该函数：在无 DOM 的 Node 环境里求值 updater.js */
        const sandbox = { module: { exports: {} }, self: undefined };
        const fn = new Function("module", "exports", "self",
          updaterSrc + "\nreturn module.exports;");
        const MSQUpdater = fn(sandbox.module, sandbox.module.exports, undefined);
        check("R2-A3c updater.js 可独立求值（无 DOM 依赖）",
          !!(MSQUpdater && typeof MSQUpdater.resolveApkUrl === "function"));
        const absolute = "https://download.shiinalab.top/apk/dev/vc10/MarketingSafetyQuiz-dev-vc10.apk";
        check("R2-A3d absolute apkUrl 原样返回（不走 Tunnel 拼接）",
          MSQUpdater.resolveApkUrl("https://update.shiinalab.top", absolute) === absolute,
          MSQUpdater.resolveApkUrl("https://update.shiinalab.top", absolute));
        check("R2-A3e 旧相对路径仍可解析（向后兼容）",
          MSQUpdater.resolveApkUrl("https://update.shiinalab.top", "/api/update/dev/apk") ===
            "https://update.shiinalab.top/api/update/dev/apk");
        /* 该 APK 的 SHA256 必须与线上 latest.json 一致 → 证明验证的就是已安装版本 */
        const apkSha = r2publish.sha256Hex(fs.readFileSync(realApk));
        check("R2-A3f 本地 DEV APK 即线上 latest 版本（vc9 基线）",
          apkSha === "af0b4b46baf42e400f8a299471058e6ab76f75d933dba65fce093f806f364954",
          apkSha.slice(0, 16) + "…");
      }
    }

    await proxy.close();
    await mock.close();
  } catch (e) {
    console.error("\n[异常] " + (e && e.stack || e));
    fails.push("unexpected exception");
    try { if (proxy) { await proxy.close(); } } catch (e2) { /* 忽略 */ }
    try { if (mock) { await mock.close(); } } catch (e2) { /* 忽略 */ }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
  }

  console.log("\n==============================================");
  if (fails.length) {
    console.log("结果：失败 " + fails.length + " 项");
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
}

/* 最小 ZIP 条目读取（不引入依赖）：只支持 stored/deflate，用于取 APK 内 assets */
function extractZipEntry(zipPath, entryName) {
  const buf = fs.readFileSync(zipPath);
  /* 从尾部找 EOCD */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { return null; }
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { return null; }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) { return data.toString("utf8"); }
      if (method === 8) { return zlib.inflateRawSync(data).toString("utf8"); }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

main();
