#!/bin/bash
# 分辨率扫描驱动：生成 → 推送 → 设备 OCR → 拉取（每档顺序执行）
set -e
cd /d/workSpace/MarketingSafetyQuiz
export MSYS_NO_PATHCONV=1
export ANDROID_HOME="D:/workSpace/MarketingSafetyQuiz/_build/android-sdk"
A="$ANDROID_HOME/platform-tools/adb.exe"
S="emulator-5570"
for P in "$@"; do
  echo "===== [$P] 生成截图 ====="
  node testbench/harness/generate_dataset.js --profile "$P" 2>&1 | grep -E "完成|失败" | tail -1
  echo "===== [$P] 推送 ====="
  "$A" -s $S push "testbench/.generated/images/$P" "/data/local/tmp/benchmark/images/$P" 2>&1 | tail -1
  echo "===== [$P] 设备 OCR ====="
  "$A" -s $S shell "am instrument -w -e profile $P -e inDir /data/local/tmp/benchmark/images/$P -e outFile /data/data/com.jty.safetyquiz/files/benchmark/ocr/$P.jsonl com.jty.safetyquiz.test/androidx.test.runner.AndroidJUnitRunner" 2>&1 | tail -1
  "$A" -s $S exec-out run-as com.jty.safetyquiz cat "/data/data/com.jty.safetyquiz/files/benchmark/ocr/$P.jsonl" > "testbench/.generated/ocr/$P.jsonl"
  N=$(grep -c '"file"' "testbench/.generated/ocr/$P.jsonl" || true)
  echo "===== [$P] 完成：$N 张 ====="
done
