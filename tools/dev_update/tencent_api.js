#!/usr/bin/env node
/* tencent_api.js —— 腾讯云 TC3-HMAC-SHA256 签名 API 调用器（零第三方依赖）。
   APK_CDN_STABILITY_DIAG_V1 专用诊断工具：
     - 只读探测 CDN 域名配置（DescribeDomainsConfig）
     - 可选 URL 预热 PoC（PushUrlsCache / DescribePushTasks）
   凭据只从 .env.cos.updates.local（TENCENT_COS_SECRET_ID/KEY）或环境变量读取，
   绝不打印、绝不入库。任何 AuthFailure 都如实返回，不伪造成功。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const r2 = require("../r2/r2.js");

const UPDATES_ENV_FILE = path.join(__dirname, "..", "..", ".env.cos.updates.local");

function loadCredentials(opts) {
  const o = opts || {};
  let id = (process.env.TENCENT_COS_SECRET_ID || "").trim();
  let key = (process.env.TENCENT_COS_SECRET_KEY || "").trim();
  if (!id || !key) {
    try {
      const vals = r2.parseEnvFile(fs.readFileSync(o.envFile || UPDATES_ENV_FILE, "utf8"));
      id = (vals.TENCENT_COS_SECRET_ID || "").trim();
      key = (vals.TENCENT_COS_SECRET_KEY || "").trim();
    } catch (e) { /* 文件不存在 */ }
  }
  if (!id || !key) { return { ok: false, error: "missing TENCENT_COS_SECRET_ID/KEY" }; }
  return { ok: true, secretId: id, secretKey: key };
}

/* TC3-HMAC-SHA256 签名（腾讯云 API 3.0 规范，GET/POST-JSON 通用） */
function tc3Call(opts) {
  const { secretId, secretKey, service, host, action, version, payload, region } = opts;
  const body = payload === undefined ? "{}" : JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const hashedBody = crypto.createHash("sha256").update(body).digest("hex");

  const canonicalHeaders =
    "content-type:application/json; charset=utf-8\n" +
    "host:" + host + "\n" +
    "x-tc-action:" + action.toLowerCase() + "\n";
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = "POST\n/\n\n" + canonicalHeaders + "\n" +
    signedHeaders + "\n" + hashedBody;

  const scope = date + "/" + service + "/tc3_request";
  const stringToSign = "TC3-HMAC-SHA256\n" + ts + "\n" + scope + "\n" +
    crypto.createHash("sha256").update(canonicalRequest).digest("hex");

  const kDate = crypto.createHmac("sha256", "TC3" + secretKey).update(date).digest();
  const kService = crypto.createHmac("sha256", kDate).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("tc3_request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": version,
    "X-TC-Timestamp": String(ts),
    "X-TC-Region": region || "",
    Authorization: "TC3-HMAC-SHA256 Credential=" + secretId + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature
  };
  if (opts.token) { headers["X-TC-Token"] = opts.token; }

  return fetch("https://" + host + "/", {
    method: "POST",
    headers: headers,
    body: body
  }).then(function (r) {
    return r.text().then(function (t) {
      let parsed = null;
      try { parsed = JSON.parse(t); } catch (e2) { parsed = { raw: t }; }
      return { status: r.status, body: parsed };
    });
  });
}

/* 便捷封装：CDN API（v2018-06-06，全局服务无 region） */
function cdnCall(opts) {
  const creds = loadCredentials(opts);
  if (!creds.ok) { return Promise.resolve({ status: 0, body: { error: creds.error } }); }
  return tc3Call({
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    service: "cdn",
    host: "cdn.tencentcloudapi.com",
    action: opts.action,
    version: "2018-06-06",
    payload: opts.payload || {}
  });
}

module.exports = { loadCredentials: loadCredentials, tc3Call: tc3Call, cdnCall: cdnCall };

/* CLI 用法：
   node tools/dev_update/tencent_api.js describe   只读查询域名配置
   node tools/dev_update/tencent_api.js preheat <url>  提交 URL 预热（PoC）
   node tools/dev_update/tencent_api.js preheat-status <task-id>  查询预热任务 */
if (require.main === module) {
  const cmd = process.argv[2] || "";
  const arg = process.argv[3] || "";
  (async () => {
    if (cmd === "describe") {
      const r = await cdnCall({
        action: "DescribeDomainsConfig",
        payload: { Filters: [{ name: "domain", value: "apk.shiinalab.top" }], Offset: 0, Limit: 1 }
      });
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
    } else if (cmd === "preheat-push" && arg) {
      const r = await cdnCall({ action: "PushUrlsCache", payload: { Urls: [arg] } });
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === "preheat-status" && arg) {
      const r = await cdnCall({ action: "DescribePushTasks", payload: { TaskId: arg } });
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log("usage: describe | preheat-push <url> | preheat-status <task-id>");
    }
  })().catch(function (e) {
    console.error("probe failed:", e && e.message);
    process.exit(1);
  });
}
