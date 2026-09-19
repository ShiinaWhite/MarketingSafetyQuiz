# 营销安规刷题（MarketingSafetyQuiz）

完全离线的营销安规刷题器：纯前端 Web/PWA 应用（原生 HTML/CSS/JS，无框架），
通过 Capacitor 打包为 Android APK 侧载安装。无账号、无服务器、无网络请求、无遥测、无广告。

> **本项目不附带任何题库数据。** 请使用你自己的题库 Excel 运行导入脚本生成
> `www/data/questions.json`（该文件不进入 Git 历史）。

## 功能

- 八种模式：顺序刷题 / 随机刷题 / 单选专项 / 多选专项 / 判断专项 / 错题重做 / 背题模式 / 模拟考试
- 单选、判断点击选项直接判分；多选选完点“提交答案”，所选集合与答案集合完全一致才算正确
- 提交后正确选项标绿、错选标红，显示“回答正确/错误”与标准答案；支持左右滑动切换题目
- 背题模式直接高亮正确答案，便于快速记忆
- 学习记录保存在浏览器 localStorage（键 `msq.progress.v1`）：每题作答/正确/错误次数、
  错题本（答对自动移出）、各模式刷题进度；提供“清除学习记录”（二次确认）
- 模拟考试：默认 单选 40×1 分 + 多选 15×2 分 + 判断 30×1 分 = 85 题 / 100 分；
  数量与分值可在 `www/data/config.js` 修改（应用内“模拟考试设置”亦可，受题库容量上限校验）；
  答题过程不显示对错，交卷二次确认后给出总分与各题型正确率，可查看本次错题、重新组卷
- PWA：manifest + Service Worker，通过 HTTP(S) 打开一次后可完全离线使用

## 目录结构

```
www/                  Web 应用（index.html / css / js / sw.js / manifest / icons）
  js/core.js          纯逻辑：答案集合判定、组卷、计分（UMD，Node 可直接测试）
  js/app.js           界面、localStorage 存储、滑动切换、模式调度
  data/config.js      模拟考试默认配置（数量/分值，可修改）
tools/import_xlsx.py  题库导入脚本（Excel → JSON）
test_core.js          Node 逻辑自检
android/              Capacitor Android 工程
```

`www/data/questions.json`、`www/data/questions.js` 由导入脚本生成，不随仓库分发。

## 安装依赖

- 运行 Web 版本身零依赖（浏览器打开即用）
- 导入题库：Python 3.8+ 与 openpyxl（`pip install openpyxl`）
- 构建 APK：Node.js 18+、JDK 21、Android SDK（含 platform；本项目用 Capacitor 8）

## 导入题库

准备一个 xlsx 题库，列结构为：**A列 序号｜B列 专业｜C列 题型｜D列 题目｜E列 选项｜F列 答案**。
题型支持“单选题/多选题/判断题”，选项按 `A.~F.` 标签边界解析（数量不限，已验证 3~6 个选项），
答案列支持 `A`~`F` 字母及其组合（如 `ABD`），判断题为 `A. 正确 / B. 错误`。

```bash
python -X utf8 tools/import_xlsx.py 20260210营销安规题库.xlsx
# 或不带参数：自动在当前目录 / 仓库根目录查找第一个 .xlsx
```

脚本会打印题型数量统计与抽样解析结果，选项或答案解析失败的行会导致导入失败并逐条报告，
便于先修正数据。生成的数据文件仅保存在本机 `www/data/`。

## 在浏览器运行

```bash
python -m http.server 8808 --directory www
# 浏览器打开 http://127.0.0.1:8808
```

首次通过 HTTP(S) 打开后 Service Worker 会缓存全部资源，之后断网也能使用。
也可以直接双击 `www/index.html`（题库以内联脚本方式加载，file:// 下同样可用；
注意 file:// 下 PWA 离线缓存不可用，这是浏览器安全策略限制）。

## 构建 Android APK

```bash
npm install                 # 安装 @capacitor/core / cli / android
python -X utf8 tools/import_xlsx.py <你的题库.xlsx>   # 生成题库数据
npx cap sync android        # 把 www 同步进 Android 工程（必须）
cd android
# 需要本机 JDK 21 与 Android SDK（可用 ANDROID_HOME 或 local.properties 指定 sdk.dir）
gradlew.bat assembleDebug
# 产物: android/app/build/outputs/apk/debug/app-debug.apk
```

应用名称“营销安规刷题”，包名 `com.jty.safetyquiz`（见 `capacitor.config.json`）。
Debug 签名，可直接侧载安装；请勿把签名密钥提交进仓库。

## 自检

```bash
node test_core.js           # 题库结构、答案判定（多选集合相等/少选/多选/错选均判错）、
                            # 组卷 85 题/满分 100、数量上限、随机刷题调用链
```
