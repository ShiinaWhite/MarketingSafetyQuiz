# Sample Collector（真实样本接收器）

局域网真实样本采集通道的 PC 端。零第三方依赖，仅 Node 标准库。

```bash
node tools/sample_collector/server.js            # 默认 0.0.0.0:8787，输出到 <仓库>/real_samples
node tools/sample_collector/server.js --port 8787 --out D:/somewhere --host 0.0.0.0
node tools/sample_collector/test_collector.js    # 自检（临时目录，不碰 real_samples）
```

启动后按提示把 `http://<PC的局域网IP>:8787` 填进 App 的
「搜题 → 📷 → 测试样本采集 → 服务器地址」，打开「自动上传测试样本」，点「测试连接」。

## 目录格式

```
real_samples/
  2026-09-23/                        # 由 sampleId 前缀派生
    20260923_171530_ab12cd/
      capture.jpg    # 当次实际送进 Ocr.recognizeText 的 JPEG 字节（SHA256 见 run.json）
      run.json       # schemaVersion=1：OCR 原文+行坐标、分题、Top3+分数、confidence、最终答案、耗时
      feedback.json  # （可选）App 内「⚑ 标记本页有问题」产生，人工标注前的问题反馈
      label.json     # （未来人工标注，本工具不生成）
```

## 三层概念（V1 起就不混）

- `capture.jpg` = 真实输入（可离线重放 OCR）
- `run.json` = 当时的程序输出（actual，不含 expectedBankId，不猜正确答案）
- `label.json` = 人工真值（未来 benchmark 用）

## 安全边界

- sampleId 严格 `YYYYMMDD_HHMMSS_hex6`，目录名由它派生，无路径穿越；
- 只接受 `image/jpeg` base64 data URL；body ≤ 40MB；重复 sampleId 409 拒绝覆盖；
- 临时文件 + rename 原子落盘；不执行上传内容；无任意文件读取接口；
- CORS 仅限本工具用途（Android WebView 预检）。

## 实机/模拟器链路自检（可选）

Android 侧有 instrumented 端到端测试 `SampleCollectorE2ETest`（先启动接收器再跑）：

```bash
# 实机（先填 PC 局域网 IP；连接设备后）：
cd android && gradlew.bat :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.jty.safetyquiz.SampleCollectorE2ETest \
  -Pandroid.testInstrumentationRunnerArguments.collectorUrl=http://<PC-LAN-IP>:8787

# 模拟器：省略 collectorUrl（默认宿主地址 http://10.0.2.2:8787）
```

测试会验证：采集 UI 存在且默认 OFF、CapacitorHttp 可用、测试连接成功、
fixture 样本上传落盘且 SHA256 与字节一致（PC 端 real_samples 下核对 run.json）。

## Android 侧明文 HTTP 策略

WebView 页面源是 `https://localhost`，App 用 CapacitorHttp（原生 OkHttp）发起上传，
不受 WebView 混合内容限制，只受平台明文策略约束。
`android/app/src/debug/AndroidManifest.xml` 仅在 debug 构建声明
`android:usesCleartextTraffic="true"`；release 不合并该 overlay，保持禁止明文。
