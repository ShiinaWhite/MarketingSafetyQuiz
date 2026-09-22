package com.jty.safetyquiz;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 本地 OCR 插件：ML Kit Text Recognition v2 中文（bundled 模型，随 APK 分发，离线可用）。
 * 输入 base64 图片（JPEG），可选 0~1 归一化 crop 矩形：
 *   传 crop → 先按 EXIF 归一化方向解码，再按原图实际像素尺寸原生裁剪（无二次 JPEG 压缩），
 *   返回的 width/height/lines 全部以裁剪后的位图为坐标系，lines 按阅读顺序排列；
 *   不传 crop → 整图 OCR，行为与旧版本完全一致。
 * 使用 ML Kit 异步回调，不阻塞调用线程；成功/失败均关闭 recognizer。
 */
@CapacitorPlugin(name = "Ocr")
public class OcrPlugin extends Plugin {

    @PluginMethod
    public void recognizeText(final PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("EMPTY_IMAGE");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("DECODE_FAILED", e.getMessage());
            return;
        }
        JSObject crop = call.getObject("crop");
        final Bitmap working;
        final int origW;
        final int origH;
        try {
            Bitmap normalized = OcrBitmap.decodeNormalized(bytes, getContext().getCacheDir());
            if (normalized == null) {
                call.reject("DECODE_FAILED");
                return;
            }
            origW = normalized.getWidth();
            origH = normalized.getHeight();
            if (crop != null && crop.has("left") && crop.has("top")
                    && crop.has("right") && crop.has("bottom")) {
                working = OcrBitmap.cropNormalized(normalized,
                        crop.getDouble("left"), crop.getDouble("top"),
                        crop.getDouble("right"), crop.getDouble("bottom"));
                normalized.recycle();
            } else {
                working = normalized;
            }
        } catch (Exception e) {
            call.reject("CROP_FAILED", e.getMessage());
            return;
        }
        final long start = System.currentTimeMillis();
        InputImage image = InputImage.fromBitmap(working, 0);
        final TextRecognizer recognizer = TextRecognition.getClient(
                new ChineseTextRecognizerOptions.Builder().build());
        recognizer.process(image)
                .addOnSuccessListener(text -> {
                    recognizer.close();
                    JSObject ret = new JSObject();
                    ret.put("text", text.getText());
                    ret.put("ms", System.currentTimeMillis() - start);
                    ret.put("width", working.getWidth());
                    ret.put("height", working.getHeight());
                    ret.put("origWidth", origW);
                    ret.put("origHeight", origH);
                    ret.put("lines", flattenLines(text));
                    working.recycle();
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> {
                    recognizer.close();
                    working.recycle();
                    call.reject("OCR_FAILED", e.getMessage());
                });
    }

    /** 展平 TextBlock -> Line，按阅读顺序（先按 top 分行，行内按 left）。 */
    private JSArray flattenLines(Text text) {
        List<JSObject> items = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                String lineText = line.getText();
                if (lineText == null || lineText.trim().isEmpty()) {
                    continue;
                }
                JSObject o = new JSObject();
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
        sortReadingOrder(items);
        JSArray arr = new JSArray();
        for (JSObject o : items) {
            arr.put(o);
        }
        return arr;
    }

    /**
     * 阅读顺序：先按 top 升序分行（同一视觉行允许 top 有半个行高的抖动，
     * 避免两栏/同一行左右两段因几像素差异被拆开），行内再按 left 升序。
     */
    private void sortReadingOrder(List<JSObject> items) {
        Collections.sort(items, new Comparator<JSObject>() {
            @Override
            public int compare(JSObject a, JSObject b) {
                return Integer.compare(a.optInt("top", 0), b.optInt("top", 0));
            }
        });
        List<JSObject> out = new ArrayList<>(items.size());
        int i = 0;
        while (i < items.size()) {
            int rowTop = items.get(i).optInt("top", 0);
            List<JSObject> row = new ArrayList<>();
            while (i < items.size()) {
                JSObject o = items.get(i);
                int top = o.optInt("top", 0);
                int height = o.optInt("bottom", top) - top;
                int tol = Math.max(8, height / 2);
                if (top - rowTop > tol) {
                    break;
                }
                row.add(o);
                i++;
            }
            Collections.sort(row, new Comparator<JSObject>() {
                @Override
                public int compare(JSObject a, JSObject b) {
                    return Integer.compare(a.optInt("left", 0), b.optInt("left", 0));
                }
            });
            out.addAll(row);
        }
        items.clear();
        items.addAll(out);
    }
}
