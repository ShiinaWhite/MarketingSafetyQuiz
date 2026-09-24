/* test_collector.js —— Sample Collector 自检（Node 标准库，无第三方依赖）
   运行: node tools/sample_collector/test_collector.js   （退出码 0 = 全部通过）
   全程写入 os.tmpdir() 随机目录，结束清理，不触碰 real_samples。 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createCollector, validSampleId, decodeJpegDataUrl, jpegSize, sha256Hex
} = require("./server.js");

const fails = [];
function check(name, cond, detail) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail !== undefined ? `  (${detail})` : ""));
  if (!cond) { fails.push(name); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/* 结构合法的最小 JPEG（SOI+APP0+DQT+SOF0(width,height)+DHT+SOS+熵编码占位+EOI）。
   服务器只做标记级解析（SOF 宽高 / SOI 魔数），不解码整图；
   「真实照片可解码且可作为 OCR 输入」由模拟器端到端实测覆盖。 */
function makeFixtureJpeg(width, height) {
  const be16 = (n) => [(n >> 8) & 255, n & 255];
  const seg = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
  const SOI = [0xFF, 0xD8];
  const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const DQT = seg(0xDB, [0x00, ...new Array(64).fill(8)]);
  const SOF0 = seg(0xC0, [0x08, ...be16(height), ...be16(width), 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const DHT = seg(0xC4, [0x00, ...new Array(16).fill(0), 0x00]);
  const SOS = seg(0xDA, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]);
  const EOI = [0xFF, 0xD9];
  return Buffer.from([SOI, APP0, DQT, SOF0, DHT, SOS, 0x00, 0x12, EOI].flat());
}

function request(port, method, reqPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null
      : (Buffer.isBuffer(body) ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"));
    const req = http.request({
      host: "127.0.0.1", port: port, method: method, path: reqPath,
      headers: Object.assign(
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        headers || {})
    }, function (res) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { walk(full); } else { out.push(path.relative(root, full)); }
  });
  walk(root);
  return out.sort();
}

const SAMPLE_ID = "20260923_171530_ab12cd";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msq-collector-test-"));
  let server = null;
  try {
    const collector = createCollector({ out: tmp });
    const port = await collector.listen("127.0.0.1", 0);
    server = collector.server;

    /* ---- /health ---- */
    section("GET /health");
    let r = await request(port, "GET", "/health");
    let h = JSON.parse(r.body.toString("utf8"));
    check("health 返回 200", r.status === 200);
    check("ok=true / service / version", h.ok === true && h.service === "msq-sample-collector" && h.version === 1);
    r = await request(port, "GET", "/no-such-api");
    check("未知路径 404", r.status === 404);

    /* ---- CORS 预检 ---- */
    section("OPTIONS 预检");
    r = await request(port, "OPTIONS", "/api/sample");
    check("OPTIONS 返回 204", r.status === 204);
    check("允许跨域与 Content-Type",
      r.headers["access-control-allow-origin"] === "*" &&
      (r.headers["access-control-allow-headers"] || "").toLowerCase().includes("content-type"));

    /* ---- 合法样本 ---- */
    section("POST /api/sample 合法样本");
    const jpg = makeFixtureJpeg(640, 480);
    const dataUrl = "data:image/jpeg;base64," + jpg.toString("base64");
    const manifest = {
      sampleId: SAMPLE_ID,
      capturedAt: "2026-09-23T17:15:30.000Z",
      pageType: "single",
      image: { filename: "capture.jpg" },
      ocr: { text: "31 根据营销安规规定…", width: null, height: null, lines: [{ text: "31 根…", left: 10, top: 20, right: 300, bottom: 40 }] },
      blocks: [{ screenNumber: "31", finalBankId: 12, finalAnswer: "A", confidence: "high", candidates: [{ rank: 1, bankId: 12, score: 980 }] }],
      timing: { ocrMs: 900, splitMs: 2, matchMs: 20, totalMs: 1000 }
    };
    r = await request(port, "POST", "/api/sample", { sampleId: SAMPLE_ID, photoDataUrl: dataUrl, manifest });
    check("返回 201", r.status === 201, `status=${r.status} body=${r.body.toString("utf8").slice(0, 120)}`);
    const resp = JSON.parse(r.body.toString("utf8"));
    check("响应 sha256 与本地计算一致", resp.sha256 === sha256Hex(jpg));
    check("响应 bytes 一致", resp.bytes === jpg.length);

    const sampleDir = path.join(tmp, "2026-09-23", SAMPLE_ID);
    const saved = fs.readFileSync(path.join(sampleDir, "capture.jpg"));
    check("capture.jpg 字节与上传内容完全一致（无二次压缩）", saved.equals(jpg));
    const run = JSON.parse(fs.readFileSync(path.join(sampleDir, "run.json"), "utf8"));
    check("run.json 可解析且 schemaVersion=1", run.schemaVersion === 1);
    check("run.json image 三元组正确",
      run.image.filename === "capture.jpg" && run.image.bytes === jpg.length &&
      run.image.sha256 === sha256Hex(jpg));
    check("SOF 宽高解析正确（640x480）", run.image.width === 640 && run.image.height === 480);
    check("manifest 业务字段原样保留",
      run.manifest === undefined && run.pageType === "single" && run.ocr.text.startsWith("31") &&
      run.blocks.length === 1 && run.blocks[0].finalBankId === 12 && run.timing.totalMs === 1000);
    check("sampleId 目录派生正确（日期目录存在）", fs.existsSync(path.join(tmp, "2026-09-23")));

    /* ---- 重复 / 非法输入 ---- */
    section("重复与非法输入");
    r = await request(port, "POST", "/api/sample", { sampleId: SAMPLE_ID, photoDataUrl: dataUrl, manifest });
    check("重复上传同内容 → 200 alreadyExists（幂等，at-least-once 重传安全）",
      r.status === 200 && JSON.parse(r.body.toString("utf8")).alreadyExists === true,
      "status=" + r.status);
    check("幂等重传后 capture.jpg 未被破坏",
      fs.readFileSync(path.join(sampleDir, "capture.jpg")).equals(jpg));
    const jpgB = makeFixtureJpeg(320, 240);
    r = await request(port, "POST", "/api/sample",
      { sampleId: SAMPLE_ID, photoDataUrl: "data:image/jpeg;base64," + jpgB.toString("base64"), manifest });
    check("同 sampleId 不同内容 → 409 conflict（不覆盖）", r.status === 409);
    check("409 冲突后 capture.jpg 仍为原始字节",
      fs.readFileSync(path.join(sampleDir, "capture.jpg")).equals(jpg));

    const badIds = ["../etc/passwd", "a/b/c", "20260923_171530", "20260923_171530_ZZ12cd",
      "20261301_171530_ab12cd", "", undefined, SAMPLE_ID + "/../../x"];
    let allRejected = true;
    for (const bad of badIds) {
      const rr = await request(port, "POST", "/api/sample", { sampleId: bad, photoDataUrl: dataUrl, manifest });
      if (rr.status !== 400) { allRejected = false; }
    }
    check("非法 sampleId 全部 400（含 ../ 穿越）", allRejected);

    r = await request(port, "POST", "/api/sample",
      { sampleId: "20260923_171531_ac12cd", photoDataUrl: "data:image/png;base64,iVBORw0KGgo=", manifest });
    check("PNG dataURL → 400（只接受 image/jpeg）", r.status === 400);
    r = await request(port, "POST", "/api/sample",
      { sampleId: "20260923_171532_ad12cd", photoDataUrl: "data:image/jpeg;base64,////", manifest });
    check("非 JPEG 字节（SOI 魔数不符）→ 400", r.status === 400);
    r = await request(port, "POST", "/api/sample",
      { sampleId: "20260923_171533_ae12cd", manifest });
    check("缺 photoDataUrl → 400", r.status === 400);
    r = await request(port, "POST", "/api/sample",
      { sampleId: "20260923_171534_af12cd", photoDataUrl: dataUrl });
    check("缺 manifest → 400", r.status === 400);

    r = await request(port, "POST", "/api/sample", "{not json", { "Content-Type": "application/json" });
    check("malformed JSON → 400", r.status === 400);

    /* ---- 超限 body（独立实例 + 独立临时目录，低上限） ---- */
    section("body 大小上限");
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "msq-collector-test2-"));
    const small = createCollector({ out: tmp2, maxBodyBytes: 1024 });
    const smallPort = await small.listen("127.0.0.1", 0);
    try {
      const padded = JSON.parse(JSON.stringify(manifest));
      padded.ocr.text = "x".repeat(5000); /* 确保 body > 1KB 触发上限 */
      r = await request(smallPort, "POST", "/api/sample", { sampleId: "20260923_171535_ba12cd", photoDataUrl: dataUrl, manifest: padded });
      check("超限 body → 413", r.status === 413);
    /* ---- 更新接口（只读；channel 白名单 + 固定文件名） ---- */
    section("GET /api/update/*");
    const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "msq-updates-test-"));
    const devDir = path.join(updatesRoot, "dev");
    fs.mkdirSync(devDir, { recursive: true });
    const updApk = makeFixtureJpeg(320, 240); /* 任意字节即可，服务器只透传 */
    fs.writeFileSync(path.join(devDir, "营销安规刷题-DEV.apk"), updApk);
    fs.writeFileSync(path.join(devDir, "latest.json"), JSON.stringify({
      schemaVersion: 1, channel: "dev", packageName: "com.jty.safetyquiz.dev",
      versionCode: 3, versionName: "1.0.3-dev", apkUrl: "/api/update/dev/apk",
      sha256: sha256Hex(updApk), size: updApk.length, publishedAt: "2026-09-24T00:00:00Z", notes: "t"
    }));

    const collector2 = createCollector({ out: tmp, updatesRoot: updatesRoot });
    const port2 = await collector2.listen("127.0.0.1", 0);
    try {
      r = await request(port2, "GET", "/api/update/dev/latest");
      check("latest 200 + no-store", r.status === 200 && (r.headers["cache-control"] || "").includes("no-store"));
      const latest = JSON.parse(r.body.toString("utf8"));
      check("latest 内容透传（schemaVersion/channel/versionCode）",
        latest.schemaVersion === 1 && latest.channel === "dev" && latest.versionCode === 3);
      r = await request(port2, "GET", "/api/update/dev/apk");
      check("apk 200 + 正确 Content-Type/Length",
        r.status === 200 &&
        r.headers["content-type"] === "application/vnd.android.package-archive" &&
        Number(r.headers["content-length"]) === updApk.length);
      check("apk 字节完全一致", r.body.equals(updApk));
      r = await request(port2, "GET", "/api/update/nosuch/latest");
      check("未知 channel → 404", r.status === 404);
      r = await request(port2, "GET", "/api/update/stable/latest");
      check("stable channel 无文件 → 404", r.status === 404);
      r = await request(port2, "GET", "/api/update/..%2F..%2F/latest");
      check("channel 穿越尝试 → 404（白名单外）", r.status === 404);
      r = await request(port2, "GET", "/api/update/dev/nothere");
      check("更新接口其它路径 → 404", r.status === 404);
      r = await request(port2, "GET", "/api/update/dev/apk?file=..%2F..%2Fx");
      check("查询参数被忽略（无任意文件读取）", r.status === 200 && r.body.equals(updApk));
    } finally { collector2.server.close(); fs.rmSync(updatesRoot, { recursive: true, force: true }); }
    } finally {
      small.server.close();
      fs.rmSync(tmp2, { recursive: true, force: true });
    }

    /* ---- feedback：v1 兼容 + v2 幂等 upsert ---- */
    section("POST /api/feedback（v1 请求兼容）");
    r = await request(port, "POST", "/api/feedback", { sampleId: SAMPLE_ID, userFlag: "has_error", screenNumbers: ["31", "33"] });
    check("v1 请求 feedback 200", r.status === 200);
    let fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("v1 请求迁移为 v2 且 legacy 保留（不破坏历史数据）",
      fb.schemaVersion === 2 && fb.legacy && fb.legacy.userFlag === "has_error" &&
      fb.legacy.screenNumbers.join() === "31,33" && fb.pageIssues.length === 0 && fb.blockIssues.length === 0);
    r = await request(port, "POST", "/api/feedback", { sampleId: "20260923_171536_bb12cd", userFlag: "x" });
    check("样本不存在 → 404", r.status === 404);
    r = await request(port, "POST", "/api/feedback", { sampleId: "../x", userFlag: "x" });
    check("feedback 非法 sampleId → 400", r.status === 400);

    section("POST /api/feedback（v2 幂等 upsert）");
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["missing_question", "other"] });
    check("page set 200", r.status === 200);
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("pageIssues = 2 项（已排序去重）",
      fb.pageIssues.length === 2 && fb.pageIssues[0].type === "missing_question" && fb.pageIssues[1].type === "other");
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["missing_question", "other"] });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("重复 set 同 issue 幂等（不产生重复）", fb.pageIssues.length === 2);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["wrong_page_type"] });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("page set 全量替换（修改反馈）",
      fb.pageIssues.length === 1 && fb.pageIssues[0].type === "wrong_page_type");
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "remove", scope: "page" });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("page remove 清空", fb.pageIssues.length === 0);

    const blockPayload = { screenNumber: "27", rawScreenNumber: "27", numberSource: "ocr",
      type: "single", finalAnswer: "A", confidence: "low", finalBankId: 123, matchedByOptions: false };
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "wrong_answer",
        blockIndex: 2, block: blockPayload });
    check("block set 200", r.status === 200);
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("blockIssue 落盘且字段完整",
      fb.blockIssues.length === 1 && fb.blockIssues[0].blockIndex === 2 &&
      fb.blockIssues[0].issue === "wrong_answer" && fb.blockIssues[0].finalAnswer === "A" &&
      fb.blockIssues[0].finalBankId === 123 && fb.blockIssues[0].matchedByOptions === false);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "wrong_answer",
        blockIndex: 2, block: blockPayload });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("重复 block set 幂等（upsert 不重复）", fb.blockIssues.length === 1);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "wrong_answer",
        blockIndex: 3, block: blockPayload });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("block 3 反馈不影响 block 2", fb.blockIssues.length === 2);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "remove", scope: "block", issue: "wrong_answer", blockIndex: 2 });
    fb = JSON.parse(fs.readFileSync(path.join(sampleDir, "feedback.json"), "utf8"));
    check("block remove 撤销（只删目标项）",
      fb.blockIssues.length === 1 && fb.blockIssues[0].blockIndex === 3);

    section("POST /api/feedback（非法输入）");
    r = await request(port, "POST", "/api/feedback", { sampleId: SAMPLE_ID, action: "upsert", scope: "page" });
    check("非法 action → 400", r.status === 400);
    r = await request(port, "POST", "/api/feedback", { sampleId: SAMPLE_ID, action: "set", scope: "page" });
    check("page set 缺 issueTypes → 400", r.status === 400);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "page", issueTypes: ["not_a_type"] });
    check("未知 issueType → 400", r.status === 400);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "not_an_issue", blockIndex: 1 });
    check("未知 block issue → 400", r.status === 400);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "wrong_answer", blockIndex: -1 });
    check("blockIndex 非法 → 400", r.status === 400);
    r = await request(port, "POST", "/api/feedback",
      { sampleId: SAMPLE_ID, action: "set", scope: "block", issue: "wrong_answer", blockIndex: 1, block: "oops" });
    check("block 字段非对象 → 400", r.status === 400);

    /* ---- 目录净度与穿越隔离 ---- */
    section("目录净度");
    const files = listFilesRecursive(tmp).map((f) => f.split(path.sep).join("/"));
    check("无 .tmp 残留（原子写）", !files.some((f) => f.includes(".tmp-")));
    check("目录内只有预期文件",
      JSON.stringify(files) === JSON.stringify(["2026-09-23/" + SAMPLE_ID + "/capture.jpg",
        "2026-09-23/" + SAMPLE_ID + "/feedback.json",
        "2026-09-23/" + SAMPLE_ID + "/run.json"]), files.join(", "));

    /* ---- 纯函数单测 ---- */
    section("纯函数");
    check("validSampleId 合法样例", validSampleId("20260923_171530_ab12cd"));
    check("validSampleId 拒绝 2 月 30 日", !validSampleId("20260230_120000_ab12cd"));
    check("decodeJpegDataUrl 拒绝非 jpeg", decodeJpegDataUrl("data:image/png;base64,AAAA") === null);
    check("jpegSize 非 JPEG → null", jpegSize(Buffer.from("hello")) === null);
    const big = makeFixtureJpeg(3000, 4000);
    check("jpegSize 竖版 3000x4000", (jpegSize(big).width === 3000 && jpegSize(big).height === 4000));
  } finally {
    if (server) { server.close(); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }


    console.log("\n==============================================");
  if (fails.length) {
    console.log(`结果：${fails.length} 项失败 ✗`);
    fails.forEach((f) => console.log("  FAIL: " + f));
    process.exit(1);
  }
  console.log("结果：全部通过 ✓");
}

main().catch(function (e) {
  console.error("test harness error:", e);
  process.exit(1);
});
