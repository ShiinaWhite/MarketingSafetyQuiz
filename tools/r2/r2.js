#!/usr/bin/env node
/* r2.js —— Cloudflare R2（S3 兼容）零依赖客户端 + AWS SigV4 签名
   R2_FAST_TRANSFER_V1：大文件数据面从 Cloudflare Tunnel 移到 R2。

   为什么自己实现 SigV4：项目坚持零第三方依赖（见 publish.js / server.js 头注释），
   AWS SDK 体积巨大且会带来传递依赖。这里只实现本任务真正需要的四个动作：
     PutObject / HeadObject / GetObject(Range) / DeleteObject / ListObjectsV2
   外加 Presigned PUT URL 生成。

   endpoint 走 path-style：https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>
   与 Custom Domain（download.shiinalab.top）是两个不同用途：前者用于私有样本的
   临时授权上传，后者只用于公开 APK 下载。

   安全约定：
   - 本模块不打印任何 credential / 完整 presigned URL（含签名 query）
   - presign 只签单个 object key、只允许 PUT、必须带过期时间 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/* R2 的 SigV4 region 固定为 auto（不是具体地域名） */
const REGION = "auto";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/* ---------------- 基础工具 ---------------- */

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/* AWS SigV4 URI 编码：非保留字符原样，其余按 UTF-8 逐字节 %XX。
   encodeSlash=true 用于 query value / 单段；false 用于 path（保留 / 分隔符）。 */
function uriEncode(str, encodeSlash) {
  let out = "";
  for (const ch of String(str)) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "-" || ch === "_" || ch === "." || ch === "~") {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (let i = 0; i < bytes.length; i++) {
        out += "%" + bytes[i].toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

/* SigV4 要求 header 值去掉首尾空白并把连续空白压成单个空格 */
function canonicalHeaderValue(v) {
  return String(v).trim().replace(/\s+/g, " ");
}

function amzDate(now) {
  const d = now || new Date();
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/* ---------------- credential 装载 ----------------
   只从环境变量 / 本机 gitignored 文件读取。绝不硬编码，绝不写入仓库。 */

const R2_ENV_KEYS = [
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "R2_DOWNLOAD_BUCKET", "R2_SAMPLE_BUCKET"
];

/* 解析 KEY=VALUE 形式的 .env（忽略注释/空行；值两侧引号剥除）。
   仅用于本机 secret 文件，不做变量插值。 */
function parseEnvFile(text) {
  const out = {};
  String(text || "").split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s || s.charAt(0) === "#") { return; }
    const eq = s.indexOf("=");
    if (eq <= 0) { return; }
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if (v.length >= 2 && ((v.charAt(0) === '"' && v.endsWith('"')) ||
                          (v.charAt(0) === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    if (k) { out[k] = v; }
  });
  return out;
}

/* 候选 secret 文件（先命中先用）。全部 gitignored。 */
function defaultSecretFiles(root) {
  const base = root || path.resolve(__dirname, "..", "..");
  return [
    path.join(base, "tools", "sample_collector", ".env.r2.local"),
    path.join(base, ".secrets", "r2.env"),
    path.join(base, ".env.r2.local")
  ];
}

/* 装载配置：env 优先，其次 secret 文件。返回 { ok, config, error, sources }。
   缺失字段不猜测、不给默认值——调用方必须显式处理不可用状态。 */
function loadConfig(opts) {
  const o = opts || {};
  const root = o.root || path.resolve(__dirname, "..", "..");
  const fromEnv = {};
  R2_ENV_KEYS.forEach(function (k) {
    const v = (process.env[k] || "").trim();
    if (v) { fromEnv[k] = v; }
  });

  let fileVals = {};
  let fileUsed = null;
  const candidates = o.secretFiles || defaultSecretFiles(root);
  for (const f of candidates) {
    try {
      const text = fs.readFileSync(f, "utf8");
      fileVals = parseEnvFile(text);
      fileUsed = f;
      break;
    } catch (e) { /* 该候选不存在：继续 */ }
  }

  const merged = Object.assign({}, fileVals, fromEnv);
  const missing = R2_ENV_KEYS.filter(function (k) { return !merged[k]; });
  if (missing.length) {
    return {
      ok: false,
      error: "missing R2 config: " + missing.join(", "),
      missing: missing,
      sources: { env: Object.keys(fromEnv), file: fileUsed }
    };
  }

  const accountId = merged.R2_ACCOUNT_ID;
  const endpoint = (o.endpoint || merged.R2_ENDPOINT ||
    ("https://" + accountId + ".r2.cloudflarestorage.com")).replace(/\/+$/, "");

  return {
    ok: true,
    error: null,
    sources: { env: Object.keys(fromEnv), file: fileUsed },
    config: {
      accountId: accountId,
      accessKeyId: merged.R2_ACCESS_KEY_ID,
      secretAccessKey: merged.R2_SECRET_ACCESS_KEY,
      downloadBucket: merged.R2_DOWNLOAD_BUCKET,
      sampleBucket: merged.R2_SAMPLE_BUCKET,
      endpoint: endpoint
    }
  };
}

/* ---------------- 签名 ---------------- */

/* region/service 对 R2 恒为 auto/s3；仅 SigV4 一致性测试用 AWS 官方向量时覆盖。 */
function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region || REGION);
  const kService = hmac(kRegion, service || SERVICE);
  return hmac(kService, "aws4_request");
}

function credentialScope(dateStamp, region, service) {
  return dateStamp + "/" + (region || REGION) + "/" + (service || SERVICE) + "/aws4_request";
}

/* 由 { endpoint, bucket, key, query, headers, method, payloadHash, now } 生成签名头。
   headers 的 key 原样保留（发送时用），签名时统一小写并排序。
   spec.omitContentSha256 仅供 AWS 官方测试向量比对（那些向量不带该头）。 */
function signRequest(spec) {
  const u = new URL(spec.endpoint);
  const host = u.host;
  const key = spec.key === undefined || spec.key === null ? "" : spec.key;
  const canonicalUri = "/" + uriEncode(spec.bucket, false) +
    (key ? "/" + uriEncode(key, false) : "");
  const region = spec.region || REGION;
  const service = spec.service || SERVICE;

  const headers = Object.assign({}, spec.headers || {});
  headers.host = host;
  headers["x-amz-date"] = spec.amzDate;
  if (!spec.omitContentSha256) {
    headers["x-amz-content-sha256"] = spec.payloadHash;
  }

  const lower = {};
  Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = headers[k]; });
  const sortedNames = Object.keys(lower).sort();
  let canonicalHeaders = "";
  sortedNames.forEach(function (n) {
    canonicalHeaders += n + ":" + canonicalHeaderValue(lower[n]) + "\n";
  });
  const signedHeaders = sortedNames.join(";");

  const query = spec.query || {};
  const canonicalQuery = Object.keys(query).sort().map(function (k) {
    return uriEncode(k, true) + "=" + uriEncode(query[k], true);
  }).join("&");

  const canonicalRequest = [
    spec.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    spec.payloadHash
  ].join("\n");

  const scope = credentialScope(spec.dateStamp, region, service);
  const stringToSign = [
    ALGORITHM,
    spec.amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const signature = hmacHex(signingKey(spec.secretAccessKey, spec.dateStamp, region, service),
    stringToSign);
  const authorization = ALGORITHM + " Credential=" + spec.accessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  /* 发送用 header：Authorization 替换掉临时的 host/x-amz-date/x-amz-content-sha256
     （这三个仍需真实发送，host 由 http 模块自动加） */
  const sendHeaders = Object.assign({}, spec.headers || {});
  sendHeaders["x-amz-date"] = spec.amzDate;
  if (!spec.omitContentSha256) {
    sendHeaders["x-amz-content-sha256"] = spec.payloadHash;
  }
  sendHeaders["Authorization"] = authorization;
  delete sendHeaders.host;
  delete sendHeaders.Host;

  return {
    authorization: authorization,
    headers: sendHeaders,
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signature: signature
  };
}

/* ---------------- HTTP 传输 ---------------- */

/* 统一的请求执行：返回 { status, headers, body(Buffer) }。
   body 可选（Buffer）。resolveBody=false 时不缓冲响应体（大对象走流式接口）。 */
function doRequest(spec, body, resolveBody) {
  return new Promise(function (resolve, reject) {
    const u = new URL(spec.endpoint);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      method: spec.method,
      path: spec.path,
      headers: spec.headers,
      /* 大文件上传不要因为 TLS 握手失败而静默重试半个 body */
      agent: false
    }, function (res) {
      if (resolveBody === false) {
        resolve({ status: res.statusCode, headers: res.headers, stream: res, body: null });
        return;
      }
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) { req.write(body); }
    req.end();
  });
}

function requestPath(bucket, key, query) {
  let p = "/" + uriEncode(bucket, false) + (key ? "/" + uriEncode(key, false) : "");
  const q = Object.keys(query || {}).sort().map(function (k) {
    return uriEncode(k, true) + "=" + uriEncode(query[k], true);
  }).join("&");
  return q ? p + "?" + q : p;
}

/* 执行一次已签名请求 */
async function signedFetch(config, opts) {
  const now = opts.now || new Date();
  const stamps = amzDate(now);
  const body = opts.body || null;
  const payloadHash = opts.payloadHash ||
    (body ? sha256Hex(body) : sha256Hex(Buffer.alloc(0)));

  const headers = Object.assign({}, opts.headers || {});
  if (body) { headers["Content-Length"] = String(body.length); }

  const signed = signRequest({
    endpoint: config.endpoint,
    bucket: opts.bucket,
    key: opts.key,
    query: opts.query,
    method: opts.method,
    headers: headers,
    payloadHash: payloadHash,
    amzDate: stamps.amzDate,
    dateStamp: stamps.dateStamp,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: config.service
  });

  const res = await doRequest({
    endpoint: config.endpoint,
    method: opts.method,
    path: requestPath(opts.bucket, opts.key, opts.query),
    headers: signed.headers
  }, body, opts.resolveBody);

  return res;
}

/* ---------------- 对象操作 ---------------- */

function metaHeaders(metadata) {
  const h = {};
  Object.keys(metadata || {}).forEach(function (k) {
    const v = metadata[k];
    if (v === undefined || v === null) { return; }
    h["x-amz-meta-" + String(k).toLowerCase()] = String(v);
  });
  return h;
}

/* HeadObject：存在返回 { ok:true, size, contentType, cacheControl, etag, metadata }；
   404 返回 { ok:false, notFound:true }；其它错误 ok:false 带 status。 */
async function headObject(config, bucket, key, opts) {
  const res = await signedFetch(config, {
    method: "HEAD", bucket: bucket, key: key, now: (opts || {}).now
  });
  if (res.status === 404) { return { ok: false, notFound: true, status: 404 }; }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, notFound: false, status: res.status };
  }
  const metadata = {};
  Object.keys(res.headers).forEach(function (h) {
    const m = /^x-amz-meta-(.+)$/i.exec(h);
    if (m) { metadata[m[1].toLowerCase()] = String(res.headers[h]); }
  });
  return {
    ok: true,
    status: res.status,
    size: Number(res.headers["content-length"] || 0),
    contentType: res.headers["content-type"] || null,
    cacheControl: res.headers["cache-control"] || null,
    etag: res.headers["etag"] || null,
    metadata: metadata
  };
}

/* PutObject。body 为 Buffer。metadata 走 x-amz-meta-*，可在 commit 时用 HeadObject 验证。
   opts.payloadHash 可传入调用方已算好的 body SHA256，避免对 52MB APK 重复哈希。 */
async function putObject(config, bucket, key, body, opts) {
  const o = opts || {};
  const headers = Object.assign({}, metaHeaders(o.metadata));
  if (o.contentType) { headers["Content-Type"] = o.contentType; }
  if (o.cacheControl) { headers["Cache-Control"] = o.cacheControl; }
  if (o.contentDisposition) { headers["Content-Disposition"] = o.contentDisposition; }
  const res = await signedFetch(config, {
    method: "PUT", bucket: bucket, key: key, body: body, headers: headers,
    payloadHash: o.payloadHash, now: o.now
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: s3Error(res) };
  }
  return { ok: true, status: res.status, etag: res.headers["etag"] || null };
}

async function deleteObject(config, bucket, key, opts) {
  const res = await signedFetch(config, {
    method: "DELETE", bucket: bucket, key: key, now: (opts || {}).now
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: s3Error(res) };
  }
  return { ok: true, status: res.status };
}

/* ListObjectsV2（只用于 prune 与镜像扫描，不允许暴露给客户端） */
async function listObjects(config, bucket, prefix, opts) {
  const o = opts || {};
  const query = { "list-type": "2" };
  if (prefix) { query.prefix = prefix; }
  if (o.continuationToken) { query["continuation-token"] = o.continuationToken; }
  if (o.maxKeys) { query["max-keys"] = String(o.maxKeys); }
  const res = await signedFetch(config, {
    method: "GET", bucket: bucket, key: "", query: query, now: o.now
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: s3Error(res) };
  }
  const xml = res.body.toString("utf8");
  const contents = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const chunk = m[1];
    const keyM = /<Key>([\s\S]*?)<\/Key>/.exec(chunk);
    const sizeM = /<Size>([\s\S]*?)<\/Size>/.exec(chunk);
    contents.push({
      key: keyM ? decodeXml(keyM[1]) : null,
      size: sizeM ? Number(sizeM[1]) : 0
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  const nextM = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return {
    ok: true,
    status: res.status,
    contents: contents,
    truncated: truncated,
    nextContinuationToken: nextM ? decodeXml(nextM[1]) : null
  };
}

/* 列出全部对象（自动翻页）。 */
async function listAllObjects(config, bucket, prefix, opts) {
  const out = [];
  let token = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await listObjects(config, bucket, prefix,
      Object.assign({}, opts || {}, { continuationToken: token }));
    if (!page.ok) { return { ok: false, status: page.status, error: page.error, contents: out }; }
    out.push.apply(out, page.contents);
    if (!page.truncated || !page.nextContinuationToken) { break; }
    token = page.nextContinuationToken;
  }
  return { ok: true, contents: out };
}

/* GetObject（可带 Range）：返回 { ok, status, headers, body }。用于发布期轻量 smoke。 */
async function getObjectRange(config, bucket, key, rangeHeader, opts) {
  const headers = {};
  if (rangeHeader) { headers.Range = rangeHeader; }
  const res = await signedFetch(config, {
    method: "GET", bucket: bucket, key: key, headers: headers, now: (opts || {}).now
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: s3Error(res), headers: res.headers };
  }
  return { ok: true, status: res.status, headers: res.headers, body: res.body };
}

/* 流式 GetObject 到文件（镜像用）。调用方负责 tmp → 校验 → rename。 */
function getObjectToFile(config, bucket, key, destPath, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    (async function () {
      const now = o.now || new Date();
      const stamps = amzDate(now);
      const signed = signRequest({
        endpoint: config.endpoint,
        bucket: bucket,
        key: key,
        query: null,
        method: "GET",
        headers: {},
        payloadHash: sha256Hex(Buffer.alloc(0)),
        amzDate: stamps.amzDate,
        dateStamp: stamps.dateStamp,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        service: config.service
      });
      const res = await doRequest({
        endpoint: config.endpoint,
        method: "GET",
        path: requestPath(bucket, key, null),
        headers: signed.headers
      }, null, false);

      if (res.status < 200 || res.status >= 300) {
        res.stream.resume();
        resolve({ ok: false, status: res.status });
        return;
      }
      const out = fs.createWriteStream(destPath);
      const hash = crypto.createHash("sha256");
      let total = 0;
      res.stream.on("data", function (c) { total += c.length; hash.update(c); });
      res.stream.on("error", function (e) { out.destroy(); reject(e); });
      out.on("error", reject);
      out.on("finish", function () {
        resolve({ ok: true, status: res.status, size: total, sha256: hash.digest("hex") });
      });
      res.stream.pipe(out);
    })().catch(reject);
  });
}

/* ---------------- Presigned PUT ----------------
   只授权单个 object key、只允许 PUT、必须带过期时间。
   签名覆盖 host / content-type / 传入的 metadata header：
   客户端必须原样发送 requiredHeaders，否则 R2 返回 SignatureDoesNotMatch。 */

function presignPutUrl(config, spec) {
  const expiresIn = Number(spec.expiresIn || 300);
  if (!(expiresIn > 0 && expiresIn <= 604800)) {
    return { ok: false, error: "expiresIn must be 1..604800 seconds" };
  }
  const now = spec.now || new Date();
  const stamps = amzDate(now);
  const region = config.region || REGION;
  const service = config.service || SERVICE;
  const scope = credentialScope(stamps.dateStamp, region, service);
  const u = new URL(config.endpoint);

  const headers = Object.assign({}, spec.headers || {});
  headers.host = u.host;
  if (spec.contentType) { headers["Content-Type"] = spec.contentType; }
  Object.assign(headers, metaHeaders(spec.metadata));

  const lower = {};
  Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = headers[k]; });
  const signedHeaders = Object.keys(lower).sort().join(";");

  const query = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": config.accessKeyId + "/" + scope,
    "X-Amz-Date": stamps.amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders
  };

  const canonicalUri = "/" + uriEncode(spec.bucket, false) + "/" + uriEncode(spec.key, false);
  const canonicalQuery = Object.keys(query).sort().map(function (k) {
    return uriEncode(k, true) + "=" + uriEncode(query[k], true);
  }).join("&");
  let canonicalHeaders = "";
  Object.keys(lower).sort().forEach(function (n) {
    canonicalHeaders += n + ":" + canonicalHeaderValue(lower[n]) + "\n";
  });

  const canonicalRequest = [
    "PUT", canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD
  ].join("\n");

  const stringToSign = [
    ALGORITHM, stamps.amzDate, scope, sha256Hex(canonicalRequest)
  ].join("\n");

  const signature = hmacHex(signingKey(config.secretAccessKey, stamps.dateStamp, region, service),
    stringToSign);

  const finalQuery = Object.assign({}, query, { "X-Amz-Signature": signature });
  const qs = Object.keys(finalQuery).sort().map(function (k) {
    return uriEncode(k, true) + "=" + uriEncode(finalQuery[k], true);
  }).join("&");

  /* 客户端必须发送的头（不含 host：由 HTTP 栈自动带） */
  const requiredHeaders = {};
  if (spec.contentType) { requiredHeaders["Content-Type"] = spec.contentType; }
  Object.assign(requiredHeaders, metaHeaders(spec.metadata));

  return {
    ok: true,
    url: config.endpoint + canonicalUri + "?" + qs,
    requiredHeaders: requiredHeaders,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    expiresInSeconds: expiresIn,
    signedHeaders: signedHeaders
  };
}

/* ---------------- 错误体 ---------------- */

function s3Error(res) {
  if (!res || !res.body) { return null; }
  const xml = res.body.toString("utf8");
  const codeM = /<Code>([\s\S]*?)<\/Code>/.exec(xml);
  const msgM = /<Message>([\s\S]*?)<\/Message>/.exec(xml);
  if (!codeM && !msgM) { return xml.slice(0, 200) || null; }
  return (codeM ? codeM[1] : "?") + (msgM ? ": " + msgM[1] : "");
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

module.exports = {
  ALGORITHM: ALGORITHM,
  REGION: REGION,
  UNSIGNED_PAYLOAD: UNSIGNED_PAYLOAD,
  R2_ENV_KEYS: R2_ENV_KEYS,
  sha256Hex: sha256Hex,
  uriEncode: uriEncode,
  parseEnvFile: parseEnvFile,
  loadConfig: loadConfig,
  defaultSecretFiles: defaultSecretFiles,
  signRequest: signRequest,
  signingKey: signingKey,
  credentialScope: credentialScope,
  presignPutUrl: presignPutUrl,
  headObject: headObject,
  putObject: putObject,
  deleteObject: deleteObject,
  listObjects: listObjects,
  listAllObjects: listAllObjects,
  getObjectRange: getObjectRange,
  getObjectToFile: getObjectToFile,
  metaHeaders: metaHeaders
};
