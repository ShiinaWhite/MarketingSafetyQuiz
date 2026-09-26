#!/usr/bin/env node
/* init_secret.js —— 样本写接口认证 Secret 一次性初始化工具
   （PUBLIC_SAMPLE_AUTH_V1）

   生成 256-bit cryptographically secure random secret（64 hex chars），
   写入 <repoRoot>/.secrets/sample-write-token（本机文件，.gitignore 覆盖，
   绝不进入 Git）。

   用法：
     node tools/sample_auth/init_secret.js                # 不存在时生成
     node tools/sample_auth/init_secret.js --rotate       # 强制替换现有 secret

   环境变量 MSQ_SAMPLE_WRITE_TOKEN 优先级高于本文件（Collector 与发布脚本
   均先读环境变量）。本轮不自动轮换。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SECRETS_DIR = path.join(ROOT, ".secrets");
const SECRET_FILE = path.join(SECRETS_DIR, "sample-write-token");

const rotate = process.argv.includes("--rotate");

if (!fs.existsSync(SECRETS_DIR)) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
}

if (fs.existsSync(SECRET_FILE) && !rotate) {
  console.log("sample write secret 已存在，未改动：" + SECRET_FILE);
  console.log("（如需轮换请显式使用 --rotate，并同步给正在运行的 Collector 重启加载）");
  process.exit(0);
}

const token = crypto.randomBytes(32).toString("hex");   // 256-bit
fs.writeFileSync(SECRET_FILE, token + "\n", { mode: 0o600 });

console.log("sample write secret 已写入：" + SECRET_FILE);
console.log("强度：256-bit（64 hex chars）");
if (rotate) { console.log("（--rotate：旧 secret 已被替换；Collector 重启后旧 App 将 401，直至 OTA 新版本）"); }
