# DATA_PLATFORM_V1_DESIGN

任务：DATA_PLATFORM_V1 —— 为「营销安规搜题」建立第一版数据基础设施。
两个彼此独立但共享基础设施的子系统：

- **A. USAGE_TELEMETRY_V1**：使用统计 / 活跃设备 / 批量上传 / SQLite
- **B. SAMPLE_DATABASE_V1**：现有拍题样本的结构化 SQLite 索引

基线：dev = origin/main = 44d65f6（main 只领先一个 merge commit，dev 已 ff 到该点）。
本任务全部代码只在 dev 开发；main 禁止修改；stable 禁止发布；DEV 目标 vc24 / 1.0.24-dev。

---

## 0. 总体架构

```
Android App (WebView, com.jty.safetyquiz.dev)
  www/js/telemetry.js      ← 纯逻辑：桶聚合 / outbox / 逻辑搜题口径 / flush / retry（Node 可测）
  TelemetryPlugin.java     ← 仅两个能力：读 ANDROID_ID、filesDir 持久化 state.json
  传输层                    ← 复用 MSQSample.postJSON（CapacitorHttp，HTTPS）
        │  HTTPS (Cloudflare Tunnel)
        ▼
Collector (tools/sample_collector/server.js，零第三方依赖，Node 22)
  POST /api/telemetry/register   ANDROID_ID → HMAC → telemetryDeviceId（内存内完成，立即丢弃原文）
  POST /api/telemetry/batch      严格 allowlist 校验 → telemetry.db 单事务
  既有 sample 链（init/COS 直传/commit/feedback）→ 旁路补写 samples.db（失败不影响原链路）
        │
        ├── data/telemetry/telemetry.db   （node:sqlite，WAL）
        └── data/samples/samples.db       （node:sqlite，WAL，与 telemetry.db 分离）

CLI 工具（本地，不经公网）：
  node tools/telemetry/report.js --days 1|7|30 [--json]
  node tools/sample_db/backfill.js --dry-run|--apply
  node tools/db/backup.js [--db telemetry|samples|both] [--keep N]
```

SQLITE_DRIVER：**node:sqlite**（本机 Node v22.23.2 内置，DatabaseSync + backup API 实测可用；
仅 ExperimentalWarning，无第三方依赖，符合「Collector 保持轻量」）。启动时
`require("node:sqlite")` 失败 → telemetry/samples 双写降级禁用并告警，**其余端点完全不受影响**。

---

## 1. TELEMETRY_SCHEMA_V1（线上协议）

### 1.1 POST /api/telemetry/register

```json
请求  { "schemaVersion": 1, "androidId": "0123456789abcdef" }
响应  200 { "ok": true, "deviceId": "<64 hex>", "deviceToken": "<64 hex>" }
```

- `androidId`：`/^[0-9a-f]{16}$/i`（ANDROID_ID 为 64bit → 16 hex），大小写归一为小写。
- 非法 → 400 `{ok:false}`；secret 缺失 → 503 FAIL CLOSED；body ≤ 4 KiB。
- 原始 ANDROID_ID **只在内存中参与 HMAC，不落任何持久层/日志/错误响应**，响应后即丢弃。
- **DATA_PLATFORM_V1_1**：响应额外签发 `deviceToken = HMAC(secret, "telemetry-batch-v1:"
  + deviceId)`；此后每笔 `/api/telemetry/batch` 必须同时提交 `deviceId + deviceToken`，
  服务端重新计算并 timing-safe compare：缺 token → 401，不匹配 → 403，两者都
  **零入库**。deviceToken 是 HMAC 派生物（非原始 secret），允许保存在客户端本地
  state；secret 轮换后旧 token 全部失效，客户端对 401/403 清空凭据重新注册（走退避）。

### 1.2 POST /api/telemetry/batch

```json
{
  "schemaVersion": 1,
  "deviceId": "<64 hex>",
  "deviceToken": "<64 hex>",
  "batches": [
    {
      "batchId": "uuid-v4",
      "localDay": "2026-09-27",
      "periodStart": 1695778800000,
      "periodEnd": 1695800400000,
      "versionCode": 24,
      "versionName": "1.0.24-dev",
      "channel": "dev",
      "packageName": "com.jty.safetyquiz.dev",
      "counters":  { "app_cold_start": 1, "text_search": 3 },
      "histograms": { "photo_total_ms": { "1000-2000": 1, ">=8000": 2 } }
    }
  ]
}
响应 200 { "ok": true, "accepted": ["…"], "alreadyAccepted": ["…"], "rejected": [] }
```

- `periodStart/periodEnd`：epoch ms，客户端桶边界。校验：整数、`0 < periodStart ≤ periodEnd`、
  跨度 ≤ 26h、`periodEnd ≤ now+10min`、`periodStart ≥ now-90d`、`localDay` 为真实日历日期且
  与 periodEnd 的 UTC 日期相差 ≤ 1 天（跨时区容差）。
- `batches` 数组 1..20；请求 body ≤ 128 KiB；超限一律 400。
- 未知顶层字段 / 未知 batch 字段 → 400（严格 schema，绝不任意 JSON 入库）。
- `channel` allowlist：`dev | stable | unknown`；`packageName` allowlist：
  `com.jty.safetyquiz.dev | com.jty.safetyquiz`（二者强绑定：dev 包必须报 dev channel）。
- `versionCode` 整数 1..1000000；`versionName` ≤ 40 字符 `[A-Za-z0-9._\-()]`。
- `counters`：键 ∈ METRIC_CATALOG counter 白名单（38 个），值整数 1..1000000。
- `histograms`：键 ∈ {photo_total_ms, ocr_ms}，桶标签 ∈ 固定桶集，值整数 1..1000000。
- 4xx 语义：**400 = 客户端 schema 错误**（服务端返回 `rejected` 明细，客户端丢弃对应 batch，
  不再退避重试）；**404 = 服务器未升级**（旧 Collector 无此路由）→ 按可重试网络错误退避，
  绝不丢数据；429/5xx/网络错误 → 退避重试。

## 2. METRIC_CATALOG_V1（服务端唯一 allowlist）

**生命周期**：`app_cold_start`、`app_resume`

**文字搜题**：`text_search`、`text_search_with_results`、`text_search_no_result`、`search_result_open`

**拍题**：`photo_attempt`、`photo_capture_success`、`photo_cancel`、`photo_failure`、
`photo_process_success`、`photo_process_failure`

**整页识别**：`recognized_question_total`、`confidence_high`、`confidence_medium`、
`confidence_low`、`confidence_none`

**AUTO**：`auto_single`、`auto_multi`、`auto_judge`、`type_manual_correction`

**用户反馈**：`feedback_missing_question`、`feedback_wrong_screen_number`、
`feedback_wrong_page_type`、`feedback_wrong_answer`、`feedback_other`

**学习功能**：`mode_sequence_start`、`mode_random_start`、`mode_single_start`、
`mode_multi_start`、`mode_judge_start`、`mode_wrong_start`、`mode_recite_start`、`mode_exam_start`

**错误**：`camera_error`、`ocr_error`、`matcher_error`、`telemetry_upload_error`

**Histogram（不传精确事件时间线，只传桶计数）**：
- `photo_total_ms`：`<1000`、`1000-2000`、`2000-4000`、`4000-8000`、`>=8000`
- `ocr_ms`：`<500`、`500-1000`、`1000-2000`、`2000-4000`、`>=4000`

埋点位置（全部旁路观察，任何异常 swallow）：
- `app_cold_start`：bootstrap；`app_resume`：Capacitor App `resume` 事件。
- 文字搜题四个计数：见 §4 逻辑搜题口径；`search_result_open` 仅文字搜题结果点击
  （batch-results 的「其他候选」打开不计入，属于拍题链路的诊断行为）。
- 拍题：`startBatchPageSearch` 入口（插件齐备后）= `photo_attempt`；`Camera.getPhoto`
  resolve = `photo_capture_success`；reject 且 message 匹配 /cancel/i = `photo_cancel`，
  其余（权限拒绝等）= `camera_error`；OCR 抛异常 = `ocr_error` + `photo_process_failure`；
  OCR 空行 = `photo_process_failure`；split/match 段 try/catch 兜底 = `matcher_error` +
  `photo_process_failure`；结果渲染成功 = `photo_process_success`，同时
  `photo_total_ms`/`ocr_ms` 入桶，各 block 计入 `recognized_question_total` 与对应
  confidence 计数（只在此处计，手动切题型重算不重复计识别量）。
- AUTO：`pageTypeMode === "auto"` 的判定结果 → `auto_<single|multi|judge>`；
  结果页手动切换题型（`switchBatchPageType` 且 mode ≠ auto）→ `type_manual_correction`。
- 反馈：页级 set 提交按 issueTypes 逐项 +1（`feedback_missing_question/wrong_screen_number/
  wrong_page_type/other`）；块级标错 +1（`feedback_wrong_answer`）；取消标错不计数。
- 学习模式：`startPractice(mode)` → `mode_<key>_start`（seq→sequence，rand→random，
  single/multi/judge/wrong/recite 直映）；`startExam()` → `mode_exam_start`。

## 3. DEVICE_IDENTITY_MODEL

统计口径 = **活跃设备**（ANDROID_ID），不是自然人。客户端不申请 IMEI/MEID/序列号/MAC/
Advertising ID/定位权限；原生侧只读 `Settings.Secure.ANDROID_ID`（已知坏值
`9774d56d682e549c` 视为不可用 → telemetry 本轮静默禁用，业务不受影响）。

注册流程与重装稳定性：

```
App 第一次需要 telemetry
  → TelemetryPlugin.getAndroidId()   （原生读 ANDROID_ID，仅内存）
  → HTTPS POST /api/telemetry/register
  → Server: deviceId = HMAC-SHA256(MSQ_TELEMETRY_HMAC_KEY, "msq-telemetry-v1:" + androidIdLower)
  → 原始 ANDROID_ID 立即丢弃（不落 SQLite/日志/JSON/debug dump）
  → 返回 deviceId（64 hex）→ 客户端缓存进 telemetry state
```

- HMAC 输入加域分隔前缀 `msq-telemetry-v1:`，防止同 secret 被跨协议重用。
- 卸载重装：本地缓存消失 → 用同一 ANDROID_ID 重新注册 → 同一 HMAC 输入 → **同一
  deviceId**，不会虚增设备。仅系统恢复出厂 / 刷机 / 授权重置（用户手动清除 ANDROID_ID
  的场景）才会生成新 id —— 符合「同一设备/签名环境下不因重装翻倍」的要求。
- **MSQ_TELEMETRY_HMAC_KEY**：环境变量优先，其次 `.secrets/telemetry-hmac-key` 文件。
  要求 ≥ 32 bytes；不进 Git / 不进 APK / 不打印日志 / 不进错误响应；secret_scan 扩展
  比对真实值。secret 缺失 → telemetry 两端点 503 FAIL CLOSED，**App 业务完全不受影响**
  （客户端视 503 为可重试错误，数据留在 outbox）。
- ANDROID_ID 红线（服务端）：request body 只在内存解析；HMAC 后原始值不可达；
  telemetry.db 不存在 androidId 列；日志器绝不输出请求体；错误响应不含请求回显。

## 4. 逻辑搜题口径（A4：绝不按逐字输入计数）

现状：`search-input` 每个 input 事件经 60ms 渲染 debounce 触发 `doSearch`，逐字输入会
触发 N 次。若按 doSearch 计数会把一次搜题膨胀成 N 条记录，且**逐字 query 字符串绝不能进
telemetry**。

**口径：空闲门 + 去重。**

```
observeSearch(query, resultCount)   ← doSearch 每次被调用时旁路喂入（含筛选重渲）
  query 为空 → 重置"已计数 query"（下次输入视为新意图），不计数
  query 非空 → 记为 pending，重置 1200ms 空闲定时器
  定时器到点且 pending 仍是最终值：
      query ≠ lastCountedQuery（内存态，不持久化）→ text_search +1
        resultCount > 0 → text_search_with_results +1，否则 text_search_no_result +1
        lastCountedQuery = query；pending 清空
      query = lastCountedQuery → 不计数（题型筛选切换/重渲染不产生新搜索）
```

- 逐字输入时每个键都重置空闲定时器，中间前缀永不满足「稳定 1200ms」，**一次连续输入
  最终只产出 1 个计数**，query 取最终稳定值。
- 回车/历史芯片点击等显式动作不另设计数路径：其最终 query 同样要经过空闲门，同一
  query 只计 1 次（显式动作把定时器重置为立即到期，避免多等 1.2s）。
- `lastCountedQuery` 只存内存：进程被杀最多损失一次计数（best-effort），并保证
  **query 字符串绝不进持久化 state / 上行报文**（TEL-PRIVACY 测试断言）。
- `search_result_open` 独立统计：结果项 click → `openSearchDetail(id, "search")` 时 +1，
  与搜题计数解耦（可能 > text_search：一个结果页可打开多个详情）。

## 5. CLIENT_AGGREGATION_MODEL（只聚合，不逐事件上传）

持久化 state（key `msq.telemetry.v1`；原生优先 `filesDir/telemetry/state.json` 原子写，
浏览器调试环境退回 localStorage；每条 metric 写穿保存，量级 KB 级）：

```json
{
  "schemaVersion": 1,
  "deviceId": "<64 hex | null>",
  "currentBucket": {
    "periodStart": 1695778800000, "periodEnd": null, "localDay": "2026-09-27",
    "counters": {}, "histograms": {}, "meaningfulActionCount": 0
  },
  "outbox": [ { "batchId": "…", …frozen batch… } ],
  "lastFlushSuccessAt": 0, "lastUploadAttemptAt": 0,
  "nextRetryAt": 0, "flushAttempts": 0, "lastFlushResult": "",
  "registerRetryAt": 0, "registerAttempts": 0
}
```

- `currentBucket` 只保存 counters / histograms / periodStart / periodEnd / localDay /
  meaningfulActionCount（+ 上行所需的 version/channel 元数据在 flush 时注入）。
  **不保存 raw events、不保存逐次时间线、不保存任何 query/OCR/内容文本。**
- `meaningfulActionCount`：每次 counter+1 或 histogram 观测都 +1（包括 app_cold_start），
  作为冻结阈值。
- 重启恢复：从 state.json 载入，outbox 与未满桶原样续用（TEL-OUTBOX 测试覆盖）。
- Telemetry 是 best-effort 分析数据：**不引入客户端 SQLite**，原生 JSON 文件持久化即可。

## 6. OUTBOX_MODEL

满足任一条件即冻结 `currentBucket`：

1. `meaningfulActionCount >= 30`（动作阈值）
2. `now - periodStart >= 6h`（桶龄阈值，在每次 record / resume / flush 检查时惰性判定）
3. `localDay` 跨日（本地区日翻转：任一写路径或 resume 时发现 currentBucket.localDay ≠
   今天 → 冻结）

冻结流程：`periodEnd = now` → 生成 `batchId`（UUID v4）→ 压入 `outbox` → 新建空
`currentBucket`（periodStart=now）→ 立即持久化 → 触发一次 flush 尝试。
**用户继续操作不等上传**（冻结后新动作立即进新桶）。

Outbox 保证：

- APP 重启后仍存在（随 state.json 持久化）；
- 上传失败不丢（只更新 nextRetryAt）；
- **ACK 后才删除**（服务端 200 且列出 accepted/alreadyAccepted 后移除对应 batchId）；
- 容量上限 120 个 batch（≈ 120×30 = 3600 动作）：超限丢弃**最老**批次并
  `telemetry_upload_error` +1（防御性上限，正常 30min 间隔下远达不到）。

## 7. FLUSH_POLICY

触发点（全部旁路、静默）：冻结事件、`app_cold_start`、`app_resume`。

尝试流程 `attemptFlush(reason)`：

1. 无 deviceId：若 `now ≥ registerRetryAt` 先走注册；注册失败安排退避并终止本次。
2. `outbox` 为空 → 直接返回（**未满桶不冻结不上传**；轻用户最多 6h/跨日才产生一个 batch）。
3. 节流：`now - lastUploadAttemptAt < 30min` 且非「到期重试」→ 返回。
   （正常路径下两次 telemetry 网络上传 ≥ 30min；冻结后首次 flush 不受此限的唯一情形
   是它本身就是到期重试或距离上次尝试已 ≥ 30min —— 实现上统一判定。）
4. 合并 POST：取 outbox **前 20 个** batch；`JSON.stringify(body)` 预检 ≤ 128 KiB
   （超限从尾部裁剪，防御性；计数器报文实际 ~1KB/batch）。
5. 成功（200）：移除 accepted ∪ alreadyAccepted 对应批次；`lastFlushSuccessAt = now`、
   `lastUploadAttemptAt = now`、`flushAttempts = 0`、`nextRetryAt = 0`；
   若 outbox 仍有余量（>20 的长尾），`nextRetryAt = now + 1min` 立即排空，不受 30min 限制。
6. 失败：见 RETRY_POLICY。

明确不做：`setInterval` 高频轮询、逐点击 POST、后台无限唤醒、WorkManager 高频任务。

## 8. RETRY_POLICY

- 网络失败 / 5xx / 429 / 404（旧服务器）/**503（secret 缺失 fail-closed）**：
  数据留在 outbox，有限指数退避：`5min → 30min → 2h → 6h → 封顶 24h`
  乘 jitter `×[0.8, 1.2]`；成功后 `flushAttempts` 归零。
- **400（schema 拒绝）**：不高频重试 —— 服务端响应 `rejected:[{batchId, reason}]`，
  客户端**仅丢弃被拒批次**（记 `telemetry_upload_error`），其余批次按正常退避调度；
  整个请求都因 schema 被拒时不进入退避循环。
- 任何 telemetry 故障（存储抛异常、传输抛异常、逻辑异常）：
  **不影响搜题、不影响拍题、不影响 SampleQueue、不影响更新** —— 全部调用点
  swallow + console 诊断（TEL 失败隔离测试覆盖）。

## 9. TELEMETRY_API（服务端处理）

- 注册：校验 body → HMAC → 返回 deviceId；`devices` 表**不在此刻建行**（首次 batch
  才 upsert device，避免只注册不上报的僵尸行）；同 ANDROID_ID 重复注册纯计算，无副作用。
- batch：整请求一个事务（见 §10）；`rejected` 逐 batch 给原因（batchId 维度），绝无
  部分提交。
- 响应不含 DB 路径 / SQL / 堆栈；普通错误一律 `{ok:false, error:"internal error"}` + 500。
- 限流（内存固定窗口，复用现有 rateLimit）：register 10/min/IP、batch 10/min/IP，
  超限 429（正常客户端 30min 一次，余量 >100 倍）。
- body 上限：register 4 KiB、batch 128 KiB（独立于既有 sample 路由的 40MB 上限）。

## 10. TELEMETRY_SQLITE_SCHEMA（data/telemetry/telemetry.db）

初始化 PRAGMA：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、
`synchronous=NORMAL`。文件不进 Git（`data/` 整体 gitignore）。

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE devices (                       -- 只存 HMAC 后的 deviceId
  device_id     TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  first_version TEXT, last_version TEXT,
  first_channel TEXT, last_channel TEXT);

CREATE TABLE telemetry_batches (             -- raw batch 可审计 / 可重算
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL,
  device_id    TEXT NOT NULL REFERENCES devices(device_id),
  local_day    TEXT NOT NULL,
  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  version_code INTEGER, version_name TEXT, channel TEXT, package_name TEXT,
  payload      TEXT NOT NULL,              -- 规范化 JSON {counters, histograms}
  UNIQUE(device_id, batch_id));            -- ← 幂等核心

CREATE TABLE daily_device_metrics (          -- 日聚合（设备×日×指标）
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  day TEXT NOT NULL, metric_name TEXT NOT NULL, value INTEGER NOT NULL,
  PRIMARY KEY(device_id, day, metric_name));

CREATE TABLE daily_metric_values (           -- 全局日汇总（报表快查路径）
  day TEXT NOT NULL, metric_name TEXT NOT NULL,
  value INTEGER NOT NULL,                   -- SUM(daily_device_metrics.value)
  PRIMARY KEY(day, metric_name));
```

**幂等与事务**（A10）：单个 batch 上报在一个 `BEGIN IMMEDIATE … COMMIT` 内完成：

```
BEGIN IMMEDIATE
  INSERT OR IGNORE INTO telemetry_batches …    -- changes()==0 → alreadyAccepted，跳过聚合
  upsert devices（first_* 仅首见写，last_* 每次覆盖）
  对该 batch 的每个 counter/histogram 桶：
    INSERT … ON CONFLICT(device_id,day,metric_name) DO UPDATE SET value=value+excluded.value
    INSERT … ON CONFLICT(day,metric_name) DO UPDATE SET value=value+excluded.value
COMMIT
```

任一步失败 → ROLLBACK，向客户端回 500（客户端退避重试，同 batch 重传后
`UNIQUE(device_id, batch_id)` 保证 **daily value 绝不重复累加**）。
DAU/WAU/MAU 由 `daily_device_metrics` 按天 COUNT(DISTINCT device_id) 计算（精确）；
`daily_metric_values` 是纯加速汇总；`tools/telemetry/report.js --recompute` 可从
`telemetry_batches.payload` 全量重算两张聚合表（batch 可重算）。

## 11. SAMPLE_SQLITE_SCHEMA（data/samples/samples.db）

与 telemetry.db 物理分离（不做 everything.db）。**图片绝不入 SQLite BLOB**：SQLite 只存
provider / object_key / local_path（如存在）/ sha256 / size / width / height。

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE samples (
  sample_id     TEXT PRIMARY KEY,           -- YYYYMMDD_HHMMSS_hex6
  captured_at   TEXT,                       -- run.json.capturedAt
  received_at   INTEGER NOT NULL,           -- DB 首见时刻（epoch ms）
  app_version_name TEXT, version_code INTEGER, channel TEXT,   -- run.json 未携带 → NULL 预留
  page_type_mode   TEXT,                    -- run.json.pageTypeMode (auto|manual)
  detected_type    TEXT,                    -- run.json.pageType（最终展示题型）
  question_count   INTEGER,                 -- blocks.length
  confidence_high INTEGER NOT NULL DEFAULT 0,
  confidence_medium INTEGER NOT NULL DEFAULT 0,
  confidence_low  INTEGER NOT NULL DEFAULT 0,
  confidence_none INTEGER NOT NULL DEFAULT 0,
  ocr_ms INTEGER, split_ms INTEGER, match_ms INTEGER, total_ms INTEGER,
  content_hash TEXT NOT NULL,               -- 派生记录规范化摘要（幂等比较用）
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE sample_files (
  sample_id TEXT NOT NULL REFERENCES samples(sample_id),
  kind TEXT NOT NULL,                       -- 'capture'
  provider TEXT,                            -- 'cos'|'r2'|'local'
  object_key TEXT, local_path TEXT,         -- local_path 仅在文件实际存在时写
  sha256 TEXT, size INTEGER, width INTEGER, height INTEGER,
  PRIMARY KEY(sample_id, kind));

CREATE TABLE sample_blocks (                -- 依据 run.json.blocks 真实 schema
  sample_id TEXT NOT NULL REFERENCES samples(sample_id),
  block_index INTEGER NOT NULL,
  screen_number TEXT, raw_screen_number TEXT, number_source TEXT,
  detected_type TEXT, final_bank_id NUMERIC, final_answer TEXT,
  confidence TEXT, matched_by_options INTEGER,
  candidates_json TEXT,                     -- Top3 {rank,bankId,score,typeName,answer,stem}
  block_json TEXT,                          -- 原 block 全量 JSON（审计/可重建）
  PRIMARY KEY(sample_id, block_index));

CREATE TABLE sample_feedback (              -- 依据 feedback v2 真实 schema
  sample_id TEXT NOT NULL REFERENCES samples(sample_id),
  scope TEXT NOT NULL,                      -- 'page'|'block'|'legacy'
  key   TEXT NOT NULL,                      -- page: issueType; block: '<idx>:<issue>'; legacy: 'userFlag'
  value_json TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(sample_id, scope, key));
```

字段全部映射自现有 run.json / feedback.json 实际 schema（实测样例核对），不发明字段；
`app_version_*` 现版 run.json 不携带，留 NULL 列（未来客户端升级后自动填充）。

## 12. SAMPLE_DUAL_WRITE_MODEL

原则：**服务器才数据库化**。手机端 SampleQueue（capture.jpg/run.json/feedback.json/
state.json + 断网重试/原生文件流）**零改动**；Raw JSON 仍是 source-of-truth，
samples.db 只是 index + query + analytics，**Raw → DB 单向**，V1 绝不从 DB 反写 raw。

挂点（全部为 commit/feedback 成功后的旁路补写，try/catch 包裹，DB 故障只 log）：

1. **R2/COS commit 成功**（r2_store.js `commitSample` 三个成功出口：201 新提交、
   200 alreadyCommitted、200 legacy 兼容）：注入 `opts.onCommit(info)` 回调，
   `info = {sampleId, objectKey, captureSha256, captureSize, provider, manifest, dir}`。
   server.js 注入的回调调用 `samplesDb.recordSample(...)`。回调内部异常绝不影响
   commit 响应（不破坏既有链路，已上传图片安全）。
2. **legacy POST /api/sample 成功**（201/200 alreadyExists）：直接在 server.js
   handleSample 成功分支补写（provider='local'，local_path=实际落盘路径，width/height
   来自 jpegSize）。
3. **POST /api/feedback 成功**（v1 / v2 文档 / v2 set-remove 三分支）：在
   `writeFileAtomic(feedback.json)` 成功后，同一内存 state 结构化写入
   `sample_feedback`：单事务内**全量替换**（DELETE 该 sample 全部行 → 按当前 state
   重插），天然支持 set / remove / v2 全量替换三种语义，与 raw feedback.json 完全一致；
   不改变手机端 feedback protocol。

**幂等**（B5）：`recordSample` 在单事务内：

- 计算 `content_hash`（派生记录的规范化 JSON SHA256，不含时间戳列）；
- `INSERT OR IGNORE samples`；新行 → 插入 blocks/files，`inserted`；
- 已存在且 hash 相同 → no-op（`duplicate`）；
- 已存在且 hash 不同（manifest 补充上下文重传）→ 覆盖更新 + 重建 blocks，`updated`；
- 同 sampleId commit 重试：不重复 sample、不重复 blocks、不重复 feedback；
- **raw 已存在 + DB 缺失**（如 DB 曾损坏/重建）：再次 commit 或 backfill --apply
  会重新走同一 upsert，完成 DB 补写（SDB-IDEMPOTENCY 测试覆盖）。

## 13. SAMPLE_BACKFILL_MODEL（tools/sample_db/backfill.js）

- 扫描 outRoot（默认 `real_samples/`，即 `YYYY-MM-DD/<sampleId>/{capture.jpg,run.json,
  feedback.json?,state.json?}`）；**对 raw 文件严格 READ ONLY**：不移动、不删除、不改名、
  不改 mtime。
- 模式：默认 `--dry-run`（只报告，零写入）；`--apply` 才写 DB。写入走与在线双写完全
  相同的 `recordSample`/`recordFeedback`（同一幂等路径）。
- 分类计数：`scanned / valid / inserted / updated / duplicate / malformed /
  missing_capture / missing_run / feedback_count / block_count`。
- malformed（JSON 解析失败 / sampleId 与目录不符 / blocks 非数组）：**报告 + 跳过，
  绝不自动修数据、绝不写 DB**；missing_capture（有 run.json 无 capture.jpg）：仍入索引
  （run.json 是事实），file 行 provider 置空、local_path 置空（image_missing 语义由
  sample_files 行缺 capture 表达，不 cascade 删样本行）。
- 幂等：再跑一遍 → inserted=0, updated=0，全部 duplicate，无任何副作用
  （SDB-BACKFILL 测试覆盖）。

## 14. MIGRATION_MODEL

- 两个 DB 各自维护 `schema_migrations(version, applied_at)`；migrations 为代码内有序
  数组 `{version, sql[]}`，open 时在单事务内补跑缺失版本。
- V1：telemetry.db v1（§10）、samples.db v1（§11）。只追加新版本，不做 down migration；
  破坏性变更加列不删列。
- 打开失败 / 迁移失败：telemetry → 端点 503 fail-closed；samples → 双写禁用 + log；
  既有业务端点不受影响（FAILURE_MODEL）。

## 15. BACKUP_MODEL（tools/db/backup.js）

- 使用 node:sqlite **backup API**（`require("node:sqlite").backup(source, dest)`）做
  一致性快照 —— SQLite 在拷贝期间持锁，产出与 WAL 主库一致的单文件快照；
  **禁止**对活库直接裸 copy 文件。
- 先写 `data/backups/<name>-<timestamp>.db.tmp` 再原子 rename；默认备份 telemetry.db +
  samples.db 两个；`--keep N`（默认 14）按名清理最老备份。
- 输出路径 `data/backups/`（gitignore）。恢复 = 停 Collector 后用备份文件替换
  （V1 不做在线 restore 命令，报告说明）。

## 16. FAILURE_MODEL

| 故障 | 行为 |
| --- | --- |
| node:sqlite 不可用 / DB open/migrate 失败 | telemetry 端点 503 fail-closed；samples 双写禁用（log 一次）；sample/update/health 端点不受影响 |
| telemetry 写库异常（事务内） | ROLLBACK → 500（无 SQL/路径泄漏）→ 客户端退避重传，同 batch 不重复累加 |
| samples 双写异常 | log + 跳过；**commit/feedback 响应照常成功**；gap 由下次 commit 重试或 backfill --apply 补齐 |
| 客户端存储写失败 | metric 静默丢弃（绝不抛出）；不影响 UI |
| 客户端注册失败 | register 退避（复用上传退避表）；期间计数照常累积，注册成功后随下一个 batch 上报 |
| telemetry.db / samples.db 损坏 | 不自动删除；telemetry 可由备份恢复或 `--recompute` 从 batches 重建聚合；samples.db 可整库删除后用 backfill --apply 从 raw 重建 |
| 旧版 Collector（未重启）收到 telemetry 请求 | 404 → 客户端按可重试退避，数据保留，静默无感 |

## 17. PRIVACY_BOUNDARY

**Telemetry V1 绝不上传/存储**：搜索词原文、OCR 原文、题干、选项、答案文本、拍摄照片、
文件路径、ANDROID_ID 明文、用户姓名、手机号、账号、精确位置、联系人、IP 派生位置。

执行机制：

- 客户端 telemetry.js **没有任何能接收内容文本的 API**（只有计数器/直方图/逻辑搜题的
  query 短暂内存态用于去重，绝不持久化、绝不上行）；
- 服务端严格 allowlist：未知 metric 键、未知桶标签、未知顶层字段一律 400；
- 服务端不落 androidId（§3 红线），telemetry.db 无对应列（TEL-SQLITE 全表扫描断言）；
- Sample 系统的照片/OCR/run.json 不属于 Telemetry，两系统严格解耦（独立 DB、独立路由、
  独立代码模块）。

## 18. AUTH_MODEL

**选择：ANONYMOUS_STRICT_V1 + 服务端签发 deviceToken（DATA_PLATFORM_V1_1）。**

注册（register）入口匿名可用；batch 入口自 V1.1 起要求 `deviceId + deviceToken`
成对提交，token 由 register 用服务端 secret 经域分隔 HMAC 签发、timing-safe 校验，
不匹配 401/403 且零入库。匿名性语义不变：无账号、无用户身份，token 只绑定
设备指纹的 HMAC 派生值。

理由：现有 sample 写认证是编译期 BuildConfig 注入的原生 Bearer token，**刻意对 JS 不可
达**；若 telemetry 复用，就必须把 secret 硬编码进 JS/暴露给 WebView —— 直接违反
「不为了统计系统把秘密硬编码进 JS」。若为 telemetry 新增原生代理上传，则会把统计链路与
SampleQueue 的构建注入链耦合，且换 token 必须发版。Telemetry 载荷是非敏感聚合计数，
V1 采用匿名入口 + 以下补偿控制（任务书 E 节规定的全套）：

- strict schema（未知字段/键/值域全拒）、tight rate limit（10/min/IP）、
  body quota（4KiB/128KiB）、**no privileged operations**（两个只写端点，
  无读、无删、无任意键入库）、SQL 全参数绑定、单事务、时间戳 sanity、
  packageName/channel allowlist；V1.1 增加 batch 端 deviceToken 校验
  （401/403 拒绝同样消耗限流窗口）。
- 写接口面 = 2 个端点；最坏滥用后果 = 向聚合表写入合法形状的计数行（可回滚/可重算），
  无升级路径、无数据外泄面。

## 19. 文件布局（新增/修改）

```
新增  DATA_PLATFORM_V1_DESIGN.md            本文档
新增  www/js/telemetry.js                   客户端纯逻辑（Node 可测，无 DOM/网络硬依赖）
新增  android/.../TelemetryPlugin.java      getAndroidId / loadState / saveState
新增  tools/telemetry/store.js              telemetry.db（migrate/ingest/query/recompute）
新增  tools/telemetry/report.js             CLI 报表 --days N [--json] [--recompute]
新增  tools/telemetry/test_telemetry.js     TEL-SERVER / TEL-SQLITE（HTTP 级）
新增  tools/sample_db/store.js              samples.db（migrate/recordSample/recordFeedback）
新增  tools/sample_db/backfill.js           --dry-run / --apply
新增  tools/sample_db/test_sample_db.js     SDB-*（含 server 双写集成测试）
新增  tools/db/backup.js                    SQLite backup API 快照
修改  tools/sample_collector/server.js      telemetry 路由 + samples 双写挂点 + rate limit
修改  tools/sample_collector/r2_store.js    commitSample 成功出口注入 onCommit 回调（旁路）
修改  www/js/app.js                         埋点（全部 swallow）+ DEV 诊断 telemetry 组 + resume 监听
修改  www/index.html                        +1 行 <script src="js/telemetry.js">
修改  android/.../MainActivity.java         registerPlugin(TelemetryPlugin.class)
修改  tools/r2/secret_scan.js               MSQ_TELEMETRY_HMAC_KEY 真实值比对 + 赋值形态扫描
修改  .gitignore                            data/（两个 DB + backups）
```

## 20. TEST_MATRIX（任务书 G 全项 → 落点）

| 族 | 落点 | 关键断言 |
| --- | --- | --- |
| TEL-ID | test_telemetry.js + test_core.js | 同 ANDROID_ID→同 deviceId；不同→不同；客户端 deviceId 缓存/重注册；坏 ANDROID_ID 400 |
| TEL-BATCH | test_core.js | payload 形状、合并上限 20、body 上限裁剪、allowlist 客户端守卫 |
| TEL-OUTBOX | test_core.js | 30 动作冻结、6h 冻结、跨日冻结、重启恢复、ACK 删除、上限丢最老 |
| TEL-FLUSH | test_core.js | 30min 节流、冷启动/resume 触发、多 batch 合并一次 POST、长尾排空 |
| TEL-RETRY | test_core.js | 退避表+jitter 界、成功归零、400 仅丢被拒批次、503/404 可重试不丢数据 |
| TEL-PRIVACY | test_core.js | state/上行不含 query 子串、不含逐次时间线、诊断只出掩码 deviceId |
| TEL-SERVER | test_telemetry.js | secret 缺失 503（业务端点仍 200）；限流；body 上限；allowlist 400；**同 batch 重传 daily 不重复累加**；多 batch 部分非法→整请求回滚 |
| TEL-SQLITE | test_telemetry.js | WAL/外键/schema_migrations；全表扫描无 androidId 子串；payload 可审计可重算 |
| SDB-MIGRATION | test_sample_db.js | 全新建库/重开幂等/migrations 记录 |
| SDB-INGEST | test_sample_db.js | run.json 字段映射（真实样例夹具）、blocks/files/feedback 行 |
| SDB-IDEMPOTENCY | test_sample_db.js | 同 commit 双写不重复；raw 有+DB 无 → 重试补写；content_hash 变更→updated |
| SDB-FEEDBACK | test_sample_db.js | set/remove/v2 全量替换三语义与 raw 一致；全量替换清 stale 行；commit 失败注入不影响 commit 201 |
| SDB-BACKFILL | test_sample_db.js | dry-run 零写；apply 计数正确；malformed 跳过不伤库；二跑幂等 |
| SDB-BACKUP | test_sample_db.js | backup API 快照可打开且行数一致 |

回归（全量）：`node test_core.js`（含既有 COS-Q 守卫 + 新增守卫）、
`node tools/sample_collector/test_collector.js`、`node tools/sample_collector/test_r2.js`、
`node tools/cos/test_cos_v1.js`（真实 COS）、`node tools/dev_update/test_publish_cos.js`、
`node tools/dev_update/test_publish_r2.js`、`node tools/r2/secret_scan.js`、
JVM：`./gradlew.bat :app:testDebugUnitTest`（SampleQueue/Feedback/UpdateVerifier 等）。
新增测试也纳入：`node tools/telemetry/test_telemetry.js`、`node tools/sample_db/test_sample_db.js`。

## 21. 数据保留（D）与冻结面（F）

- 不改 sample image lifecycle、不改 COS/R2 生命周期；samples.db 历史 metadata 不自动
  cascade 删除；图片缺失以 sample_files 行缺失/置空表达。
- Telemetry：daily aggregate 长期保留；raw batch V1 暂不自动删除（数据量极小）。
- 冻结面零改动：OCR/splitter/matcher/AUTO/confidence/Top3/Camera/SampleQueue 语义/
  COS-R2 传输/feedback 语义/updater/startup update/CDN/stable 管线/navigation/Motion。
  Telemetry 埋点只旁路观察；samples 双写只在成功路径之后追加、失败即吞。

## 22. 一致性自审清单（设计完成后逐项核对）

1. register/batch 的字段、allowlist、上限在客户端 payload 构造与服务端校验两侧一致。
2. 幂等键 UNIQUE(device_id,batch_id) 与客户端 ACK 语义（accepted ∪ alreadyAccepted）
   闭合，重传不重复累加。
3. 客户端退避表与服务端 503/404/429/400 语义一一对应（400 只丢被拒批次）。
4. 逻辑搜题口径不会因筛选切换/清空/历史芯片产生重复或丢失计数。
5. samples 双写三挂点全部位于既有成功路径之后且异常即吞；backfill 与在线双写共用
   recordSample 单一实现（无第二套写逻辑）。
6. raw ANDROID_ID 的全部可能落点（DB/日志/错误响应/debug dump）逐一封闭。
7. node:sqlite 不可用时的降级路径覆盖 telemetry 与 samples 两处，业务端点零影响。

---

## 23. V1.1 增补（DATA_PLATFORM_V1_1_HARDEN_AND_ACTIVATE）

1. **deviceToken**（§1.1/§1.2/§18 已同步）：register 响应追加
   `deviceToken = HMAC(serverSecret, "telemetry-batch-v1:" + deviceId)`；
   batch 顶层四键 `schemaVersion/deviceId/deviceToken/batches`，服务端 timing-safe
   compare，缺 token 401、不匹配 403，均零入库；客户端对 401/403 清空凭据走
   register 退避（secret 轮换自愈）。不变项：ANDROID_ID → server HMAC → deviceId、
   raw ANDROID_ID 不落盘、匿名无账号模型。deviceToken 是 HMAC 派生物，允许进客户端
   本地 state（等价 bearer 凭据语义）；原始 secret 仍只在服务端。
2. **文档勘误**：METRIC_CATALOG_V1 counter 实际 = **38** 个（2 生命周期 + 4 文字搜题 +
   6 拍题 + 5 识别置信 + 4 AUTO + 5 反馈 + 8 学习模式 + 4 错误），V1 报告误写为 35。
   metric 集合本身零调整。
3. **激活**：生产 Collector 按端口 8787 精确定位重启后，telemetry 端点与 samples.db
   双写正式生效；`tools/sample_db/backfill.js --apply` 补录历史样本。
4. **真桥接修复（TELEMETRY_ANDROID_ID_BRIDGE_V1，vc26）**：TelemetryPlugin.getAndroidId
   resolve 的是 `{ androidId: "<16hex>" }` 对象；registerAndFlush 旧实现把整个对象
   `String()` 后上传导致服务端 400。修复：读取 `result.androidId` 并按
   `/^[0-9a-f]{16}$/i` 校验（大小写归一），任何其他形状（裸 string/null/非 hex）
   一律拒绝注册。同时：注册成功后立即续传积压 outbox（注册 ≠ batch 上传，
   30min 间隔时钟不从注册起算）；测试 mock 固定为真实 Capacitor 对象形状，
   并有源码守卫防止 `String(androidId)` / string mock 回归。
5. **统一时间门（TELEMETRY_SCHEDULER_RETRY_GATE_V1，vc28）**：上传时刻统一为
   `nextAttemptAt = max(lastUploadAttemptAt + 30min, nextRetryAt)`——retry backoff
   不再绕过 30min 节流（5min retryAt 也要等满 30min），30min 到期也不再绕过未来的
   retry backoff（2h backoff 要等满 2h）；outbox 非空且 now < nextAttemptAt 时由
   SCHEDULER_V1 唯一 timer 到点自动 attemptFlush（timer 到期重算重排，自愈）。
   长尾排空（DRAIN_TAIL_DELAY_MS 标记）同样服从统一门。诊断 uploadState 不变。
