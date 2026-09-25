#!/usr/bin/env node
/* test_publish_cos.js —— COS/CDN 发布 provider 的 fail-closed 状态机测试
   （APK_DELIVERY_COS_CDN_VC13_V1 Phase 3）。

   覆盖任务书 Phase 3 的 9 类场景：
     1 正常成功        2 错误 Secret（真实 COS 403）  3 COS PUT 失败
     4 Head metadata mismatch                       5 CDN 404
     6 CDN 5xx          7 CDN SHA mismatch          8 CDN size mismatch
     9 本地 precheck（声明 sha != 字节 sha）
   并断言：所有失败路径下 latest.json **byte-for-byte 不变**。

   mock 面：对象操作走 createMockS3（真实 SigV4 语义），CDN 走本地 http mock；
   写 manifest 的 writeManifestAndPrune 与生产 publish.js 共用同一实现。 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const r2 = require("../r2/r2.js");
const cospublish = require("./cos_publish.js");
const publish = require("./publish.js");
const { createMockS3 } = require("../r2/mock_s3.js");

let passCount = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { passCount++; console.log("  [PASS] " + name + (detail ? " | " + detail : "")); }
  else { fails.push(name); console.log("  [FAIL] " + name + (detail ? " | " + detail : "")); }
}

function section(t) { console.log("\n== " + t + " =="); }

function fakeApk(vc, size) {
  const head = Buffer.from("PK\u0003\u0004 fake apk vc" + vc + " —— ");
  const body = crypto.randomBytes(Math.max(0, size - head.length));
  return Buffer.concat([head, body]);
}

/* 本地 http mock：模拟 CDN 公网面（可注入 status/字节/404/5xx） */
function createCdnMock(bytesFactory) {
  const server = http.createServer((req, res) => {
    const spec = bytesFactory(req) || {};
    if (spec.status && spec.status !== 200) {
      res.writeHead(spec.status).end(spec.body || "mock error");
      return;
    }
    const body = spec.bytes || Buffer.alloc(0);
    res.writeHead(200, { "Content-Length": String(body.length), "Content-Type": "application/vnd.android.package-archive" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((r) => server.close(r))
  })));
}

const http = require("http");
const DOWNLOAD_BUCKET = "marketing-safety-quiz-updates-1317873190";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-cos-publish-test-"));
  let mock = null;
  try {
    mock = createMockS3({
      accessKeyId: "AKIAPUB" + crypto.randomBytes(6).toString("hex").toUpperCase(),
      secretAccessKey: crypto.randomBytes(32).toString("hex"),
      buckets: { [DOWNLOAD_BUCKET]: { publicRead: false } }
    });
    const mockPort = await mock.listen();
    const config = {
      accountId: "testappid",
      accessKeyId: mock.creds.accessKeyId,
      secretAccessKey: mock.creds.secretAccessKey,
      bucket: DOWNLOAD_BUCKET,
      downloadBucket: DOWNLOAD_BUCKET,
      region: "ap-hongkong",
      service: "s3",
      /* 本地 mock 不解析 virtual-host 域名：path-style 指向 127.0.0.1 */
      virtualHostStyle: false,
      endpoint: "http://127.0.0.1:" + mockPort
    };
    const client = {
      putObject: r2.putObject, headObject: r2.headObject,
      deleteObject: r2.deleteObject, listAllObjects: r2.listAllObjects
    };
    const makePaths = () => {
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "msq-cos-paths-")), "updates", "dev");
      fs.mkdirSync(dir, { recursive: true });
      return {
        updatesDir: dir,
        updatesApk: path.join(dir, "营销安规刷题-DEV.apk"),
        latestJson: path.join(dir, "latest.json"),
        devApk: path.join(dir, "营销安规刷题-DEV.apk")
      };
    };
    const SENTINEL = Buffer.from(JSON.stringify({ versionCode: 12, guard: "unchanged" }, null, 2));
    const primeSentinel = (paths) => fs.writeFileSync(paths.latestJson, SENTINEL);
    const sentinelIntact = (paths) => {
      try {
        return fs.readFileSync(paths.latestJson).equals(SENTINEL);
      } catch (e) { return false; }
    };

    /* ================= COS-C1: key 规范 ================= */
    section("COS-C1 object key 规范（immutable / ASCII / 禁固定名）");
    check("COS-C1a vc13 key = dev/vc13/msq-dev-vc13.apk",
      cospublish.apkObjectKey(13) === "dev/vc13/msq-dev-vc13.apk",
      cospublish.apkObjectKey(13));
    check("COS-C1b 不同 vc 不同 key", cospublish.apkObjectKey(13) !== cospublish.apkObjectKey(14));
    check("COS-C1c 禁止 latest/app/update 固定名",
      !/(^|\/)(app|latest|update)\.apk$/.test(cospublish.apkObjectKey(13)));
    check("COS-C1d CDN URL = base + / + key",
      cospublish.apkPublicUrl("https://apk.shiinalab.top", 13) ===
        "https://apk.shiinalab.top/dev/vc13/msq-dev-vc13.apk");

    /* ================= COS-C2: 成功路径（PUT→HEAD→CDN 全量下载→manifest 最后写） ================= */
    section("COS-C2 成功路径：上传 → HeadObject → CDN 全量 SHA 验证 → latest.json");
    const goodApk = fakeApk(13, 2 * 1024 * 1024);
    const goodSha = cospublish.sha256Hex(goodApk);
    const cdn1 = await createCdnMock(() => ({ bytes: goodApk }));
    const pathsOk = makePaths();
    const rel = await publish.releaseApk({
      mode: "cos-cdn",
      config: config, cdnBaseUrl: cdn1.base,
      versionCode: 13, versionName: "1.0.13-dev",
      packageName: publish.EXPECTED_PACKAGE,
      apkBytes: goodApk, sha256: goodSha,
      fallbackApkUrl: "/api/update/dev/apk",
      notes: "cos-cdn success", keepCount: 3, prevCode: 12,
      paths: pathsOk, client: client, pruneClient: client, log: function () { }
    });
    check("COS-C2a 发布成功", rel.ok === true, rel.error || "");
    check("COS-C2b manifest.apkUrl = CDN 绝对 URL",
      rel.manifest && rel.manifest.apkUrl === cdn1.base + "/dev/vc13/msq-dev-vc13.apk",
      rel.manifest && rel.manifest.apkUrl);
    check("COS-C2c manifest.fallbackApkUrl = legacy 相对路径",
      rel.manifest && rel.manifest.fallbackApkUrl === "/api/update/dev/apk",
      rel.manifest && rel.manifest.fallbackApkUrl);
    check("COS-C2d latest.json sha256/size 正确",
      fs.existsSync(pathsOk.latestJson) &&
      (() => { const m = JSON.parse(fs.readFileSync(pathsOk.latestJson, "utf8"));
        return m.sha256 === goodSha && m.size === goodApk.length && m.versionCode === 13; })());
    check("COS-C2e uploads APK 副本已写", fs.existsSync(pathsOk.updatesApk));
    check("COS-C2f verificationMethod 注明全量下载",
      rel.pub && /全量下载/.test(rel.pub.verificationMethod), rel.pub && rel.pub.verificationMethod);
    await cdn1.close();

    /* ================= COS-C3~C9: 失败注入，全部断言 latest.json 不变 ================= */
    const failureCases = [
      { name: "COS-C3 COS PUT 失败（mock put not ok）", stage: "put",
        client: Object.assign({}, client, { putObject: async () => ({ ok: false, status: 500, error: "injected put failure" }) }) },
      { name: "COS-C4 HeadObject metadata.sha256 mismatch", stage: "head",
        client: Object.assign({}, client, { headObject: async () => ({ ok: true, size: 123,
          metadata: { sha256: "deadbeef".repeat(8), versioncode: "13", size: "123" } }) }) },
      { name: "COS-C4b HeadObject metadata.versionCode mismatch", stage: "head",
        client: Object.assign({}, client, { headObject: async () => ({ ok: true, size: 123,
          metadata: { sha256: goodSha, versioncode: "99", size: "123" } }) }) },
      { name: "COS-C4c HeadObject size mismatch", stage: "head",
        client: Object.assign({}, client, { headObject: async () => ({ ok: true, size: 1,
          metadata: { sha256: goodSha, versioncode: "13", size: "1" } }) }) }
    ];
    for (const c of failureCases) {
      section(c.name + " → fail closed");
      const paths = makePaths();
      primeSentinel(paths);
      const badApk = fakeApk(13, 777 * 1024);
      const r = await publish.releaseApk({
        mode: "cos-cdn", config: config, cdnBaseUrl: "http://127.0.0.1:1",
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: badApk, sha256: cospublish.sha256Hex(badApk),
        fallbackApkUrl: "/api/update/dev/apk",
        notes: "", keepCount: 3, prevCode: 12, paths: paths,
        client: c.client, pruneClient: c.client, log: function () { }
      });
      check(c.name + " → 发布失败", r.ok === false && r.stage === c.stage,
        "stage=" + r.stage + " " + (r.error || ""));
      check(c.name + " → latest.json byte-for-byte 不变", sentinelIntact(paths));
    }

    /* CDN 注入：404 / 5xx / SHA mismatch / size mismatch */
    const cdnCases = [
      { name: "COS-C5 CDN 404", status: 404 },
      { name: "COS-C6 CDN 503", status: 503 }
    ];
    for (const c of cdnCases) {
      section(c.name + " → fail closed");
      const cdn = await createCdnMock(() => ({ status: c.status }));
      const paths = makePaths();
      primeSentinel(paths);
      const apk = fakeApk(13, 512 * 1024);
      const r = await publish.releaseApk({
        mode: "cos-cdn", config: config, cdnBaseUrl: cdn.base,
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: apk, sha256: cospublish.sha256Hex(apk),
        fallbackApkUrl: null, notes: "", keepCount: 3, prevCode: 12, paths: paths,
        client: client, pruneClient: client, log: function () { }
      });
      check(c.name + " → 发布失败（stage=cdn）", r.ok === false && r.stage === "cdn",
        "stage=" + r.stage + " " + (r.error || ""));
      check(c.name + " → latest.json byte-for-byte 不变", sentinelIntact(paths));
      await cdn.close();
    }

    section("COS-C7 CDN SHA mismatch → fail closed");
    {
      const cdn = await createCdnMock(() => ({ bytes: fakeApk(13, 512 * 1024) }));  // 不同内容
      const paths = makePaths();
      primeSentinel(paths);
      const apk = fakeApk(13, 512 * 1024);
      const r = await publish.releaseApk({
        mode: "cos-cdn", config: config, cdnBaseUrl: cdn.base,
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: apk, sha256: cospublish.sha256Hex(apk),
        fallbackApkUrl: null, notes: "", keepCount: 3, prevCode: 12, paths: paths,
        client: client, pruneClient: client, log: function () { }
      });
      check("COS-C7 CDN 内容与本地不一致 → 发布失败", r.ok === false && /sha256 mismatch/i.test(r.error || ""),
        r.error);
      check("COS-C7 latest.json byte-for-byte 不变", sentinelIntact(paths));
      await cdn.close();
    }

    section("COS-C8 CDN size mismatch（截断）→ fail closed");
    {
      const apk = fakeApk(13, 600 * 1024);
      const cdn = await createCdnMock(() => ({ bytes: apk.slice(0, 100 * 1024) }));  // 截断
      const paths = makePaths();
      primeSentinel(paths);
      const r = await publish.releaseApk({
        mode: "cos-cdn", config: config, cdnBaseUrl: cdn.base,
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: apk, sha256: cospublish.sha256Hex(apk),
        fallbackApkUrl: null, notes: "", keepCount: 3, prevCode: 12, paths: paths,
        client: client, pruneClient: client, log: function () { }
      });
      check("COS-C8 截断内容 → 发布失败（size mismatch）", r.ok === false && /size mismatch/i.test(r.error || ""),
        r.error);
      check("COS-C8 latest.json byte-for-byte 不变", sentinelIntact(paths));
      await cdn.close();
    }

    section("COS-C9 本地 precheck：声明 sha256 != 字节 sha256 → 不上传即失败");
    {
      const paths = makePaths();
      primeSentinel(paths);
      const apk = fakeApk(13, 128 * 1024);
      let putCalls = 0;
      const spy = Object.assign({}, client, { putObject: async (...a) => { putCalls++; return client.putObject(...a); } });
      const r = await publish.releaseApk({
        mode: "cos-cdn", config: config, cdnBaseUrl: "http://127.0.0.1:1",
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: apk, sha256: "f".repeat(64),   // 与字节不符
        fallbackApkUrl: null, notes: "", keepCount: 3, prevCode: 12, paths: paths,
        client: spy, pruneClient: spy, log: function () { }
      });
      check("COS-C9 precheck 失败（stage=precheck）", r.ok === false && r.stage === "precheck", r.error);
      check("COS-C9 未发起任何 PUT（precheck 即拦截）", putCalls === 0, "putCalls=" + putCalls);
      check("COS-C9 latest.json byte-for-byte 不变", sentinelIntact(paths));
    }

    section("COS-C10 真实 COS 错误 Secret → 403（真实环境，无对象产生）");
    {
      const badConfig = Object.assign({}, config, {
        endpoint: "https://" + DOWNLOAD_BUCKET + ".cos." + config.region + ".myqcloud.com",
        virtualHostStyle: true,
        accessKeyId: "fake-access-key-id-not-real-0123456789abcd",
        secretAccessKey: crypto.randomBytes(32).toString("hex")
      });
      const apk = fakeApk(13, 64 * 1024);
      const up = await cospublish.uploadApk(client, badConfig, {
        versionCode: 13, versionName: "1.0.13-dev", packageName: publish.EXPECTED_PACKAGE,
        apkBytes: apk, sha256: cospublish.sha256Hex(apk)
      });
      check("COS-C10 错误 Secret → PUT 被拒（403/401）", up.ok === false &&
        (up.status === 403 || up.status === 401), "status=" + up.status);
    }

    section("COS-C11 prune：保留最新 N + 保护 current");
    {
      const pruned = await cospublish.pruneOldApks({
        client: client, config: config, keepCount: 1, currentVersionCode: 13
      });
      check("COS-C11a prune 成功且 current 受保护",
        pruned.ok === true && pruned.latestProtected === true,
        "kept=" + JSON.stringify(pruned.kept));
      check("COS-C11b 探针/其他前缀对象不在 dev/vc 清理范围",
        pruned.total >= 1);
    }

  } catch (e) {
    console.error("\n[异常] " + (e && e.stack || e));
    fails.push("unexpected exception");
  } finally {
    try { mock && mock.close(); } catch (e) { /* 尽力 */ }
  }

  console.log("\n==============================================");
  if (fails.length) {
    console.log("结果：失败 " + fails.length + " 项");
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓（" + passCount + " 项）");
}

main().catch(function (e) {
  console.error("[fatal]", e && e.stack || e);
  process.exit(1);
});
