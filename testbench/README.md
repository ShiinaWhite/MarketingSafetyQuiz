# Batch OCR Test Bench（仿真考试页 / 整页 OCR 测试台）

一个**纯测试工具**：在电脑浏览器上生成"像真实机考界面"的考试页 → 手机拍屏 → 用 App 的
**整页拍照搜题**识别 → 回到测试台对照 **Ground Truth**，10 秒内判断分题、题号、题型、答案是否正确。

- 只做测试，**不是 App 功能**，**不参与 APK 打包**（`cap sync` 只复制 `www/`）。
- 与正式 App **完全隔离**：不引用、不修改 `www/` 与 `android/` 的任何代码。
- 无框架、无联网依赖：纯 HTML + CSS + Vanilla JS。
- 页面文字是**真实 DOM 文字**（不是 canvas 画出来的图），电脑显示效果接近普通考试系统。

```
testbench/
  index.html              仿真考试页 + 控制面板
  style.css
  app.js                  界面逻辑
  bench-core.js           核心纯函数（可被 Node 直接 require）
  mock_questions.json     公开模拟题库（自造题，可提交）
  private_questions.json  本机真实题库（.gitignore，禁止提交）
  test_bench.js           Node 单元测试
  README.md
```

---

## 1. 如何启动

浏览器直接双击 `index.html`（`file://`）可以跑 mock 数据，但**读取 private_questions.json 需要 HTTP**
（浏览器禁止 `file://` 下的 fetch）。用 Python 自带模块起一个静态服务即可，**不需要任何 Node 服务端框架**：

```bash
cd testbench
python -m http.server 8000
# 然后浏览器打开 http://127.0.0.1:8000/index.html
```

> 想在仓库根目录起服务也行：`python -m http.server 8000`，访问
> `http://127.0.0.1:8000/testbench/index.html`。

## 2. 如何使用 mock 数据

`mock_questions.json` 是**自造的公开模拟题库**（50 余题，含单选/多选/判断，部分带
`tag: "long-stem"` / `tag: "long-option"` 用于长题干、长选项压力测试），与真实考试题库无关，可以随仓库提交。

控制面板「数据源」选 **mock（公开模拟题）** 即用它。默认就是这个。

## 3. 如何使用 private_questions.json（本机真实题库）

1. 把本机真实题库复制过来（仓库里的真实题库文件本身已被 gitignore，不要提交）：

   ```bash
   cp www/data/questions.json testbench/private_questions.json
   ```

2. 用 HTTP 方式启动（见第 1 节），控制面板「数据源」里会出现
   **private（本机真实题库 392 题）**，选中即用。

3. `private_questions.json` 已在 `.gitignore` 中（`git check-ignore -v testbench/private_questions.json` 可验证），
   **导出的 Ground Truth JSON 也只保存在你本机**，不会进入 git。

数据源结构兼容：`{ "questions": [...] }` 与纯数组 `[...]` 都支持；答案支持 `[2,3]`、`["B","C"]`、
`"BC"`，判断题支持 `[0]/[1]`、`"√"/"×"`、`"正确"/"错误"`。题目里的多余字段（如 `major`）会被忽略。

## 4. 如何选择固定 seed

「随机种子」是一个整数，**同一个 seed + 同一套配置永远生成完全相同的一页**，所以调完算法可以复测同一张图。

- 手动：在「随机种子」里填整数，点「重新生成页面」。
- 用基准：在「固定基准」里选 `B01`~`B09`，seed 与显示配置都会自动填好。
- 用网址直接打开某个基准（方便反复复测）：

  ```
  http://127.0.0.1:8000/index.html?benchmark=B07
  http://127.0.0.1:8000/index.html?benchmark=B04&seed=12345
  ```

  其它可用参数：`seed` / `count` / `type` / `start` / `mode` / `source=private`。

## 5. 如何生成跨块页面

真实考试同一大块连续成块，一页最多在中间换一次大块。控制面板「页面模式」：

| 模式 | 效果 |
| --- | --- |
| 普通页（单一题型） | 整页同一题型 |
| 单选 → 多选 跨块 | 前 N 题单选，中间出现「二、多项选择题…」大标题，后面是多选 |
| 多选 → 判断 跨块 | 前 N 题多选，中间出现「三、判断题…」大标题，后面是判断 |

N 由「跨块切分点」控制（默认取一半）。例如切分点 4、起始题号 38、每页 8 题 →
`38 39 40 41` 单选 + 大标题 + `42 43 44 45` 多选。

## 6. 如何打开 Ground Truth

**默认隐藏**，避免手机拍屏时把答案一起拍进去。

点控制面板「**显示标准答案**」→ 右侧弹出 Ground Truth 面板，表格逐行给出
`题号 / 题型 / bankId / 答案 / 题干`；点「关闭」或按 `Esc` 收起。

导出：
- **复制 Ground Truth JSON** —— 复制到剪贴板（浏览器不允许时提示在 JSON 框里手动复制）。
- **下载 Ground Truth JSON** —— 下载 `groundtruth_<基准>_seed<seed>.json`，只存在你本机。

JSON 内容只有 `seed / mode / source / count / startNumber / pool / benchmark / display / questions[]`，
不含任何用户信息。

## 7. 推荐手机拍摄距离

- 电脑屏幕亮度调高、关闭护眼/夜间模式，浏览器缩放 100%（或直接用测试台的「页面缩放」预设）。
- 手机横屏、与屏幕**基本平行**，避免斜拍产生梯形畸变；距离以**整页四边都留一点白边**为准，
  一般 **25~40cm**（14 寸笔记本约 30cm，24 寸显示器约 50~60cm）。
- 对焦清楚、手不要抖，避免屏幕反光（可稍微侧一点角度或调低屏幕亮度）。
- 拍摄后确认画面里**没有** Ground Truth 面板、浏览器地址栏、书签栏等无关文字。

## 8. 推荐测试流程

```
生成固定测试页（选基准或固定 seed）
  → 隐藏 Ground Truth
  → 手机拍电脑屏幕
  → App「搜题 → 📄 整页拍照搜题」选题型后拍摄整页
  → 打开 Ground Truth
  → 对照 screenNumber / type / bankId / answer
```

对照要点（App 端「本页识别 N 道题」那行）：
1. **分题数量**与 Ground Truth 行数是否一致；
2. **题号**是否与卷面一致（`31 32 33…`），错号会直接影响对应关系；
3. **题型**：跨块页里大标题之后的行是否自动变成另一种题型（App 会在行上打题型标签）；
4. **答案**：App 显示的答案与 Ground Truth 的答案是否一致，低置信度显示 `?` 属正常（点开看 Top3 候选）。

## 9. 固定基准（seed 固化，可复测）

| 基准 | 名称 | seed | 题型/模式 | 题数 | 起始题号 | 主要显示配置 |
| --- | --- | --- | --- | --- | --- | --- |
| B01 | 标准单选5题 | 20260901 | 单选 | 5 | 1 | 默认 |
| B02 | 标准多选5题 | 20260902 | 多选 | 5 | 51 | 默认 |
| B03 | 标准判断8题 | 20260903 | 判断 | 8 | 66 | 默认 |
| B04 | 单选10题密集 | 20260904 | 单选 | 10 | 31 | 小字号 + 紧行距 + 紧间距 + 不缩进 |
| B05 | 长题干换行 | 20260905 | 单选（长题干池） | 5 | 11 | 默认 |
| B06 | 长选项换行 | 20260906 | 单选（长选项池） | 5 | 21 | 选项缩进 |
| B07 | 单选→多选跨块 | 20260907 | 跨块（切分点 4） | 8 | 38 | 默认 |
| B08 | 多选→判断跨块 | 20260908 | 跨块（切分点 4） | 8 | 58 | 默认 |
| B09 | 导航干扰页 | 20260909 | 单选 | 8 | 71 | 小字号 + 导航干扰文字 |

> 与需求里的 A~H 预设对应关系：A→B01、B→B04、C→B04（更密）、D→B05、E→B06、F→B07、G→B08、H→B09。

## 10. 核心逻辑与自动比对

`bench-core.js` 是纯函数模块，浏览器里是 `window.Bench`，Node 里可 `require`：

- `buildPage(spec)` —— 按 `seed/type/count/startNumber/mode/splitAt/pool` 生成一页（题目 + 大块结构）
- `buildGroundTruth(page, spec)` —— 与页面**同源**生成标准答案
- `compareBatchResult(appResult, groundTruth)` —— 预留给以后真机对接：

  ```js
  compareBatchResult(
    [{ screenNumber: 31, matchedId: 118, type: "single", answer: "B" }, ...],
    groundTruth
  )
  // -> { total, screenNumberCorrect, typeCorrect, top1Correct, answerCorrect,
  //      answerCorrectStrict, orderCorrect, pageSplitCountCorrect, missing, extra, details }
  ```

  第一版只做纯函数，不与手机自动通信。

## 11. 单元测试

```bash
node testbench/test_bench.js
```

覆盖：同 seed 可复现、不同 seed 出不同题、每页题数、题号连续、题型正确、跨块切换位置、
Ground Truth 与页面一致、答案与源题库真值一致、mock/private 结构兼容、`compareBatchResult` 各种情况、
9 个基准配置与复现性。

## 12. 隔离与提交约束

- 本目录**不参与** App 构建：`npx cap sync android` 只复制 `www/`，`testbench/` 不会进 APK。
- 不修改 App 的搜索算法、整页 OCR 代码、单题 OCR、Android 插件、题库、V2 解析。
- 可以提交：`index.html` / `style.css` / `app.js` / `bench-core.js` / `mock_questions.json` / `test_bench.js` / `README.md`。
- **禁止提交**：`private_questions.json`（已 gitignore）及任何真实题库导出物。
