#!/usr/bin/env node
/* verify_r2.js —— 真实 R2 连通性 / 安全边界 / 性能实测（R2_FAST_TRANSFER_V1）

   运行：node tools/r2/verify_r2.js [--domain download.shiinalab.top] [--skip-bench]
   需要 tools/sample_collector/.env.r2.local（或环境变量）中的 R2 credential。

   它回答的是「测试夹具证明不了」的问题：
     R2-P1  sample bucket 匿名 GET / LIST 必须被拒绝
     R2-P2  download bucket 的 APK 必须可匿名 GET
     R2_LOCAL_UPLOADS  samples bucket 的 Local Uploads 是否真的 ENABLED
     R2 公开面：samples bucket 不得有 Custom Domain / r2.dev 公开 URL
     真实 presigned PUT → HeadObject → 匿名读拒绝 的完整闭环
     性能：R2 APK 下载速度 / PC 侧 presigned PUT 上传速度

   输出区分 PC_BENCHMARK 与 REAL_DEVICE_PENDING：
   本脚本测的是 PC 网络，不是手机速度；手机实测仍需真机验收。

   绝不打印任何 credential 或完整 presigned URL。 */

"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const path = require("path");

const r2 = require("./r2.js");
const r2publish = require("../dev_update/r2_publish.js");

const ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE_ID = "verify" + Date.now().toString(36);

const results = { pass: [], fail: [], pending: [] };
function ok(name, detail) {
  console.log(`  [OK]   ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  results.pass.push(name);
}
function bad(name, detail) {
  console.log(`  [FAIL] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  results.fail.push(name);
}
function pending(name, detail) {
  console.log(`  [PENDING] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  results.pending.push(name);
}
function section(t) { console.log(`\n== ${t} ==`); }

function parseArgs(argv) {
  const a = { domain: r2publish.DEFAULT_DOMAIN, bench: true, benchMb: 8 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--domain") { a.domain = argv[++i] || a.domain; }
    else if (argv[i] === "--skip-bench") { a.bench = false; }
    else if (argv[i] === "--bench-mb") { a.benchMb = Number(argv[++i]) || 8; }
  }
  return a;
}

/* 匿名 HTTP 请求（不带任何 credential） */
function anonRequest(url, options) {
  const o = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      method: o.method || "GET", path: u.pathname + u.search,
      headers: o.headers || {}, timeout: o.timeoutMs || 30_000, agent: false
    }, function (res) {
      if (o.abortAfterBytes) {
        const chunks = [];
        let total = 0;
        res.on("data", function (c) {
          const room = o.abortAfterBytes - total;
          if (room > 0) {
            chunks.push(room >= c.length ? c : c.slice(0, room));
            total += Math.min(room, c.length);
          }
          if (total >= o.abortAfterBytes) {
            res.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          }
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", function () { if (total < o.abortAfterBytes) { reject(new Error("stream error")); } });
        return;
      }
      const chunks = [];
      let total = 0;
      const started = Date.now();
      res.on("data", function (c) { chunks.push(c); total += c.length; });
      res.on("end", function () {
        resolve({
          status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks), bytes: total,
          seconds: (Date.now() - started) / 1000
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function wrangler(args) {
  const isWin = process.platform === "win32";
  const r = isWin
    ? spawnSync(process.env.ComSpec || "cmd.exe",
        ["/c", "npx", "--yes", "wrangler@4", ...args],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    : spawnSync("npx", ["--yes", "wrangler@4", ...args],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("== R2 真实环境验证与性能实测 ==");
  console.log("时间：" + new Date().toISOString());

  const loaded = r2.loadConfig({ root: ROOT });
  if (!loaded.ok) {
    console.log("\n" + "=".repeat(64));
    console.log("R2_INFRA_USER_ACTION_REQUIRED");
    console.log("=".repeat(64));
    console.log("未找到 R2 credential：" + loaded.error);
    console.log("所有真实 R2 验证与性能实测无法执行（不伪造结果）。");
    console.log("\n请完成：");
    console.log("  1) npx wrangler login");
    console.log("  2) node tools/r2/setup_r2.js --apply --zone-id <ZONE_ID>");
    console.log("  3) Dashboard → R2 → API → Create API Token（Object Read & Write，");
    console.log("     只勾选 downloads 与 samples 两个 bucket）");
    console.log("  4) 写入 tools/sample_collector/.env.r2.local（模板 .env.r2.example）");
    console.log("详细步骤见 tools/r2/setup_r2.md");
    console.log("=".repeat(64));
    results.pending.push("R2 全部真实验证（credential 缺失）");
    printSummary();
    process.exit(2);
  }
  const config = loaded.config;
  console.log("配置来源：" + (loaded.sources.file || "(env only)"));
  console.log("downloads bucket = " + config.downloadBucket);
  console.log("samples   bucket = " + config.sampleBucket);
  console.log("endpoint         = " + config.endpoint);

  /* ---------- 1) 基本连通性与鉴权 ---------- */
  section("1) S3 API 连通性（签名请求）");
  const probeKey = "samples/_verify/" + SAMPLE_ID + "/probe.bin";
  const probeBody = Buffer.from("msq-r2-verify-" + SAMPLE_ID);
  const probeSha = r2.sha256Hex(probeBody);

  let put = await r2.putObject(config, config.sampleBucket, probeKey, probeBody, {
    contentType: "application/octet-stream",
    metadata: { sha256: probeSha, "sample-id": SAMPLE_ID },
    payloadHash: probeSha
  });
  if (put.ok) { ok("PutObject 到私有 samples bucket", "status=" + put.status); }
  else { bad("PutObject 到私有 samples bucket", "status=" + put.status + " " + put.error); }

  let head = await r2.headObject(config, config.sampleBucket, probeKey);
  if (head.ok) {
    ok("HeadObject 读回", "size=" + head.size + " metadata.sha256=" +
      String(head.metadata.sha256 || "").slice(0, 12) + "…");
  } else { bad("HeadObject 读回", "status=" + head.status); }

  if (head.ok && head.metadata.sha256 === probeSha) {
    ok("R2 保留自定义 metadata（commit 可据此免下载校验）");
  } else {
    bad("R2 保留自定义 metadata", JSON.stringify(head.metadata || {}));
  }

  /* ---------- 2) R2-P1 私有边界 ---------- */
  section("2) R2-P1 samples bucket 匿名访问必须被拒绝");
  const s3AnonUrl = config.endpoint + "/" + config.sampleBucket + "/" + probeKey;
  const anonGet = await anonRequest(s3AnonUrl).catch((e) => ({ status: 0, err: e.message }));
  if (anonGet.status === 403) { ok("匿名 GET 对象 → 403"); }
  else if (anonGet.status === 200) { bad("匿名 GET 对象 → 200（bucket 泄漏！）"); }
  else { bad("匿名 GET 对象", "status=" + anonGet.status + " " + (anonGet.err || "")); }

  const anonList = await anonRequest(
    config.endpoint + "/" + config.sampleBucket + "?list-type=2").catch((e) => ({ status: 0, err: e.message }));
  if (anonList.status === 403) { ok("匿名 LIST bucket → 403"); }
  else if (anonList.status === 200) { bad("匿名 LIST bucket → 200（可枚举！）"); }
  else { bad("匿名 LIST bucket", "status=" + anonList.status); }

  const anonPut = await new Promise(function (resolve) {
    const u = new URL(config.endpoint + "/" + config.sampleBucket + "/evil.bin");
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname,
      method: "PUT", headers: { "Content-Length": "3" }, timeout: 20_000
    }, function (res) { res.resume(); resolve({ status: res.statusCode }); });
    req.on("error", (e) => resolve({ status: 0, err: e.message }));
    req.write("abc"); req.end();
  });
  if (anonPut.status === 403) { ok("匿名 PUT → 403"); }
  else if (anonPut.status >= 200 && anonPut.status < 300) { bad("匿名 PUT → 2xx（bucket 可写！）"); }
  else { bad("匿名 PUT", "status=" + anonPut.status); }

  /* ---------- 3) presigned PUT 真实闭环 ---------- */
  section("3) presigned PUT 真实闭环（手机直传路径）");
  const { createR2Store } = require("../sample_collector/r2_store.js");
  const store = createR2Store({ config: config, outRoot: path.join(ROOT, "_local", "r2-verify") });
  const realSampleId = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "_000000_verify";
  const initRes = store.initSample({
    sampleId: realSampleId.replace("_verify", "_000000").slice(0, 21) + "abc123",
    captureSha256: probeSha,
    captureSize: probeBody.length,
    contentType: "image/jpeg"
  });
  if (initRes.ok) {
    ok("init 签发 presigned URL", "expiresAt=" + initRes.expiresAt +
      " ttl=" + initRes.expiresInSeconds + "s objectKey=" + initRes.objectKey);
  } else {
    bad("init 签发 presigned URL", initRes.error);
  }
  if (initRes.ok) {
    const putStarted = Date.now();
    const presignedPut = await new Promise(function (resolve) {
      const u = new URL(initRes.presignedPutUrl);
      const req = https.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method: "PUT",
        headers: Object.assign({ "Content-Length": String(probeBody.length) },
          initRes.requiredHeaders),
        timeout: 60_000
      }, function (res) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("error", (e) => resolve({ status: 0, err: e.message }));
      req.write(probeBody); req.end();
    });
    const putSeconds = (Date.now() - putStarted) / 1000;
    if (presignedPut.status >= 200 && presignedPut.status < 300) {
      ok("presigned PUT 上传成功（真实 R2）", "status=" + presignedPut.status +
        " " + probeBody.length + "B in " + putSeconds.toFixed(2) + "s");
    } else {
      bad("presigned PUT 上传成功", "status=" + presignedPut.status + " " +
        presignedPut.body.toString("utf8").slice(0, 200));
    }
    /* commit 路径的 HeadObject 校验 */
    const vHead = await r2.headObject(config, config.sampleBucket, initRes.objectKey);
    if (vHead.ok && vHead.size === probeBody.length && vHead.metadata.sha256 === probeSha) {
      ok("commit 侧 HeadObject 校验可通过（无需下载 JPEG）",
        "size=" + vHead.size + " sha 一致");
    } else {
      bad("commit 侧 HeadObject 校验", JSON.stringify({
        ok: vHead.ok, size: vHead.size, meta: vHead.metadata
      }));
    }
    /* 上传后的对象同样必须匿名不可读 */
    const anonUploaded = await anonRequest(
      config.endpoint + "/" + config.sampleBucket + "/" + initRes.objectKey)
      .catch((e) => ({ status: 0, err: e.message }));
    if (anonUploaded.status === 403) { ok("刚上传的样本对象匿名 GET → 403"); }
    else { bad("刚上传的样本对象匿名 GET", "status=" + anonUploaded.status); }
    /* 清理验证对象 */
    await r2.deleteObject(config, config.sampleBucket, initRes.objectKey);
  }

  /* ---------- 4) R2 公开面检查 ---------- */
  section("4) samples bucket 不得有任何公开入口");
  const domList = wrangler(["r2", "bucket", "domain", "list", config.sampleBucket]);
  const sampleDomains = domList.out.replace(/\s+/g, " ").trim();
  if (/no custom domains|does not have|0 custom/i.test(sampleDomains) ||
      !/\.(top|com|net|org|dev|io)\b/.test(sampleDomains)) {
    ok("samples bucket 无 Custom Domain");
  } else {
    bad("samples bucket 无 Custom Domain", sampleDomains.slice(0, 160));
  }
  const sampleDevUrl = wrangler(["r2", "bucket", "dev-url", "get", config.sampleBucket]);
  if (/disabled|false/i.test(sampleDevUrl.out) && !/enabled|true/i.test(sampleDevUrl.out)) {
    ok("samples bucket r2.dev 公开 URL 已关闭");
  } else if (/enabled|true/i.test(sampleDevUrl.out)) {
    bad("samples bucket r2.dev 公开 URL 仍开启", sampleDevUrl.out.split("\n")[0]);
  } else {
    pending("samples bucket r2.dev 状态无法判定", sampleDevUrl.out.split("\n").slice(0, 2).join(" | "));
  }

  /* ---------- 5) Local Uploads ---------- */
  section("5) samples bucket Local Uploads");
  const lu = wrangler(["r2", "bucket", "local-uploads", "get", config.sampleBucket]);
  if (/enabled|true/i.test(lu.out) && !/disabled|false/i.test(lu.out)) {
    ok("SAMPLE_R2_LOCAL_UPLOADS = ENABLED");
  } else if (/disabled|false/i.test(lu.out)) {
    bad("SAMPLE_R2_LOCAL_UPLOADS = DISABLED",
      "运行 node tools/r2/setup_r2.js --apply 或 Dashboard → R2 → bucket → Settings → Local Uploads");
  } else {
    pending("SAMPLE_R2_LOCAL_UPLOADS 无法自动判定", lu.out.split("\n").slice(0, 3).join(" | "));
  }

  /* ---------- 6) Lifecycle ---------- */
  section("6) samples bucket Lifecycle（90 天云端缓冲）");
  const lc = wrangler(["r2", "bucket", "lifecycle", "list", config.sampleBucket]);
  if (/samples\/|90/.test(lc.out)) {
    ok("lifecycle 规则存在", lc.out.replace(/\s+/g, " ").slice(0, 140));
  } else {
    pending("lifecycle 规则未确认", lc.out.replace(/\s+/g, " ").slice(0, 140));
  }

  /* ---------- 7) R2-P2 download bucket 公开可读 ---------- */
  section("7) R2-P2 download bucket APK 匿名可读");
  let latest = null;
  try {
    latest = JSON.parse(fs.readFileSync(
      path.join(ROOT, "release", "updates", "dev", "latest.json"), "utf8"));
  } catch (e) { /* 无本地 latest */ }
  if (latest && typeof latest.apkUrl === "string" && /^https:\/\//.test(latest.apkUrl)) {
    const host = new URL(latest.apkUrl).host;
    if (host === args.domain) {
      ok("本地 latest.apkUrl 指向 R2 Custom Domain", latest.apkUrl);
    } else {
      bad("本地 latest.apkUrl 仍指向非 R2 域名", latest.apkUrl);
    }
    const apkHead = await anonRequest(latest.apkUrl, { method: "HEAD" })
      .catch((e) => ({ status: 0, err: e.message }));
    if (apkHead.status === 200) {
      ok("APK 匿名 HEAD → 200", "contentLength=" + apkHead.headers["content-length"] +
        " cacheControl=" + (apkHead.headers["cache-control"] || "(none)") +
        " cfCacheStatus=" + (apkHead.headers["cf-cache-status"] || "(none)") +
        " acceptRanges=" + (apkHead.headers["accept-ranges"] || "(none)"));
      const cc = apkHead.headers["cache-control"] || "";
      if (/immutable/.test(cc) && /max-age=31536000/.test(cc)) {
        ok("APK Cache-Control 为 immutable 长缓存", cc);
      } else {
        bad("APK Cache-Control 非预期", cc || "(none)");
      }
      /* Range 支持 */
      const rng = await anonRequest(latest.apkUrl, {
        headers: { Range: "bytes=0-1023" }, abortAfterBytes: 1024
      }).catch((e) => ({ status: 0, err: e.message }));
      if (rng.status === 206) {
        ok("APK Range GET 支持", "contentRange=" + (rng.headers["content-range"] || "?"));
      } else if (rng.status === 200) {
        pending("APK Range GET 被忽略（返回 200 全量）", "仍可用，但无断点续传");
      } else {
        bad("APK Range GET", "status=" + rng.status);
      }
      /* 第二次请求观察缓存 */
      const again = await anonRequest(latest.apkUrl, { method: "HEAD" })
        .catch((e) => ({ status: 0 }));
      ok("第二次 HEAD 的 CF-Cache-Status",
        again.headers ? (again.headers["cf-cache-status"] || "(none)") : "(none)");
    } else {
      bad("APK 匿名 HEAD", "status=" + apkHead.status + " " + (apkHead.err || ""));
    }
  } else {
    pending("本地无 R2 化 latest.json，跳过 download bucket 公开读验证",
      latest ? latest.apkUrl : "无 release/updates/dev/latest.json");
  }

  /* ---------- 8) 性能实测 ---------- */
  if (args.bench) {
    section("8) 性能实测（PC 网络，非手机速度）");
    console.log("  说明：以下为 PC_BENCHMARK；REAL_DEVICE_* 仍需真机验收。");

    /* 8a) R2 APK 下载速度（限时/限量，绝不整包 52MB） */
    if (latest && /^https:\/\//.test(latest.apkUrl || "")) {
      const targetBytes = Math.max(1, Math.round(args.benchMb)) * 1024 * 1024;
      const started = Date.now();
      const dl = await anonRequest(latest.apkUrl, {
        headers: { Range: "bytes=0-" + (targetBytes - 1) },
        abortAfterBytes: targetBytes
      }).catch((e) => ({ status: 0, err: e.message, bytes: 0 }));
      const secs = (Date.now() - started) / 1000;
      if (dl.bytes > 0) {
        const bps = dl.bytes / Math.max(secs, 0.001);
        console.log("  R2_APK_DOWNLOAD_BYTES_PER_SEC = " + Math.round(bps) +
          "  (" + dl.bytes + "B / " + secs.toFixed(2) + "s, status=" + dl.status + ")");
        results.pass.push("R2_APK_DOWNLOAD_BYTES_PER_SEC=" + Math.round(bps));
      } else {
        console.log("  R2 APK 下载测速失败：" + (dl.err || "status=" + dl.status));
        results.fail.push("R2 APK 下载测速");
      }
    } else {
      console.log("  R2 APK 下载测速：跳过（无 R2 化 latest.json）");
    }

    /* 8b) PC → R2 presigned PUT 上传速度（5MB 测试文件） */
    const testBytes = 5 * 1024 * 1024;
    const testBuf = crypto.randomBytes(testBytes);
    const testSha = r2.sha256Hex(testBuf);
    const benchSampleId = new Date().toISOString().slice(0, 10).replace(/-/g, "") +
      "_000001_" + crypto.randomBytes(3).toString("hex");
    const benchInit = store.initSample({
      sampleId: benchSampleId, captureSha256: testSha,
      captureSize: testBytes, contentType: "image/jpeg"
    });
    if (benchInit.ok) {
      const upStarted = Date.now();
      const upRes = await new Promise(function (resolve) {
        const u = new URL(benchInit.presignedPutUrl);
        const req = https.request({
          hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          method: "PUT",
          headers: Object.assign({ "Content-Length": String(testBytes) }, benchInit.requiredHeaders),
          timeout: 120_000
        }, function (res) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on("error", (e) => resolve({ status: 0, err: e.message }));
        req.write(testBuf); req.end();
      });
      const upSecs = (Date.now() - upStarted) / 1000;
      if (upRes.status >= 200 && upRes.status < 300) {
        const bps = testBytes / Math.max(upSecs, 0.001);
        console.log("  TEST_UPLOAD_BYTES          = " + testBytes);
        console.log("  TEST_UPLOAD_SECONDS        = " + upSecs.toFixed(2));
        console.log("  TEST_UPLOAD_BYTES_PER_SEC  = " + Math.round(bps) +
          "  (PC_R2_SAMPLE_UPLOAD_BYTES_PER_SEC)");
        results.pass.push("PC_R2_SAMPLE_UPLOAD_BYTES_PER_SEC=" + Math.round(bps));
        await r2.deleteObject(config, config.sampleBucket, benchInit.objectKey);
      } else {
        console.log("  presigned PUT 测速失败：status=" + upRes.status + " " +
          (upRes.err || (upRes.body || Buffer.alloc(0)).toString("utf8").slice(0, 200)));
        results.fail.push("presigned PUT 测速");
      }
    } else {
      console.log("  上传测速 init 失败：" + benchInit.error);
      results.fail.push("上传测速 init");
    }
  }

  /* ---------- 清理 ---------- */
  await r2.deleteObject(config, config.sampleBucket, probeKey);

  printSummary();
}

function printSummary() {
  console.log("\n" + "=".repeat(64));
  console.log("PASS=" + results.pass.length + "  FAIL=" + results.fail.length +
    "  PENDING=" + results.pending.length);
  if (results.fail.length) {
    console.log("\n失败项：");
    results.fail.forEach((f) => console.log("  - " + f));
  }
  if (results.pending.length) {
    console.log("\n待定项（需用户操作或真机）：");
    results.pending.forEach((f) => console.log("  - " + f));
  }
  console.log("=".repeat(64));
  process.exit(results.fail.length ? 1 : (results.pending.length ? 3 : 0));
}

main().catch(function (e) {
  console.error("验证脚本异常：" + (e && e.stack || e));
  process.exit(1);
});
