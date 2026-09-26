#!/usr/bin/env node
/* cos.js —— 腾讯云 COS 的 provider-neutral 适配层（COS_SAMPLE_TRANSFER_POC）

   设计目标（任务书第三节）：**复用** tools/r2/r2.js 的 SigV4 / Presigned PUT /
   HeadObject / PutObject / GetObject / DeleteObject / object key 语义，
   不复制第二套 S3 实现。本文件只做两件事：

   1. 读 .env.cos.local（COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION /
      COS_APPID），装配成 r2.js 认识的 config 对象
   2. 把 COS 与 AWS S3 的差异（寻址风格、region/service）表达在 config 里

   与 AWS S3 / R2 的真实差异（实测得出）：
   - **寻址必须 virtual-hosted**：bucket 在 Host 里
     （`<bucket>.cos.<region>.myqcloud.com/<key>`）。COS 对 path-style 直接返回
     PathStyleDomainForbidden —— 这是本轮唯一真正的协议差异。
   - SigV4 的 region 用 COS 地域（ap-beijing 等），service 仍是 "s3"。
   - 其余（presigned PUT、x-amz-meta-*、Content-Type 签名、HeadObject Content-Length、
     过期语义）与 S3 一致，无需改动。

   安全约定：
   - SecretId/SecretKey 只从本机 gitignored 文件或环境变量读取，绝不打印、绝不入库
   - 手机端永远只拿短时 presigned PUT URL，长期 Secret 永不进 APK */

"use strict";

const fs = require("fs");
const path = require("path");
const r2 = require("../r2/r2.js");

const COS_ENV_KEYS = [
  "COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION", "COS_APPID"
];

const DEFAULT_SECRET_FILE = path.join(__dirname, "..", "sample_collector", ".env.cos.local");

function loadCosEnv(opts) {
  const o = opts || {};
  const fromEnv = {};
  COS_ENV_KEYS.forEach(function (k) {
    const v = (process.env[k] || "").trim();
    if (v) { fromEnv[k] = v; }
  });

  let fileVals = {};
  let fileUsed = null;
  const candidates = o.secretFiles || [o.secretFile || DEFAULT_SECRET_FILE];
  for (const f of candidates) {
    if (!f) { continue; }
    try {
      fileVals = r2.parseEnvFile(fs.readFileSync(f, "utf8"));
      fileUsed = f;
      break;
    } catch (e) { /* 候选不存在：继续 */ }
  }

  const merged = Object.assign({}, fileVals, fromEnv);
  const missing = COS_ENV_KEYS.filter(function (k) { return !merged[k]; });
  if (missing.length) {
    return {
      ok: false,
      error: "missing COS config: " + missing.join(", "),
      missing: missing,
      sources: { env: Object.keys(fromEnv), file: fileUsed }
    };
  }
  return { ok: true, error: null, sources: { env: Object.keys(fromEnv), file: fileUsed }, merged: merged };
}

/* 把 COS 配置装配成 r2.js 可直接使用的 config。
   endpoint 用 bucket 级 virtual-hosted host（COS 强制），
   virtualHostStyle=true 让 r2.js 走 /<key> 而不是 /<bucket>/<key>。 */
function buildConfig(merged, overrides) {
  const o = overrides || {};
  const bucket = o.bucket || merged.COS_BUCKET;
  const region = o.region || merged.COS_REGION;
  const virtualHost = o.virtualHost === undefined
    ? (bucket + ".cos." + region + ".myqcloud.com")
    : o.virtualHost;
  return {
    provider: "cos",
    accountId: merged.COS_APPID,
    accessKeyId: merged.COS_SECRET_ID,
    secretAccessKey: merged.COS_SECRET_KEY,
    downloadBucket: bucket,
    sampleBucket: bucket,
    bucket: bucket,
    region: region,
    service: "s3",
    /* COS 强制 virtual-hosted：bucket 在 Host，不在 path */
    virtualHostStyle: true,
    endpoint: ("https://" + virtualHost).replace(/\/+$/, ""),
    host: virtualHost,
    appid: merged.COS_APPID
  };
}

/* 一步装载：env / secret 文件 → r2.js 兼容 config */
function loadConfig(opts) {
  const env = loadCosEnv(opts);
  if (!env.ok) { return env; }
  return { ok: true, error: null, sources: env.sources, config: buildConfig(env.merged, opts) };
}

module.exports = {
  COS_ENV_KEYS: COS_ENV_KEYS,
  DEFAULT_SECRET_FILE: DEFAULT_SECRET_FILE,
  loadCosEnv: loadCosEnv,
  buildConfig: buildConfig,
  loadConfig: loadConfig,
  /* 直接透传 r2.js 的对象操作（provider-neutral 面） */
  headBucket: r2.headBucket,
  putObject: r2.putObject,
  headObject: r2.headObject,
  deleteObject: r2.deleteObject,
  getObjectRange: r2.getObjectRange,
  getObjectToFile: r2.getObjectToFile,
  listAllObjects: r2.listAllObjects,
  presignPutUrl: r2.presignPutUrl,
  sha256Hex: r2.sha256Hex
};
