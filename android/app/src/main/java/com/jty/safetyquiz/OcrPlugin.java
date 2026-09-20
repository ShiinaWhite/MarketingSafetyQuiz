package com.jty.safetyquiz;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

/**
 * 本地 OCR 插件：ML Kit Text Recognition v2 中文（bundled 模型，随 APK 分发，离线可用）。
 * 输入 base64 图片（JPEG），输出识别全文与耗时。
 */
@CapacitorPlugin(name = "Ocr")
public class OcrPlugin extends Plugin {

    @PluginMethod
    public void recognizeText(PluginCall call) {
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
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bitmap == null) {
            call.reject("DECODE_FAILED");
            return;
        }
        long start = System.currentTimeMillis();
        try {
            InputImage image = InputImage.fromBitmap(bitmap, 0);
            TextRecognizer recognizer = TextRecognition.getClient(
                    new ChineseTextRecognizerOptions.Builder().build());
            Text text = Tasks.await(recognizer.process(image));
            recognizer.close();
            JSObject ret = new JSObject();
            ret.put("text", text.getText());
            ret.put("ms", System.currentTimeMillis() - start);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("OCR_FAILED", e.getMessage());
        }
    }
}
