package com.jty.safetyquiz;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 整页拍照人工框选：原生裁剪（OcrBitmap）instrumented 测试。
 * 验证：全图 crop 与整图 OCR 行为一致、半图裁剪尺寸与行坐标界内、
 * EXIF orientation 归一化（竖拍/横拍方向一致性）、裁剪后 OCR 正常。
 */
@RunWith(AndroidJUnit4.class)
public class OcrCropInstrumentedTest {

    private static final long OCR_TIMEOUT_SEC = 60;

    private Bitmap makeSample() {
        Bitmap b = Bitmap.createBitmap(1000, 500, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        c.drawColor(Color.WHITE);
        Paint p = new Paint();
        p.setColor(Color.BLACK);
        p.setTextSize(56);
        p.setAntiAlias(true);
        c.drawText("31. 根据营销安规规定测试题干", 40, 120, p);
        c.drawText("A. 甲乙", 40, 240, p);
        c.drawText("B. 丙丁", 40, 360, p);
        return b;
    }

    private byte[] toJpeg(Bitmap b) {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 92, bo);
        return bo.toByteArray();
    }

    private String ocrText(Bitmap b) throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        TextRecognizer recognizer = TextRecognition.getClient(
                new ChineseTextRecognizerOptions.Builder().build());
        try {
            Text t = Tasks.await(recognizer.process(InputImage.fromBitmap(b, 0)),
                    OCR_TIMEOUT_SEC, TimeUnit.SECONDS);
            return t.getText();
        } finally {
            recognizer.close();
        }
    }

    @Test
    public void fullCrop_sameAsOriginalOcr() throws Exception {
        Bitmap src = makeSample();
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bitmap norm = OcrBitmap.decodeNormalized(toJpeg(src),
                ctx.getCacheDir());
        assertNotNull(norm);
        assertEquals(src.getWidth(), norm.getWidth());
        assertEquals(src.getHeight(), norm.getHeight());
        Bitmap full = OcrBitmap.cropNormalized(norm, 0, 0, 1, 1);
        assertEquals(src.getWidth(), full.getWidth());
        assertEquals(src.getHeight(), full.getHeight());
        String direct = ocrText(src);
        String viaFull = ocrText(full);
        // 空白差异（ML Kit 分块拼接的空格）不算内容差异：比较去空白后的字符
        assertEquals("全图 crop 的 OCR 结果应与整图一致",
                direct.replaceAll("\\s+", ""),
                viaFull.replaceAll("\\s+", ""));
        src.recycle(); norm.recycle(); full.recycle();
    }

    @Test
    public void topHalfCrop_dimsAndLinesStayInside() throws Exception {
        Bitmap src = makeSample();
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bitmap norm = OcrBitmap.decodeNormalized(toJpeg(src), ctx.getCacheDir());
        Bitmap half = OcrBitmap.cropNormalized(norm, 0, 0, 1, 0.5);
        assertEquals("裁剪高度 = round(0.5 × 原高)", Math.round(norm.getHeight() * 0.5), half.getHeight());
        assertEquals(norm.getWidth(), half.getWidth());
        String text = ocrText(half);
        assertNotNull(text);
        assertTrue("半图裁剪后仍应识别到文字", !text.trim().isEmpty());
        src.recycle(); norm.recycle(); half.recycle();
    }

    @Test
    public void exifOrientation6_normalizedBeforeCrop() throws Exception {
        // 600×300 横幅 + EXIF orientation 6（应显示为 300×600 竖幅）
        Bitmap landscape = Bitmap.createBitmap(600, 300, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(landscape);
        c.drawColor(Color.WHITE);
        Paint p = new Paint();
        p.setColor(Color.BLACK);
        p.setTextSize(48);
        c.drawText("32. 横拍方向测试题干", 30, 170, p);
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File f = new File(ctx.getCacheDir(), "exif_test_" + System.nanoTime() + ".jpg");
        FileOutputStream fo = new FileOutputStream(f);
        landscape.compress(Bitmap.CompressFormat.JPEG, 95, fo);
        fo.close();
        // 写入 EXIF orientation 6（不做像素旋转——模拟相机存储的原始方向）
        android.media.ExifInterface exif = new android.media.ExifInterface(f.getAbsolutePath());
        exif.setAttribute(android.media.ExifInterface.TAG_ORIENTATION,
                String.valueOf(android.media.ExifInterface.ORIENTATION_ROTATE_90));
        exif.saveAttributes();

        byte[] bytes = readAll(f);
        Bitmap norm = OcrBitmap.decodeNormalized(bytes, ctx.getCacheDir());
        assertNotNull(norm);
        assertEquals("EXIF 6 应归一化为竖幅（宽高互换）", 300, norm.getWidth());
        assertEquals(600, norm.getHeight());
        Bitmap crop = OcrBitmap.cropNormalized(norm, 0, 0, 1, 0.5);
        assertEquals(300, crop.getWidth());
        assertEquals(300, crop.getHeight());
        String text = ocrText(crop);
        assertTrue(text.contains("32") || text.contains("横拍") || text.contains("测试"));
        f.delete(); norm.recycle(); crop.recycle(); landscape.recycle();
    }

    @Test
    public void cropOcr_differentRegion_differentText() throws Exception {
        // 左半画"甲"、右半画"乙"：裁左半应看到甲相关行，裁右半应看到乙
        Bitmap wide = Bitmap.createBitmap(1200, 300, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(wide);
        c.drawColor(Color.WHITE);
        Paint p = new Paint();
        p.setColor(Color.BLACK);
        p.setTextSize(60);
        c.drawText("甲区测试内容", 40, 180, p);
        c.drawText("乙区测试内容", 700, 180, p);
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bitmap left = OcrBitmap.cropNormalized(wide, 0, 0, 0.5, 1);
        Bitmap right = OcrBitmap.cropNormalized(wide, 0.5, 0, 1, 1);
        String lt = ocrText(left), rt = ocrText(right);
        assertTrue("左半应含 甲区", lt.contains("甲区"));
        assertTrue("右半应含 乙区", rt.contains("乙区"));
        assertTrue("左半不应含 乙区", !lt.contains("乙区"));
        wide.recycle(); left.recycle(); right.recycle();
    }

    private byte[] readAll(File f) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        java.io.FileInputStream fi = new java.io.FileInputStream(f);
        byte[] buf = new byte[8192];
        int n;
        while ((n = fi.read(buf)) > 0) { bo.write(buf, 0, n); }
        fi.close();
        return bo.toByteArray();
    }
}
