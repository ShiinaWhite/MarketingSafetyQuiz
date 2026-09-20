# 整页拍照搜题 · 自动基准测试 harness

**用途**：在没有手抖/透视/反光/摩尔纹等真实拍摄干扰的条件下，测量当前
「整页 OCR → 分题 → 题型约束匹配 → 答案输出」链路的**准确率上限**与处理效率。

**这不是 App 功能**，只是测试基础设施；产物全部落在 `testbench/.generated/`（已 gitignore，不入库）。

---

## 0. 当前状态（重要）

| 项 | 状态 |
| --- | --- |
| 截图数据集生成 | ✅ 可在本机全自动运行 |
| 分题/匹配/比对/报告 | ✅ 可在本机全自动运行 |
| **真实 ML Kit OCR 取数** | ⛔ **BLOCKED（本机无可用 Android 运行时）** |

本机阻塞原因（实测）：

- `adb devices` 无设备；
- SDK 内无 `emulator` 包、无 `system-images`；
- `HypervisorPresent = False`、`HypervisorPlatform = Disabled`、`Microsoft-Hyper-V-All = Disabled`，
  且 `systeminfo` 报告**「固件中已启用虚拟化：否」**（BIOS 未开 VT-x）。

没有硬件虚拟化时，模拟器只能纯软件仿真，ML Kit 的 native OCR 管线在此模式下慢到不可用
（300 张图会到小时级甚至更久，且随时可能崩）；开启它需要改 BIOS + 装内核驱动 + 重启，属于系统级改动。

**因此本轮没有、也不会给出任何"真实 ML Kit 准确率"数字。** 按需求约定，禁止用其它 OCR 引擎
（Umi-OCR / Tesseract / 浏览器 OCR）替代后冒名顶替。

要在有设备的机器上出数，只需 4 条命令（见第 4 节）。

---

## 1. 环境要求

- Node ≥ 22（用到内置 WebSocket 驱动 Chrome DevTools Protocol，**无第三方依赖**）
- Chrome 或 Edge（headless）
- 一台可用 Android 设备或模拟器（仅第 4 步需要）

## 2. 生成截图数据集

```bash
node testbench/harness/generate_dataset.js              # 全量：150 页 + 补齐页 × 2 Profile
node testbench/harness/generate_dataset.js --limit 3    # 先跑 3 页看看
node testbench/harness/generate_dataset.js --profile ceiling
node testbench/harness/generate_dataset.js --source mock
```

它会：

1. 按 `pageplan.js` 的计划生成页面（5 轮 × 30 页，每轮固定 seed `2026092101`~`2026092105`）；
   题型配比：单选纯页 30% / 多选纯页 25% / 判断纯页 25% / 跨块页 20%；每页随机 5/8/10 题；
2. 统计 392 题覆盖情况，不够就用 `mustInclude` **自动补页直到 392/392**；
3. 用 headless Chrome 真实渲染 `harness/render.html`（真实字体、抗锯齿、换行、行距、DOM 布局），
   按元素尺寸精确截图；
4. 输出：

```
testbench/.generated/
  images/ceiling/R1P01.png      PNG 无损、1:1 像素（Profile A：理论上限）
  images/app_ideal/R1P01.jpg    JPEG q85、宽 2000px（Profile B：与 App 整页 Camera 设置一致）
  groundtruth/R1P01.json        该页 Ground Truth
  manifest.json                 页面清单 + 配置 + 覆盖统计
```

两个 Profile 用**同一批页面**，只改成像条件，因此可以直接对比"成像损失"。

> Profile B 的 `width: 2000 / quality: 85` 取自 App 整页拍照的实际 Camera 参数
> （`www/js/app.js` 的 `startBatchPageSearch`）。App 侧参数若变更，这里要同步。

## 3. 在设备上跑 ML Kit OCR

```bash
adb push testbench/.generated/images /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/images

cd android
gradlew.bat :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.profile=ceiling
gradlew.bat :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.profile=app_ideal

adb pull /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/ocr testbench/.generated/ocr
```

`OcrBatchBenchmarkTest` 用的是**与 `OcrPlugin` 完全相同的识别内核**：
`TextRecognition` + `ChineseTextRecognizerOptions`（bundled 中文模型），行的展平与排序规则
也照搬 `OcrPlugin.flattenLines/sortReadingOrder`。它不启动相机（本轮不测相机），只做
`Image → OCR → text + lines + boundingBox`，并记录设备型号/API/ML Kit 版本/预热耗时。

输出 `ocr/<profile>.jsonl`，一行一张图：`{file, ms, width, height, text, lines[]}`，首行为元信息。

> 一定要带 `:app:` 前缀。不带前缀的 `connectedDebugAndroidTest` 会连带构建
> Capacitor 自动生成的 `capacitor-cordova-android-plugins` 模块的 androidTest 变体，
> 该模块存在**与本 harness 无关的既有问题**（kotlin-stdlib 1.8.22 与 kotlin-stdlib-jdk7/jdk8 1.6.21
> 重复类，`checkDebugAndroidTestDuplicateClasses` 失败）。`gradlew :app:assembleDebugAndroidTest`
> 已验证可正常构建出含本 harness 的测试 APK。

## 4. 出报告

```bash
node testbench/harness/run_benchmark.js --both
```

链路：ML Kit lines → `MSQ.splitPageOcrLines` → `MSQ.searchPageQuestionsByOcr`
（用的是 `www/js/core.js` 里 App 当前实际代码，不改一行）→ 与 Ground Truth 比对。

产出：

```
testbench/.generated/reports/ceiling_report.json
testbench/.generated/reports/app_ideal_report.json
testbench/.generated/reports/baseline_summary.md
testbench/.generated/failures/<profile>/<pageId>.json   失败样本完整证据
```

指标：`PAGE_OCR_SUCCESS_RATE`、`PAGE_SPLIT_COUNT_ACCURACY`、`SCREEN_NUMBER_ACCURACY`、
`TYPE_ACCURACY`、`TOP1/TOP3_MATCH_ACCURACY`、`ANSWER_ACCURACY`（界面显示，低置信度算 `?`）、
`ANSWER_ACCURACY_RAW`、置信度分布与各级错误数、`HIGH_CONFIDENCE_WRONG`、
`CONFIDENCE_FALSE_NEGATIVE`（匹配对却显示 `?`）、耗时 mean/p50/p90/p95/max 与吞吐。

失败分类：`OCR_TEXT_ERROR` / `QUESTION_NUMBER_ERROR` / `SPLIT_ERROR` / `TYPE_ERROR` /
`MATCH_ERROR` / `CONFIDENCE_ERROR` / `ANSWER_UI_ERROR` / `UNCLASSIFIED`。

## 5. harness 自检（不需要设备）

```bash
node testbench/harness/run_benchmark.js --selftest --profile ceiling
```

用 Ground Truth 文本合成"完美 OCR"行，只为验证分题/匹配/比对/报告链路本身没坏。
产物一律带 `NOT_MLKIT` 后缀并在终端高亮提示，**绝不可当作 OCR 准确率引用**。

## 6. 单元测试

```bash
node testbench/test_bench.js          # 页面生成/Ground Truth/基准（71 项）
node testbench/test_bench_report.js   # 统计/百分位/失败分类/汇总/报告（59 项）
```

## 7. 约定与红线

- 不修改 App 的 OCR 算法、分题算法、匹配权重、置信度阈值与业务逻辑；harness 只读 `www/js/core.js`。
- 不把 DOM 文字喂给匹配算法冒充 OCR；headline 指标只能来自 ML Kit。
- 不把 `private_questions.json`、截图、Ground Truth、OCR 输出、报告里的真实题目文字提交到公开仓库。
