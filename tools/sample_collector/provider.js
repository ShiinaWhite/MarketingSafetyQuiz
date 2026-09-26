#!/usr/bin/env node
/* provider.js —— Collector 的 S3 数据面 provider 选择（COS_SAMPLE_TRANSFER_V1）

   r2_store.js 的对象操作是 provider-neutral 的（SigV4 + virtual-hosted 已在
   tools/r2/r2.js 抽象），这里只决定"用哪家的 bucket"：

     1) 腾讯云 COS（当前生产选择）：tools/sample_collector/.env.cos.local
     2) Cloudflare R2（保留作后备）：tools/sample_collector/.env.r2.local
     3) 都没有 → available()=false，init/commit FAIL CLOSED 503，
        legacy /api/sample 不受影响

   两个 provider 的 config 形状一致（accessKeyId/secretAccessKey/sampleBucket/
   endpoint/region/service/virtualHostStyle），所以 r2_store 不需要知道是谁。
   COS 排在前面是因为它才是本轮的生产数据面；R2 只是"还留着"而不是"优先用"。

   安全：provider 文件里都不打印 secret；config 中的 secretAccessKey 只在
   Collector 进程内存里用于签名，绝不进日志/响应。 */

"use strict";

const path = require("path");
const cos = require("../cos/cos.js");
const r2 = require("../r2/r2.js");

/* 显式指定（测试/运维用）："cos" | "r2" | "none" | "auto"（默认） */
function selectProvider(opts) {
  const o = opts || {};
  const root = o.root || path.resolve(__dirname, "..", "..");
  const want = String(o.provider || process.env.MSQ_SAMPLE_PROVIDER || "auto").toLowerCase();

  /* 测试用：显式禁用所有 provider，验证 FAIL CLOSED 路径（不受本机 credential 影响） */
  if (want === "none") {
    return { ok: false, provider: null, error: "(provider explicitly disabled)" };
  }
  if (want === "cos") {
    const c = cos.loadConfig({ root: root });
    return c.ok
      ? { ok: true, provider: "cos", config: c.config, source: c.sources.file }
      : { ok: false, provider: "cos", error: c.error };
  }
  if (want === "r2") {
    const r = r2.loadConfig({ root: root });
    return r.ok
      ? { ok: true, provider: "r2", config: r.config, source: r.sources.file }
      : { ok: false, provider: "r2", error: r.error };
  }

  /* auto：COS 优先（生产数据面），R2 作后备 */
  const c = cos.loadConfig({ root: root });
  if (c.ok) {
    return { ok: true, provider: "cos", config: c.config, source: c.sources.file };
  }
  const r = r2.loadConfig({ root: root });
  if (r.ok) {
    return { ok: true, provider: "r2", config: r.config, source: r.sources.file };
  }
  return {
    ok: false, provider: null,
    error: "no sample-storage provider configured (cos: " + c.error + "; r2: " + r.error + ")"
  };
}

module.exports = { selectProvider: selectProvider };
