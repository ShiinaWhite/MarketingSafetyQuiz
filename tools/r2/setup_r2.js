#!/usr/bin/env node
/* setup_r2.js —— Cloudflare R2 一次性基础设施配置（R2_FAST_TRANSFER_V1）

   目标状态：
     Bucket A  marketing-safety-quiz-downloads   公开 APK 下载
               + Custom Domain download.shiinalab.top（匿名 GET 允许）
               + r2.dev development URL 关闭（不依赖它）
     Bucket B  marketing-safety-quiz-samples     私有真实样本
               + 保持 PRIVATE（无 Custom Domain、无 r2.dev、无匿名访问）
               + Local Uploads ENABLED
               + Lifecycle：samples/ 90 天过期；tmp/ 7 天过期

   用法：
     node tools/r2/setup_r2.js --check               只检查当前状态（只读）
     node tools/r2/setup_r2.js --apply [--zone-id Z] 实际创建/配置

   前提：wrangler 已登录（npx wrangler login）。
   注意：R2 的 S3 API credential（R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）
         **无法**通过 wrangler 创建，必须由人在 Dashboard 生成一次，见 setup_r2.md。
        本脚本不会、也不能替你生成它——这是刻意设计（避免脚本持有账号级权限）。

   本脚本只调用 wrangler，不直接读写任何 secret；输出里不打印任何 credential。 */

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const cf = require("./cf_api.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DOWNLOAD_BUCKET = "marketing-safety-quiz-downloads";
const SAMPLE_BUCKET = "marketing-safety-quiz-samples";
const DOWNLOAD_DOMAIN = "download.shiinalab.top";
const ZONE_NAME = "shiinalab.top";
const SAMPLE_RETENTION_DAYS = 90;
const TMP_RETENTION_DAYS = 7;

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "OK" : ".."}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

function wrangler(args) {
  const isWin = process.platform === "win32";
  const r = isWin
    ? spawnSync(process.env.ComSpec || "cmd.exe",
        ["/c", "npx", "--yes", "wrangler@4", ...args],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    : spawnSync("npx", ["--yes", "wrangler@4", ...args],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function parseArgs(argv) {
  const a = { apply: false, check: false, zoneId: process.env.R2_ZONE_ID || null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--apply") { a.apply = true; }
    else if (argv[i] === "--check") { a.check = true; }
    else if (argv[i] === "--zone-id") { a.zoneId = argv[++i] || null; }
  }
  if (!a.apply && !a.check) { a.check = true; }
  return a;
}

/* 自动发现 shiinalab.top 的 Zone ID（wrangler 无 zone 子命令，走 Cloudflare API）。
   只读取 OAuth token，绝不打印 token。返回 { ok, zoneId, zoneName, error } */
async function discoverZoneId(explicit) {
  if (explicit) { return { ok: true, zoneId: explicit, zoneName: "(from --zone-id)", source: "arg" }; }
  const t = cf.loadOAuthToken();
  if (!t.ok) { return { ok: false, error: t.error }; }
  const z = await cf.findZoneByName(t.token, ZONE_NAME);
  if (!z.ok) { return { ok: false, error: z.error }; }
  return {
    ok: true, zoneId: z.zone.id, zoneName: z.zone.name,
    zoneStatus: z.zone.status, source: "cloudflare api (zone:read)"
  };
}

/* R2 是否已在账号上启用。未启用时 Cloudflare 返回 code 10042。 */
async function r2Enabled() {
  const t = cf.loadOAuthToken();
  if (!t.ok) { return { ok: false, error: t.error }; }
  const me = await cf.cfRequest(t.token, "GET", "/accounts/" + (process.env.R2_ACCOUNT_ID ||
    "b8790dc9fd8f5ab8442c4d2036c44729") + "/r2/buckets");
  if (me.status === 403 && me.body && me.body.errors &&
      me.body.errors.some(function (e) { return e.code === 10042; })) {
    return { ok: false, enabled: false, code: 10042,
      error: "R2 未在该账号启用（Cloudflare code 10042）" };
  }
  if (me.status === 200) { return { ok: true, enabled: true }; }
  return { ok: false, enabled: false, status: me.status,
    error: "无法判定 R2 启用状态（HTTP " + me.status + "）" };
}

function whoami() {
  const r = wrangler(["whoami"]);
  const authed = !/not authenticated/i.test(r.out);
  return { authed: authed, out: r.out };
}

function listBuckets() {
  const r = wrangler(["r2", "bucket", "list"]);
  const names = [];
  const re = /^\s*name:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(r.out)) !== null) { names.push(m[1].trim()); }
  return { ok: r.status === 0, names: names, out: r.out };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("== R2 基础设施配置（R2_FAST_TRANSFER_V1）==");
  console.log(args.apply ? "模式：APPLY（会创建/修改 Cloudflare 资源）" : "模式：CHECK（只读）");

  section("0) wrangler 登录状态");
  const me = whoami();
  check("wrangler 已登录", me.authed,
    me.authed ? "已认证" : "未认证 —— 需先运行 npx wrangler login（需浏览器授权）");
  if (!me.authed) {
    console.log("\n" + "=".repeat(60));
    console.log("R2_INFRA_USER_ACTION_REQUIRED");
    console.log("=".repeat(60));
    console.log("Cloudflare 授权必须由你本人在浏览器完成：");
    console.log("  1) npx wrangler login        （会打开浏览器，点 Allow）");
    console.log("  2) node tools/r2/setup_r2.js --apply   （Zone ID 会自动发现）");
    console.log("  3) 在 Dashboard 生成 R2 S3 credential 并写入");
    console.log("     tools/sample_collector/.env.r2.local（见 tools/r2/setup_r2.md）");
    console.log("=".repeat(60));
    process.exit(2);
  }

  section("0b) R2 订阅是否已在账号启用");
  const r2on = await r2Enabled();
  if (!r2on.ok && r2on.code === 10042) {
    console.log("\n" + "=".repeat(64));
    console.log("R2_ENABLE_USER_ACTION_REQUIRED");
    console.log("=".repeat(64));
    console.log("Cloudflare 报告：R2 尚未在该账号启用（code 10042）。");
    console.log("R2 的启用/订阅确认只能在 Dashboard 完成，无法用 wrangler 或 API 绕过。");
    console.log("");
    console.log("请在浏览器完成（一次性）：");
    console.log("  1) https://dash.cloudflare.com/  → 左侧 R2 Object Storage");
    console.log("  2) 首次进入会要求启用 R2 并确认订阅（R2 有免费额度，");
    console.log("     按提示确认即可；如要求绑定付款方式，请按 Dashboard 提示完成）");
    console.log("  3) 启用成功后回到这里重跑：node tools/r2/setup_r2.js --apply");
    console.log("");
    console.log("启用后本脚本会自动完成：建两个 bucket、绑定 download.shiinalab.top、");
    console.log("关闭 r2.dev、开启 Local Uploads、部署 lifecycle。");
    console.log("=".repeat(64));
    process.exit(2);
  }
  check("R2 已启用", r2on.ok, r2on.ok ? "已启用" : r2on.error);

  section("0c) 自动发现 shiinalab.top 的 Zone ID");
  const zone = await discoverZoneId(args.zoneId);
  if (zone.ok) {
    console.log("  ZONE_NAME = " + zone.zoneName);
    console.log("  ZONE_ID   = " + zone.zoneId + "   (来源：" + zone.source + ")");
    if (zone.zoneStatus) { console.log("  ZONE_STATUS = " + zone.zoneStatus); }
    check("Zone ID 已发现且为 " + ZONE_NAME, true, zone.zoneId);
  } else {
    check("自动发现 Zone ID", false, zone.error +
      "（可退化为 --zone-id 手工指定）");
  }

  section("1) 现有 R2 bucket");
  const lb = listBuckets();
  if (!lb.ok) {
    console.log("  无法列出 bucket（可能需要 account 级权限）：");
    console.log("  " + lb.out.split("\n").slice(0, 4).join("\n  "));
  } else {
    console.log("  已存在：" + (lb.names.length ? lb.names.join(", ") : "(无)"));
  }
  const hasDownload = lb.names.indexOf(DOWNLOAD_BUCKET) >= 0;
  const hasSample = lb.names.indexOf(SAMPLE_BUCKET) >= 0;
  check("downloads bucket 存在", hasDownload, hasDownload ? "已存在（将复用）" : "需创建");
  check("samples bucket 存在", hasSample, hasSample ? "已存在（将复用）" : "需创建");

  if (!args.apply) {
    console.log("\n（CHECK 模式结束。加 --apply 实际创建/配置。）");
    console.log("注意：R2 S3 credential 必须由你在 Dashboard 手动生成一次：");
    console.log("  见 tools/r2/setup_r2.md");
    process.exit(fails.length ? 1 : 0);
  }

  /* ---------- APPLY ---------- */

  section("2) 创建 bucket（已存在则复用，不重复创建）");
  if (!hasDownload) {
    const r = wrangler(["r2", "bucket", "create", DOWNLOAD_BUCKET]);
    check("创建 " + DOWNLOAD_BUCKET, r.status === 0, r.out.split("\n")[0]);
  } else { console.log("  复用已存在的 " + DOWNLOAD_BUCKET); }
  if (!hasSample) {
    const r = wrangler(["r2", "bucket", "create", SAMPLE_BUCKET]);
    check("创建 " + SAMPLE_BUCKET, r.status === 0, r.out.split("\n")[0]);
  } else { console.log("  复用已存在的 " + SAMPLE_BUCKET); }

  section("3) 关闭两个 bucket 的 r2.dev 公开开发 URL");
  /* 任务要求：downloads 不依赖 r2.dev；samples 绝不能有公开 URL */
  for (const b of [DOWNLOAD_BUCKET, SAMPLE_BUCKET]) {
    const r = wrangler(["r2", "bucket", "dev-url", "disable", b]);
    check("dev-url disable " + b, r.status === 0, r.out.split("\n")[0]);
  }

  section("4) downloads bucket 绑定 Custom Domain");
  if (!zone.ok) {
    check("绑定 " + DOWNLOAD_DOMAIN, false,
      "Zone ID 未取得：" + zone.error);
    console.log("  可改用 Dashboard 手动绑定（会自动建 DNS 记录）：");
    console.log("  R2 → " + DOWNLOAD_BUCKET + " → Settings → Custom Domains → Connect Domain");
  } else {
    const r = wrangler(["r2", "bucket", "domain", "add", DOWNLOAD_BUCKET,
      "--domain", DOWNLOAD_DOMAIN, "--zone-id", zone.zoneId, "-y"]);
    check("绑定 " + DOWNLOAD_DOMAIN + " → " + DOWNLOAD_BUCKET, r.status === 0,
      r.out.split("\n").slice(0, 2).join(" | "));
  }

  section("5) samples bucket 开启 Local Uploads");
  const lu = wrangler(["r2", "bucket", "local-uploads", "enable", SAMPLE_BUCKET]);
  check("local-uploads enable " + SAMPLE_BUCKET, lu.status === 0, lu.out.split("\n")[0]);
  const luGet = wrangler(["r2", "bucket", "local-uploads", "get", SAMPLE_BUCKET]);
  check("local-uploads get 返回启用状态",
    /enabled|true/i.test(luGet.out) && !/disabled|false/i.test(luGet.out),
    luGet.out.split("\n").slice(0, 3).join(" | "));

  section("6) samples bucket Lifecycle（samples/ 90 天，tmp/ 7 天）");
  /* 注意：这是「云端接收层 + 90 天缓冲」策略，PC real_samples 才是长期副本。
     前提是 Collector 的后台 mirror worker 真实存在（tools/sample_collector/r2_store.js）。 */
  const l1 = wrangler(["r2", "bucket", "lifecycle", "add", SAMPLE_BUCKET,
    "--name", "samples-90d", "--prefix", "samples/",
    "--expire-days", String(SAMPLE_RETENTION_DAYS), "-y"]);
  check("lifecycle samples/ → " + SAMPLE_RETENTION_DAYS + " 天", l1.status === 0,
    l1.out.split("\n")[0]);
  const l2 = wrangler(["r2", "bucket", "lifecycle", "add", SAMPLE_BUCKET,
    "--name", "tmp-7d", "--prefix", "tmp/",
    "--expire-days", String(TMP_RETENTION_DAYS), "-y"]);
  check("lifecycle tmp/ → " + TMP_RETENTION_DAYS + " 天", l2.status === 0,
    l2.out.split("\n")[0]);
  const lGet = wrangler(["r2", "bucket", "lifecycle", "list", SAMPLE_BUCKET]);
  console.log("  lifecycle 现状：\n" + lGet.out.split("\n").slice(0, 12).map((s) => "    " + s).join("\n"));

  section("7) 下一步（必须由人完成：S3 API credential）");
  console.log("  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 无法由脚本创建，请手动生成：");
  console.log("    Cloudflare Dashboard → R2 → API → Manage API Tokens → Create API Token");
  console.log("    权限：Object Read & Write");
  console.log("    资源：只勾选 " + DOWNLOAD_BUCKET + " 与 " + SAMPLE_BUCKET + "（least privilege）");
  console.log("    然后写入 tools/sample_collector/.env.r2.local（模板见 .env.r2.example）");
  console.log("  完成后验证：");
  console.log("    node tools/r2/setup_r2.js --check");
  console.log("    node tools/r2/verify_r2.js          （真实连通性 + 公开/私有边界实测）");

  console.log("\n" + "=".repeat(60));
  if (fails.length) {
    console.log("结果：有 " + fails.length + " 项未完成：");
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("结果：基础设施配置全部完成 ✓");
}

main().catch(function (e) {
  console.error("setup 异常：" + (e && e.stack || e));
  process.exit(1);
});
