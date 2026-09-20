package com.jty.safetyquiz;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 整页 OCR 基准测试 harness（测试代码，不属于 App 业务逻辑）。
 *
 * 用途：把电脑端生成的仿真考试页截图送入**与 OcrPlugin 完全相同的 ML Kit 中文识别内核**，
 * 导出每张图的 text + lines + boundingBox 供 Node 侧跑分题/匹配/比对。
 *
 * 与 OcrPlugin 的一致性：同样是 TextRecognition + ChineseTextRecognizerOptions（bundled 中文模型），
 * 行的排序规则也照搬 OcrPlugin.sortReadingOrder（按 top 分行、行内按 left）。
 * 本类不修改任何 App 代码，只在 androidTest 里新增。
 *
 * 运行：
 *   adb push testbench/.generated/images /sdcard/Android/data/com.jty.safetyquiz/files/benchmark/images
 *   gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.profile=ceiling
 * 产物：/sdcard/Android/data/com.jty.safetyquiz/files/benchmark/ocr/<profile>.jsonl
 */
@RunWith(AndroidJUnit4.class)
public class OcrBatchBenchmarkTest {

    private static final String TAG = "OcrBenchmark";
    /** 与 android/app/build.gradle 中 text-recognition-chinese 版本保持一致 */
    private static final String MLKIT_DEP = "com.google.mlkit:text-recognition-chinese:16.0.1";
    private static final long PER_IMAGE_TIMEOUT_SEC = 60;

    @Test
    public void runBatchOcr() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File base = ctx.getExternalFilesDir(null);
        if (base == null) { throw new IllegalStateException("外部私有目录不可用"); }

        android.os.Bundle args = InstrumentationRegistry.getArguments();
        String profile = args.getString("profile", "ceiling");
        String inRel = args.getString("inDir", "benchmark/images/" + profile);
        String outRel = args.getString("outFile", "benchmark/ocr/" + profile + ".jsonl");

        File inDir = new File(base, inRel);
        File outFile = new File(base, outRel);
        File parent = outFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("无法创建输出目录 " + parent);
        }
        if (!inDir.isDirectory()) { throw new IllegalStateException("找不到图片目录 " + inDir); }

        List<File> images = new ArrayList<>();
        File[] all = inDir.listFiles();
        if (all != null) {
            for (File f : all) {
                String n = f.getName().toLowerCase();
                if (n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg")) { images.add(f); }
            }
        }
        Collections.sort(images, new Comparator<File>() {
            @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
        });
        if (images.isEmpty()) { throw new IllegalStateException(inDir + " 里没有图片"); }
        Log.i(TAG, "profile=" + profile + " 图片 " + images.size() + " 张");

        TextRecognizer recognizer = TextRecognition.getClient(
                new ChineseTextRecognizerOptions.Builder().build());
        BufferedWriter w = new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(outFile, false), StandardCharsets.UTF_8));
        try {
            /* 元信息：设备 / 系统 / ML Kit 版本 / 预热耗时（模型加载只发生一次，不计入正式计时） */
            JSONObject header = new JSONObject();
            header.put("header", true);
            header.put("profile", profile);
            header.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            header.put("sdkInt", Build.VERSION.SDK_INT);
            header.put("release", Build.VERSION.RELEASE);
            header.put("mlkit", MLKIT_DEP);
            header.put("imageCount", images.size());
            header.put("startedAt", System.currentTimeMillis());
            long warmStart = System.currentTimeMillis();
            Bitmap warm = BitmapFactory.decodeFile(images.get(0).getAbsolutePath());
            if (warm != null) {
                Tasks.await(recognizer.process(InputImage.fromBitmap(warm, 0)),
                        PER_IMAGE_TIMEOUT_SEC, TimeUnit.SECONDS);
                warm.recycle();
            }
            header.put("warmupMs", System.currentTimeMillis() - warmStart);
            w.write(header.toString());
            w.newLine();

            for (File f : images) {
                JSONObject o = new JSONObject();
                o.put("file", f.getName());
                o.put("profile", profile);
                Bitmap bmp = null;
                try {
                    bmp = BitmapFactory.decodeFile(f.getAbsolutePath());
                    if (bmp == null) {
                        o.put("err", "DECODE_FAILED");
                    } else {
                        o.put("width", bmp.getWidth());
                        o.put("height", bmp.getHeight());
                        long t0 = System.currentTimeMillis();
                        Text text = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)),
                                PER_IMAGE_TIMEOUT_SEC, TimeUnit.SECONDS);
                        o.put("ms", System.currentTimeMillis() - t0);
                        o.put("text", text.getText());
                        o.put("lines", flattenLines(text));
                    }
                } catch (Exception e) {
                    o.put("err", e.getClass().getSimpleName() + ": " + e.getMessage());
                } finally {
                    if (bmp != null) { bmp.recycle(); }
                }
                w.write(o.toString());
                w.newLine();
            }
        } finally {
            try { w.close(); } catch (Exception ignored) { }
            recognizer.close();
        }
        Log.i(TAG, "完成，输出 " + outFile.getAbsolutePath());
    }

    /** 与 OcrPlugin.flattenLines / sortReadingOrder 相同的展平与排序规则 */
    private JSONArray flattenLines(Text text) throws Exception {
        List<JSONObject> items = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                String lineText = line.getText();
                if (lineText == null || lineText.trim().isEmpty()) { continue; }
                JSONObject o = new JSONObject();
                o.put("text", lineText);
                Rect r = line.getBoundingBox();
                if (r != null) {
                    o.put("left", r.left);
                    o.put("top", r.top);
                    o.put("right", r.right);
                    o.put("bottom", r.bottom);
                }
                items.add(o);
            }
        }
        Collections.sort(items, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(a.optInt("top", 0), b.optInt("top", 0));
            }
        });
        List<JSONObject> out = new ArrayList<>(items.size());
        int i = 0;
        while (i < items.size()) {
            int rowTop = items.get(i).optInt("top", 0);
            List<JSONObject> row = new ArrayList<>();
            while (i < items.size()) {
                JSONObject o = items.get(i);
                int top = o.optInt("top", 0);
                int height = o.optInt("bottom", top) - top;
                int tol = Math.max(8, height / 2);
                if (top - rowTop > tol) { break; }
                row.add(o);
                i++;
            }
            Collections.sort(row, new Comparator<JSONObject>() {
                @Override public int compare(JSONObject a, JSONObject b) {
                    return Integer.compare(a.optInt("left", 0), b.optInt("left", 0));
                }
            });
            out.addAll(row);
        }
        JSONArray arr = new JSONArray();
        for (JSONObject o : out) { arr.put(o); }
        return arr;
    }

    /** 便于本地调试：直接读取一个已 push 的图片目录并打印前几行结果 */
    @SuppressWarnings("unused")
    private static List<String> readLines(File f) throws Exception {
        List<String> out = new ArrayList<>();
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) { out.add(line); }
        r.close();
        return out;
    }

    @SuppressWarnings("unused")
    private static final List<String> EXT = Arrays.asList(".png", ".jpg", ".jpeg");
}
