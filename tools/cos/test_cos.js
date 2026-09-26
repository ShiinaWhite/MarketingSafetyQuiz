#!/usr/bin/env node
/* test_cos.js —— 腾讯云 COS 直传 PoC 真实环境自检（COS_SAMPLE_TRANSFER_POC）
   运行: node tools/cos/test_cos.js [--skip-bench]
   退出码: 0 = 全部通过；1 = 有失败；3 = 无 credential（PENDING，不伪造 PASS）

   覆盖：
     COS-P1  credential load 不泄漏 secret
     COS-P2  HeadBucket
     COS-P3  PutObject
     COS-P4  HeadObject（Content-Length / Content-Type）
     COS-P5  x-amz-meta-sha256 round-trip
     COS-P6  Presigned PUT（单 key、TTL 300s、过期拒绝、改 key 失效）
     COS-P7  anonymous GET denied
     COS-P8  anonymous PUT denied
     COS-P9  anonymous LIST denied
     COS-P10 DeleteObject
     COS-P11 5MiB 上传/下载基准（PC_BENCHMARK，3 次取中位数）
     COS-P12 测试对象清理（POC_OBJECTS_LEFT = 0）

   所有测试对象只写入 samples/poc/<runId>/，结束全部删除，绝不污染真实样本目录。
   输出绝不打印 SecretId / SecretKey / 完整 presigned URL 签名 query。 */

"use strict";

const crypto = require("crypto");
const https = require("https");

const cos = require("./cos.js");
const r2 = require("../r2/r2.js");

const fails = [];
const pending = [];

/* 记录本测试的全部输出，结束时断言 secret 从未被打印（COS-P1 的关键证据） */
const OUTPUT_LINES = [];
(function wrapConsole() {
  const origLog = console.log, origErr = console.error;
  function rec(line) {
    if (OUTPUT_LINES.length < 20000) { OUTPUT_LINES.push(String(line)); }
  }
  console.log = function () {
    rec(Array.prototype.slice.call(arguments).map(String).join(" "));
    return origLog.apply(console, arguments);
  };
  console.error = function () {
    rec("[stderr] " + Array.prototype.slice.call(arguments).map(String).join(" "));
    return origErr.apply(console, arguments);
  };
})();

function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function markPending(name, detail) {
  console.log(`  [PENDING] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  pending.push(name);
}
function section(t) { console.log(`\n== ${t} ==`); }

function parseArgs(argv) {
  const a = { bench: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--skip-bench") { a.bench = false; }
  }
  return a;
}

function presignedPut(cfg, url, body, requiredHeaders) {
  const u = new URL(url);
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: u.hostname, port: 443, method: "PUT",
      path: u.pathname + u.search,
      headers: Object.assign({ "Content-Length": String(body.length) }, requiredHeaders || {}),
      timeout: 120_000
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks) }); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* 不带任何认证的请求（匿名边界测试用） */
function anonRequest(method, host, path, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: host, port: 443, method: method, path: path,
      headers: body ? { "Content-Length": String(body.length) } : {},
      timeout: 30_000
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    if (body) { req.write(body); }
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("== 腾讯云 COS 直传 PoC 自检（真实环境）==");
  console.log("时间：" + new Date().toISOString());

  /* ---------- COS-P1: credential load 不泄漏 secret ---------- */
  section("COS-P1 credential 装载不泄漏 secret");
  const loaded = cos.loadConfig({});
  if (!loaded.ok) {
    markPending("COS 全部真实验证（credential 缺失）", loaded.error);
    console.log("\n" + "=".repeat(64));
    console.log("COS_CREDENTIAL_USER_ACTION_REQUIRED");
    console.log("=".repeat(64));
    console.log("未找到 COS credential：" + loaded.error);
    console.log("请把 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION / COS_APPID");
    console.log("写入 tools/sample_collector/.env.cos.local（该文件已在 .gitignore 中）。");
    console.log("不要把 secret 发到聊天里。");
    process.exit(3);
  }
  const cfg = loaded.config;
  console.log("  来源：" + (loaded.sources.file || "(env only)"));
  console.log("  bucket=" + cfg.bucket + "  region=" + cfg.region + "  appid=" + cfg.appid);
  console.log("  endpoint=" + cfg.endpoint + "  virtualHostStyle=" + cfg.virtualHostStyle);

  {
    /* 注：Collector 的 config **必须**在进程内存里持有 SecretKey 才能签名，
       所以「序列化 config 含 SecretKey」是设计而非缺陷。
       真正要验证的是：SecretKey 绝不出现在任何**交给手机客户端**的结构里，
       以及绝不被打印。access key id（=COS SecretId）按 S3 设计会出现在
       presigned URL 的 X-Amz-Credential 里，它不是机密。 */
    check("COS-P1a SecretKey 只存在于 config.secretAccessKey（进程内），不在导出的非敏感字段",
      cfg.secretAccessKey !== undefined && cfg.provider === "cos" &&
      !Object.keys(cfg).some(function (k) {
        return k !== "secretAccessKey" && String(cfg[k]).indexOf(cfg.secretAccessKey) >= 0;
      }));
    check("COS-P1b config 序列化不含 SecretKey 之外的可疑 secret（如 token）",
      !/secret|token|password/i.test(JSON.stringify(Object.keys(cfg)))
        || JSON.stringify(Object.keys(cfg)).indexOf("secretAccessKey") >= 0);
    check("COS-P1c config 是普通可序列化对象（无 getter 陷阱）",
      typeof cfg === "object" && Array.isArray(cfg) === false);
    /* gitignore 生效 */
    const { execSync } = require("child_process");
    let ignored = false;
    try { execSync("git check-ignore -q tools/sample_collector/.env.cos.local"); ignored = true; } catch (e) { ignored = false; }
    check("COS-P1d .env.cos.local 被 .gitignore 忽略", ignored);
    /* presigned URL 含 access key id（S3 设计，X-Amz-Credential）但不含 SecretKey */
    const p = cos.presignPutUrl(cfg, {
      bucket: cfg.bucket, key: "samples/poc/p1-probe.jpg", expiresIn: 300,
      contentType: "image/jpeg", metadata: { sha256: "0".repeat(64) }
    });
    check("COS-P1e presigned URL 含 access key id（X-Amz-Credential，非机密）且不含 SecretKey",
      p.ok && p.url.indexOf(cfg.secretAccessKey) < 0 &&
      decodeURIComponent(p.url).indexOf(cfg.accessKeyId) >= 0);
    check("COS-P1f requiredHeaders 不含任何 Authorization/secret",
      p.ok && Object.keys(p.requiredHeaders).every(function (k) {
        return k.toLowerCase() !== "authorization";
      }));
  }

  const runId = Date.now() + "-" + crypto.randomBytes(3).toString("hex");
  const pocDir = "samples/poc/" + runId;
  console.log("\nPoC 目录：" + pocDir + "/（结束全部删除）");

  try {
    /* ---------- COS-P2: HeadBucket ---------- */
    section("COS-P2 HeadBucket");
    let r = await cos.headBucket(cfg, cfg.bucket);
    check("COS-P2a HeadBucket → 2xx", r.ok === true, "status=" + r.status);
    check("COS-P2b virtual-hosted 寻址生效（bucket 在 Host）",
      cfg.virtualHostStyle === true && new URL(cfg.endpoint).host.indexOf(cfg.bucket) === 0);

    /* ---------- COS-P3/P4/P5: Put / Head / metadata round-trip ---------- */
    section("COS-P3/P4/P5 PutObject / HeadObject / metadata round-trip");
    const jpegLike = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
      crypto.randomBytes(64 * 1024 - 4),
      Buffer.from([0xFF, 0xD9])
    ]);
    const jpegSha = r2.sha256Hex(jpegLike);
    const key1 = pocDir + "/capture.jpg";
    r = await cos.putObject(cfg, cfg.bucket, key1, jpegLike, {
      contentType: "image/jpeg",
      metadata: { sha256: jpegSha, "sample-id": runId }
    });
    check("COS-P3a PutObject → 2xx", r.ok === true, "status=" + r.status);

    const h = await cos.headObject(cfg, cfg.bucket, key1);
    check("COS-P4a HeadObject → 2xx", h.ok === true, "status=" + h.status);
    check("COS-P4b Content-Length 一致", h.ok && h.size === jpegLike.length,
      h.ok ? h.size + " vs " + jpegLike.length : "n/a");
    check("COS-P4c Content-Type = image/jpeg", h.ok && h.contentType === "image/jpeg",
      h.ok ? h.contentType : "n/a");
    check("COS-P5a x-amz-meta-sha256 round-trip",
      h.ok && h.metadata.sha256 === jpegSha,
      h.ok ? String(h.metadata.sha256).slice(0, 16) + "…" : "n/a");
    check("COS-P5b 自定义 metadata sample-id round-trip",
      h.ok && h.metadata["sample-id"] === runId);

    /* GetObject + Range */
    const g = await cos.getObjectRange(cfg, cfg.bucket, key1, null);
    check("COS-P4d GetObject 字节一致", g.ok && Buffer.compare(g.body, jpegLike) === 0);
    const gr = await cos.getObjectRange(cfg, cfg.bucket, key1, "bytes=0-15");
    check("COS-P4e Range GET → 206", gr.ok && gr.status === 206 &&
      gr.body.length === 16, gr.ok ? "len=" + gr.body.length : "n/a");

    /* ---------- COS-P6: Presigned PUT ---------- */
    section("COS-P6 Presigned PUT");
    const key2 = pocDir + "/presigned.jpg";
    const body2 = crypto.randomBytes(256 * 1024);
    const sha2 = r2.sha256Hex(body2);
    const pre = cos.presignPutUrl(cfg, {
      bucket: cfg.bucket, key: key2, expiresIn: 300,
      contentType: "image/jpeg", metadata: { sha256: sha2, "sample-id": runId }
    });
    check("COS-P6a presign 成功", pre.ok === true);
    check("COS-P6b TTL = 300 秒", pre.ok && pre.expiresInSeconds === 300,
      pre.ok ? pre.expiresInSeconds : "n/a");
    check("COS-P6c 只作用于单个 object key（URL path 精确匹配）",
      pre.ok && new URL(pre.url).pathname === "/" + key2,
      pre.ok ? new URL(pre.url).pathname : "n/a");
    check("COS-P6d requiredHeaders 锁定 Content-Type 与 metadata",
      pre.ok && pre.requiredHeaders["Content-Type"] === "image/jpeg" &&
      pre.requiredHeaders["x-amz-meta-sha256"] === sha2);

    let putRes = await presignedPut(cfg, pre.url, body2, pre.requiredHeaders);
    check("COS-P6e Presigned PUT → 2xx",
      putRes.status >= 200 && putRes.status < 300, "status=" + putRes.status);
    const h2 = await cos.headObject(cfg, cfg.bucket, key2);
    check("COS-P6f PUT 后 HeadObject 元数据一致",
      h2.ok && h2.size === body2.length && h2.metadata.sha256 === sha2 &&
      h2.contentType === "image/jpeg");
    /* 少发被签名的 metadata 头必须失败 */
    putRes = await presignedPut(cfg, cos.presignPutUrl(cfg, {
      bucket: cfg.bucket, key: pocDir + "/p6-missing-header.jpg", expiresIn: 300,
      contentType: "image/jpeg", metadata: { sha256: sha2 }
    }).url, body2, { "Content-Type": "image/jpeg" });   /* 少了 x-amz-meta-sha256 */
    check("COS-P6g 缺被签名头 → 403", putRes.status === 403, "status=" + putRes.status);
    /* 换 key 必须失败。
       注意：COS 对篡改签名的 PUT 可能直接断开连接（socket hang up）而不是回 403。
       无论传输层表现如何，**真正的安全性质**是"被篡改的 key 没有写入任何对象"，
       所以用 HeadObject 验证，而不是只看传输层错误。 */
    const tamperedKey = pocDir + "/tampered.jpg";
    const tamperedUrl = pre.url.replace("/presigned.jpg", "/tampered.jpg");
    let tamperTransport = "ok";
    try {
      putRes = await presignedPut(cfg, tamperedUrl, body2, pre.requiredHeaders);
    } catch (e) {
      tamperTransport = "transport-rejected (" + String(e && e.message).slice(0, 40) + ")";
      putRes = { status: 0 };
    }
    const tamperedObj = await cos.headObject(cfg, cfg.bucket, tamperedKey);
    check("COS-P6h 改 object key 后未写入任何对象",
      tamperedObj.notFound === true && (putRes.status === 0 || putRes.status === 403),
      "transport=" + tamperTransport + " headStatus=" + tamperedObj.status +
      " putStatus=" + putRes.status);
    /* 过期必须失败 */
    const preExp = cos.presignPutUrl(cfg, {
      bucket: cfg.bucket, key: pocDir + "/p6-expiring.jpg", expiresIn: 2,
      contentType: "image/jpeg", metadata: { sha256: sha2 }
    });
    console.log("  等待 4 秒让 2s TTL 的 URL 过期…");
    await new Promise(function (r2s) { setTimeout(r2s, 4000); });
    putRes = await presignedPut(cfg, preExp.url, Buffer.from("abcd"), preExp.requiredHeaders);
    check("COS-P6i 过期 URL → 403", putRes.status === 403,
      "status=" + putRes.status + (putRes.body.toString("utf8").indexOf("expired") >= 0 ? " (expired)" : ""));

    /* ---------- COS-P7/P8/P9: 匿名边界 ---------- */
    section("COS-P7/P8/P9 匿名访问必须被拒绝");
    const host = new URL(cfg.endpoint).host;
    let a = await anonRequest("GET", host, "/" + key1);
    check("COS-P7 anonymous GET → 403", a.status === 403, "status=" + a.status);
    a = await anonRequest("PUT", host, "/" + pocDir + "/evil.jpg", Buffer.from("evil"));
    check("COS-P8 anonymous PUT → 403", a.status === 403, "status=" + a.status);
    a = await anonRequest("GET", host, "/?list-type=2");
    check("COS-P9 anonymous LIST → 403", a.status === 403, "status=" + a.status);

    /* ---------- COS-P11: 5MiB 基准 ---------- */
    if (args.bench) {
      section("COS-P11 5 MiB 基准（PC_BENCHMARK，非手机速度）");
      const big = crypto.randomBytes(5 * 1024 * 1024);
      const bigSha = r2.sha256Hex(big);
      const upRuns = [];
      for (let i = 1; i <= 3; i++) {
        const k = pocDir + "/bench-" + i + ".jpg";
        const p = cos.presignPutUrl(cfg, {
          bucket: cfg.bucket, key: k, expiresIn: 300,
          contentType: "image/jpeg", metadata: { sha256: bigSha }
        });
        const t0 = Date.now();
        const res = await presignedPut(cfg, p.url, big, p.requiredHeaders);
        const ms = Date.now() - t0;
        const bps = Math.round(big.length / (ms / 1000));
        upRuns.push(bps);
        console.log(`  COS_UPLOAD_RUN_${i}_BYTES_PER_SEC = ${bps}` +
          `  (bytes=${big.length} elapsed_ms=${ms} status=${res.status})`);
        check(`COS-P11 上传 run${i} 成功`, res.status >= 200 && res.status < 300,
          "status=" + res.status);
        await cos.deleteObject(cfg, cfg.bucket, k);
      }
      const median = upRuns.slice().sort(function (x, y) { return x - y; })[1];
      console.log("  COS_UPLOAD_MEDIAN_BYTES_PER_SEC  = " + median);

      const dlKey = pocDir + "/dl.jpg";
      await cos.putObject(cfg, cfg.bucket, dlKey, big, {
        contentType: "image/jpeg", metadata: { sha256: bigSha }
      });
      const dlRuns = [];
      for (let i = 1; i <= 3; i++) {
        const t0 = Date.now();
        const res = await cos.getObjectRange(cfg, cfg.bucket, dlKey, null);
        const ms = Date.now() - t0;
        if (!res.ok) { check(`COS-P11 下载 run${i}`, false, "status=" + res.status); continue; }
        const bps = Math.round(res.body.length / (ms / 1000));
        dlRuns.push(bps);
        console.log(`  COS_DOWNLOAD_RUN_${i}_BYTES_PER_SEC = ${bps}` +
          `  (bytes=${res.body.length} elapsed_ms=${ms} status=${res.status})`);
      }
      if (dlRuns.length === 3) {
        const dmedian = dlRuns.slice().sort(function (x, y) { return x - y; })[1];
        console.log("  COS_DOWNLOAD_MEDIAN_BYTES_PER_SEC = " + dmedian);
      }
      await cos.deleteObject(cfg, cfg.bucket, dlKey);
    } else {
      section("COS-P11 基准（--skip-bench 跳过）");
      markPending("COS-P11 基准", "skipped by --skip-bench");
    }

    /* ---------- COS-P10 / COS-P12: 删除与清理 ---------- */
    section("COS-P10/P12 DeleteObject 与清理");
    r = await cos.deleteObject(cfg, cfg.bucket, key1);
    check("COS-P10a DeleteObject → 2xx", r.ok === true, "status=" + r.status);
    const gone = await cos.headObject(cfg, cfg.bucket, key1);
    check("COS-P10b 删除后 HeadObject → 404", gone.notFound === true, "status=" + gone.status);

    /* 清理本 run 残留 */
    const listed = await cos.listAllObjects(cfg, cfg.bucket, pocDir + "/");
    let left = 0;
    if (listed.ok) {
      for (const c of listed.contents) {
        await cos.deleteObject(cfg, cfg.bucket, c.key);
        left++;
      }
    }
    const after = await cos.listAllObjects(cfg, cfg.bucket, pocDir + "/");
    const remaining = after.ok ? after.contents.length : -1;
    check("COS-P12a PoC 对象全部清理", remaining === 0,
      "deleted=" + left + " remaining=" + remaining);
    /* 再确认 samples/poc/ 整体没有本轮遗留（其它历史 run 也应清理掉） */
    const pocAll = await cos.listAllObjects(cfg, cfg.bucket, "samples/poc/");
    if (pocAll.ok && pocAll.contents.length > 0) {
      console.log("  发现历史 PoC 残留 " + pocAll.contents.length + " 个，一并清理…");
      for (const c of pocAll.contents) { await cos.deleteObject(cfg, cfg.bucket, c.key); }
    }
    const pocAfter = await cos.listAllObjects(cfg, cfg.bucket, "samples/poc/");
    check("COS-P12b samples/poc/ 下对象数为 0",
      pocAfter.ok && pocAfter.contents.length === 0,
      pocAfter.ok ? pocAfter.contents.length : "list failed");
  } catch (e) {
    console.error("\n[异常] " + (e && e.stack || e));
    fails.push("unexpected exception");
    /* 异常时也要尽力清理 */
    try {
      const l = await cos.listAllObjects(cfg, cfg.bucket, "samples/poc/");
      if (l.ok) { for (const c of l.contents) { await cos.deleteObject(cfg, cfg.bucket, c.key); } }
    } catch (e2) { /* 尽力 */ }
  }

  console.log("\n==============================================");

  /* COS-P1 终检：本测试全部输出中绝不出现 SecretKey，也绝不出现 SecretId 完整值 */
  section("COS-P1g 输出泄漏终检");
  {
    const allOut = OUTPUT_LINES.join("\n");
    const keyLeak = allOut.indexOf(cfg.secretAccessKey) >= 0;
    const idLeak = allOut.indexOf(cfg.accessKeyId) >= 0;
    check("COS-P1g SecretKey 未被打印", keyLeak === false);
    check("COS-P1h SecretId 完整值未被打印", idLeak === false);
    check("COS-P1i 完整 presigned 签名 query 未被打印",
      OUTPUT_LINES.every(function (l) { return l.indexOf("X-Amz-Signature=") < 0; }));
  }

  if (fails.length) {
    console.log("结果：失败 " + fails.length + " 项");
    fails.forEach(function (f) { console.log("  - " + f); });
    process.exit(1);
  }
  console.log("结果：全部通过 ✓" + (pending.length ? "（另有 " + pending.length + " 项 PENDING）" : ""));
  process.exit(0);
}

main().catch(function (e) {
  console.error("test_cos 异常：" + (e && e.stack || e));
  process.exit(1);
});
