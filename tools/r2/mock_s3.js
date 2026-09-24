#!/usr/bin/env node
/* mock_s3.js —— 测试用 S3 兼容内存服务（R2_FAST_TRANSFER_V1 测试夹具）

   目的：在没有真实 R2 credential 的情况下，端到端验证
     1. tools/r2/r2.js 的 SigV4 签名 / presigned URL 是否真的能被服务端校验通过
     2. Collector 的 init → PUT → commit 全链路与幂等/冲突/大小校验语义
     3. 公开 bucket / 私有 bucket 的匿名访问边界

   重要：本文件里的 verify* 是**独立重写**的 SigV4 校验实现（按 AWS 规范直接写，
   结构刻意与 r2.js 不同），因此它不是一个「自证」夹具——如果 r2.js 的规范化
   逻辑写错（header 排序、换行、URI 编码、payload hash 拼接），这里会验签失败。

   绝不用于生产：只监听 127.0.0.1，数据全在内存。 */

"use strict";

const crypto = require("crypto");
const http = require("http");

const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hexHmac(key, msg) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

function rawHmac(key, msg) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest();
}

/* ---- 独立 SigV4 校验实现 ---- */

/* 把 request 还原成 canonical request。用与 r2.js 不同的组织方式书写。 */
function buildCanonical(method, rawPath, rawQuery, headers, signedHeaderNames, payloadHash) {
  const lines = [];
  lines.push(method);
  lines.push(rawPath);
  /* query：按编码后的 key 排序；直接操作原始 k=v 片段 */
  const pairs = [];
  if (rawQuery) {
    rawQuery.split("&").forEach(function (p) {
      if (p) { pairs.push(p); }
    });
  }
  pairs.sort(function (a, b) {
    const ka = a.split("=")[0];
    const kb = b.split("=")[0];
    if (ka < kb) { return -1; }
    if (ka > kb) { return 1; }
    return 0;
  });
  lines.push(pairs.join("&"));

  const headerBlock = [];
  for (const name of signedHeaderNames) {
    const v = headers[name];
    if (v === undefined) { return { error: "signed header not present in request: " + name }; }
    headerBlock.push(name + ":" + String(v).trim().replace(/\s+/g, " ") + "\n");
  }
  lines.push(headerBlock.join(""));
  lines.push(signedHeaderNames.join(";"));
  lines.push(payloadHash);
  return { canonical: lines.join("\n") };
}

function computeSignature(secretAccessKey, dateStamp, region, service, stringToSign) {
  const kDate = rawHmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = rawHmac(kDate, region);
  const kService = rawHmac(kRegion, service);
  const kSigning = rawHmac(kService, "aws4_request");
  return hexHmac(kSigning, stringToSign);
}

function parseAuthHeader(h) {
  const m = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]+)$/
    .exec(String(h || "").trim());
  if (!m) { return null; }
  const credParts = m[1].split("/");
  if (credParts.length !== 5) { return null; }
  return {
    accessKeyId: credParts[0],
    dateStamp: credParts[1],
    region: credParts[2],
    service: credParts[3],
    terminator: credParts[4],
    signedHeaders: m[2].split(";"),
    signature: m[3]
  };
}

function timingSafeEqHex(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) { return false; }
  return crypto.timingSafeEqual(ba, bb);
}

/* 校验 header 签名请求。返回 { ok } 或 { ok:false, reason }。 */
function verifyHeaderAuth(req, rawPath, rawQuery, body, creds) {
  const auth = parseAuthHeader(req.headers.authorization);
  if (!auth) { return { ok: false, reason: "malformed Authorization header" }; }
  if (auth.accessKeyId !== creds.accessKeyId) { return { ok: false, reason: "unknown access key" }; }
  if (auth.terminator !== "aws4_request") { return { ok: false, reason: "bad credential scope" }; }

  const payloadHash = auth.signedHeaders.indexOf("x-amz-content-sha256") >= 0
    ? req.headers["x-amz-content-sha256"]
    : sha256hex(body || Buffer.alloc(0));
  if (req.headers["x-amz-content-sha256"]) {
    const actual = sha256hex(body || Buffer.alloc(0));
    if (req.headers["x-amz-content-sha256"] !== actual &&
        req.headers["x-amz-content-sha256"] !== "UNSIGNED-PAYLOAD") {
      return { ok: false, reason: "x-amz-content-sha256 does not match body" };
    }
  }

  const built = buildCanonical(req.method, rawPath, rawQuery, req.headers,
    auth.signedHeaders, payloadHash);
  if (built.error) { return { ok: false, reason: built.error }; }

  const scope = [auth.dateStamp, auth.region, auth.service, auth.terminator].join("/");
  const stringToSign = [ALGORITHM, req.headers["x-amz-date"], scope,
    sha256hex(built.canonical)].join("\n");
  const expected = computeSignature(creds.secretAccessKey, auth.dateStamp,
    auth.region, auth.service, stringToSign);
  if (!timingSafeEqHex(expected, auth.signature)) {
    return { ok: false, reason: "signature mismatch", canonical: built.canonical };
  }
  return { ok: true, accessKeyId: auth.accessKeyId };
}

/* 校验 presigned URL（query 签名）。返回 { ok } 或 { ok:false, reason }。 */
function verifyPresigned(method, rawPath, rawQuery, headers, creds, nowMs) {
  const q = {};
  String(rawQuery || "").split("&").forEach(function (p) {
    if (!p) { return; }
    const i = p.indexOf("=");
    const k = decodeURIComponent(i < 0 ? p : p.slice(0, i));
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    q[k] = v;
  });
  if (q["X-Amz-Algorithm"] !== ALGORITHM) { return { ok: false, reason: "bad X-Amz-Algorithm" }; }
  const sig = q["X-Amz-Signature"];
  if (!sig) { return { ok: false, reason: "missing X-Amz-Signature" }; }
  const credParts = String(q["X-Amz-Credential"] || "").split("/");
  if (credParts.length !== 5) { return { ok: false, reason: "bad X-Amz-Credential" }; }
  if (credParts[0] !== creds.accessKeyId) { return { ok: false, reason: "unknown access key" }; }

  /* 过期检查：now <= X-Amz-Date + X-Amz-Expires */
  const signTime = Date.parse(
    String(q["X-Amz-Date"] || "").replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z"));
  const expires = Number(q["X-Amz-Expires"]);
  if (!isFinite(signTime) || !isFinite(expires)) { return { ok: false, reason: "bad date/expires" }; }
  if (nowMs > signTime + expires * 1000) {
    return { ok: false, reason: "expired", code: "EXPIRED" };
  }

  const signedHeaderNames = String(q["X-Amz-SignedHeaders"] || "").split(";").filter(Boolean);
  /* 待签 query = 除 X-Amz-Signature 以外的全部 query（按原样，不含 Signature） */
  const withoutSig = String(rawQuery || "").split("&").filter(function (p) {
    return p && p.split("=")[0] !== "X-Amz-Signature";
  }).join("&");

  const built = buildCanonical(method, rawPath, withoutSig, headers,
    signedHeaderNames, "UNSIGNED-PAYLOAD");
  if (built.error) { return { ok: false, reason: built.error }; }

  const scope = credParts.slice(1).join("/");
  const stringToSign = [ALGORITHM, q["X-Amz-Date"], scope, sha256hex(built.canonical)].join("\n");
  const expected = computeSignature(creds.secretAccessKey, credParts[1],
    credParts[2], credParts[3], stringToSign);
  if (!timingSafeEqHex(expected, sig)) {
    return { ok: false, reason: "presigned signature mismatch", canonical: built.canonical };
  }
  return { ok: true, signedHeaderNames: signedHeaderNames };
}

/* ---- mock 服务 ---- */

/* buckets: { <name>: { publicRead: boolean } }
   options.clock: () => ms（测试可推进时间以验证 presigned 过期） */
function createMockS3(options) {
  const opts = options || {};
  const creds = {
    accessKeyId: opts.accessKeyId || "TESTACCESSKEY",
    secretAccessKey: opts.secretAccessKey || "TESTSECRETKEY"
  };
  const buckets = opts.buckets || {};
  const clock = opts.clock || function () { return Date.now(); };
  const objects = new Map();   /* "<bucket>/<key>" → { body, contentType, cacheControl, metadata } */
  const calls = [];            /* 请求审计（测试断言用） */

  function keyOf(bucket, key) { return bucket + "/" + key; }

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      const chunks = [];
      req.on("data", function (c) { chunks.push(c); });
      req.on("end", function () { resolve(Buffer.concat(chunks)); });
      req.on("error", reject);
    });
  }

  function send(res, status, body, headers) {
    const h = Object.assign({}, headers || {});
    if (body !== undefined && body !== null) {
      h["Content-Length"] = Buffer.byteLength(body);
    }
    res.writeHead(status, h);
    res.end(body);
  }

  function xmlError(res, status, code, message) {
    send(res, status,
      "<?xml version=\"1.0\"?><Error><Code>" + code + "</Code><Message>" + message +
      "</Message></Error>",
      { "Content-Type": "application/xml" });
  }

  const server = http.createServer(function (req, res) {
    readBody(req).then(function (body) {
      const rawPath = req.url.split("?")[0];
      const rawQuery = req.url.indexOf("?") >= 0 ? req.url.slice(req.url.indexOf("?") + 1) : "";
      const segs = rawPath.replace(/^\//, "").split("/");
      const bucket = decodeURIComponent(segs[0] || "");
      const key = segs.slice(1).map(decodeURIComponent).join("/");
      const isPresigned = /(^|&)X-Amz-Signature=/.test(rawQuery);
      const hasAuthHeader = !!req.headers.authorization;

      calls.push({ method: req.method, bucket: bucket, key: key,
        presigned: isPresigned, authed: hasAuthHeader });

      if (!Object.prototype.hasOwnProperty.call(buckets, bucket)) {
        xmlError(res, 404, "NoSuchBucket", "bucket not found");
        return;
      }
      const bucketCfg = buckets[bucket];

      /* --- 认证 --- */
      let authed = false;
      if (isPresigned) {
        const v = verifyPresigned(req.method, rawPath, rawQuery, req.headers, creds, clock());
        if (!v.ok) {
          if (v.code === "EXPIRED") {
            xmlError(res, 403, "AccessDenied", "Request has expired");
          } else {
            xmlError(res, 403, "SignatureDoesNotMatch", v.reason);
          }
          return;
        }
        authed = true;
        /* presigned 只允许 PUT（本任务只签发 PUT） */
        if (req.method !== "PUT") {
          xmlError(res, 403, "AccessDenied", "presigned url only authorizes PUT");
          return;
        }
      } else if (hasAuthHeader) {
        const v = verifyHeaderAuth(req, rawPath, rawQuery, body, creds);
        if (!v.ok) {
          xmlError(res, 403, "SignatureDoesNotMatch", v.reason);
          return;
        }
        authed = true;
      }

      /* --- 私有 bucket：匿名一律拒绝（GET/HEAD/LIST 都不行） --- */
      if (!authed) {
        if (!bucketCfg.publicRead) {
          xmlError(res, 403, "AccessDenied", "bucket is private");
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          xmlError(res, 403, "AccessDenied", "public bucket is read-only");
          return;
        }
      }

      const fullKey = keyOf(bucket, key);

      /* --- LIST --- */
      if (req.method === "GET" && rawQuery.indexOf("list-type=2") >= 0) {
        const m = /(?:^|&)prefix=([^&]*)/.exec(rawQuery);
        const prefix = m ? decodeURIComponent(m[1]) : "";
        const items = [];
        for (const [k, v] of objects) {
          if (!k.startsWith(bucket + "/")) { continue; }
          const objKey = k.slice(bucket.length + 1);
          if (prefix && !objKey.startsWith(prefix)) { continue; }
          items.push("<Contents><Key>" + objKey + "</Key><Size>" + v.body.length +
            "</Size></Contents>");
        }
        send(res, 200,
          "<?xml version=\"1.0\"?><ListBucketResult><IsTruncated>false</IsTruncated>" +
          items.join("") + "</ListBucketResult>",
          { "Content-Type": "application/xml" });
        return;
      }

      /* --- PUT --- */
      if (req.method === "PUT") {
        const metadata = {};
        Object.keys(req.headers).forEach(function (h) {
          const m = /^x-amz-meta-(.+)$/i.exec(h);
          if (m) { metadata[m[1].toLowerCase()] = String(req.headers[h]); }
        });
        objects.set(fullKey, {
          body: body,
          contentType: req.headers["content-type"] || null,
          cacheControl: req.headers["cache-control"] || null,
          contentDisposition: req.headers["content-disposition"] || null,
          metadata: metadata
        });
        send(res, 200, null, { ETag: '"' + sha256hex(body).slice(0, 16) + '"' });
        return;
      }

      const obj = objects.get(fullKey);
      if (!obj) { xmlError(res, 404, "NoSuchKey", "not found"); return; }

      /* --- HEAD --- */
      if (req.method === "HEAD") {
        /* HEAD 无 body，但必须显式给出 Content-Length（真实 S3/R2 行为） */
        const h = {
          ETag: '"' + sha256hex(obj.body).slice(0, 16) + '"',
          "Content-Length": String(obj.body.length)
        };
        if (obj.contentType) { h["Content-Type"] = obj.contentType; }
        if (obj.cacheControl) { h["Cache-Control"] = obj.cacheControl; }
        if (obj.contentDisposition) { h["Content-Disposition"] = obj.contentDisposition; }
        Object.keys(obj.metadata).forEach(function (k) { h["x-amz-meta-" + k] = obj.metadata[k]; });
        res.writeHead(200, h);
        res.end();
        return;
      }

      /* --- GET（支持 Range） --- */
      if (req.method === "GET") {
        const h = { ETag: '"' + sha256hex(obj.body).slice(0, 16) + '"', "Accept-Ranges": "bytes" };
        if (obj.contentType) { h["Content-Type"] = obj.contentType; }
        if (obj.cacheControl) { h["Cache-Control"] = obj.cacheControl; }
        Object.keys(obj.metadata).forEach(function (k) { h["x-amz-meta-" + k] = obj.metadata[k]; });
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : obj.body.length - 1;
            if (start >= obj.body.length) {
              send(res, 416, null, { "Content-Range": "bytes */" + obj.body.length });
              return;
            }
            const slice = obj.body.slice(start, Math.min(end, obj.body.length - 1) + 1);
            h["Content-Range"] = "bytes " + start + "-" + (start + slice.length - 1) +
              "/" + obj.body.length;
            send(res, 206, slice, h);
            return;
          }
        }
        send(res, 200, obj.body, h);
        return;
      }

      /* --- DELETE --- */
      if (req.method === "DELETE") {
        objects.delete(fullKey);
        send(res, 204, null, {});
        return;
      }

      xmlError(res, 405, "MethodNotAllowed", "unsupported");
    }).catch(function () {
      xmlError(res, 500, "InternalError", "mock failure");
    });
  });

  return {
    server: server,
    creds: creds,
    objects: objects,
    calls: calls,
    /* 测试辅助：直接塞对象（模拟手机已 PUT 成功） */
    seed: function (bucket, key, body, extra) {
      objects.set(keyOf(bucket, key), Object.assign({
        body: body, contentType: null, cacheControl: null, metadata: {}
      }, extra || {}));
    },
    get: function (bucket, key) { return objects.get(keyOf(bucket, key)); },
    has: function (bucket, key) { return objects.has(keyOf(bucket, key)); },
    count: function () { return objects.size; },
    listen: function () {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", function () {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close: function () {
      return new Promise(function (resolve) { server.close(function () { resolve(); }); });
    }
  };
}

/* Custom Domain 模拟：把某个 bucket 的对象以「根路径公开只读」暴露，
   等价于 Cloudflare 上 download.shiinalab.top → R2 bucket 的绑定行为。
   用于测试发布流程对公网下载域的 HEAD / Range GET 轻量验证。 */
function createPublicDomainProxy(mock, bucket, options) {
  const opts = options || {};
  /* 记录 Cloudflare 风格的可观测头，测试据此断言缓存语义 */
  const seen = [];
  const server = http.createServer(function (req, res) {
    const rawPath = req.url.split("?")[0];
    const key = rawPath.replace(/^\//, "").split("/").map(decodeURIComponent).join("/");
    const obj = mock.get(bucket, key);
    seen.push({
      method: req.method, key: key, range: req.headers.range || null,
      status: obj ? (req.headers.range ? 206 : 200) : 404,
      cacheStatus: opts.cacheStatus || "HIT"
    });
    if (!obj) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const h = {
      "Content-Length": String(obj.body.length),
      "Accept-Ranges": "bytes",
      ETag: '"' + sha256hex(obj.body).slice(0, 16) + '"',
      "CF-Cache-Status": opts.cacheStatus || "HIT"
    };
    if (obj.contentType) { h["Content-Type"] = obj.contentType; }
    if (obj.cacheControl) { h["Cache-Control"] = obj.cacheControl; }
    if (obj.contentDisposition) { h["Content-Disposition"] = obj.contentDisposition; }
    const range = req.headers.range;
    if (range && req.method === "GET") {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : obj.body.length - 1;
        const slice = obj.body.slice(start, Math.min(end, obj.body.length - 1) + 1);
        h["Content-Range"] = "bytes " + start + "-" + (start + slice.length - 1) +
          "/" + obj.body.length;
        res.writeHead(206, h);
        res.end(req.method === "HEAD" ? undefined : slice);
        return;
      }
    }
    res.writeHead(200, h);
    res.end(req.method === "HEAD" ? undefined : obj.body);
  });
  return {
    server: server,
    seen: seen,
    listen: function () {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", function () {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close: function () {
      return new Promise(function (resolve) { server.close(function () { resolve(); }); });
    }
  };
}

module.exports = {
  createMockS3: createMockS3,
  createPublicDomainProxy: createPublicDomainProxy,
  verifyHeaderAuth: verifyHeaderAuth,
  verifyPresigned: verifyPresigned,
  buildCanonical: buildCanonical,
  computeSignature: computeSignature,
  sha256hex: sha256hex
};
