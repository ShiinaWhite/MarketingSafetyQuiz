#!/usr/bin/env node
/* cf_api.js —— 用 Wrangler 的 OAuth token 调用 Cloudflare API（R2_FAST_TRANSFER_V1 基础设施用）

   为什么需要它：wrangler 没有 `zone list` 子命令，而绑定 R2 Custom Domain 需要
   shiinalab.top 的 Zone ID。Wrangler 的 OAuth token 带有 zone:read 权限，可以直接查。

   安全约定（重要）：
   - 本模块只从 wrangler 本机配置读取 OAuth token，**绝不打印 token**，也绝不写入任何文件
   - 只做读操作（zone 发现 / token 校验）；R2 的创建与配置仍走 wrangler CLI
   - token 只用于 Cloudflare API 基础设施管理，**绝不能**当 R2 S3 Secret 使用
     （两者是不同体系：OAuth 管账号资源，S3 credential 才能读写对象） */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const API_HOST = "api.cloudflare.com";

/* wrangler 的 OAuth 凭据位置（Windows 走 APPDATA，其它平台走 XDG） */
function wranglerConfigPath() {
  const candidates = [];
  if (process.env.WRANGLER_CONFIG) { candidates.push(process.env.WRANGLER_CONFIG); }
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "xdg.config", ".wrangler", "config", "default.toml"));
  }
  candidates.push(path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"));
  candidates.push(path.join(os.homedir(), ".wrangler", "config", "default.toml"));
  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

/* 从 wrangler TOML 里取 oauth_token。只支持本项目实际用到的简单 key = "value" 形式。 */
function loadOAuthToken() {
  const file = wranglerConfigPath();
  if (!file) {
    return { ok: false, error: "wrangler config not found — 先运行 npx wrangler login" };
  }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return { ok: false, error: "cannot read wrangler config" };
  }
  const m = /^\s*oauth_token\s*=\s*"([^"]+)"/m.exec(text);
  if (!m || !m[1]) {
    return { ok: false, error: "no oauth_token in wrangler config — 先运行 npx wrangler login" };
  }
  return { ok: true, token: m[1], configPath: file };
}

function cfRequest(token, method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = https.request({
      hostname: API_HOST,
      port: 443,
      method: method,
      path: "/client/v4" + apiPath,
      headers: Object.assign({
        "Authorization": "Bearer " + token,
        "Accept": "application/json"
      }, payload ? {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length)
      } : {}),
      timeout: 30_000,
      agent: false
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on("error", reject);
    });
    req.on("timeout", function () { req.destroy(new Error("cloudflare api timeout")); });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

/* 校验 token 是否仍有效。
   注意：/user/tokens/verify 只校验 **API Token**，对 Wrangler 的 OAuth token 一律返回 401
   （它不是 API token）。OAuth token 要用 /user（user:read 权限）来判断。 */
async function verifyToken(token) {
  const r = await cfRequest(token, "GET", "/user");
  const ok = r.status === 200 && r.body && r.body.success === true;
  const email = r.body && r.body.result ? r.body.result.email : null;
  return { ok: ok, status: r.status, email: email };
}

/* 按名字精确查找 zone。返回 { ok, zone:{id,name,status,accountId} } 或 { ok:false, error } */
async function findZoneByName(token, name) {
  const r = await cfRequest(token, "GET", "/zones?name=" + encodeURIComponent(name));
  if (r.status !== 200 || !r.body || r.body.success !== true) {
    const errs = (r.body && r.body.errors || []).map(function (e) { return e.message; }).join("; ");
    return { ok: false, status: r.status, error: errs || ("HTTP " + r.status) };
  }
  const list = r.body.result || [];
  /* 精确匹配，避免拿到同名后缀的其它 zone */
  const exact = list.filter(function (z) { return z.name === name; });
  if (!exact.length) {
    return { ok: false, status: r.status, error: "zone not found: " + name,
      candidates: list.map(function (z) { return z.name; }) };
  }
  const z = exact[0];
  return {
    ok: true,
    zone: { id: z.id, name: z.name, status: z.status, accountId: z.account && z.account.id }
  };
}

/* 列出当前 token 可见的全部 zone（诊断用；不打印 token） */
async function listZones(token) {
  const r = await cfRequest(token, "GET", "/zones?per_page=50");
  if (r.status !== 200 || !r.body || r.body.success !== true) {
    return { ok: false, status: r.status };
  }
  return {
    ok: true,
    zones: (r.body.result || []).map(function (z) {
      return { id: z.id, name: z.name, status: z.status };
    })
  };
}

module.exports = {
  API_HOST: API_HOST,
  wranglerConfigPath: wranglerConfigPath,
  loadOAuthToken: loadOAuthToken,
  cfRequest: cfRequest,
  verifyToken: verifyToken,
  findZoneByName: findZoneByName,
  listZones: listZones
};
