package com.jty.safetyquiz;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.util.Base64;

import androidx.camera.core.ImageProxy;

import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * 拍照输出物：一次 CameraX 捕获的完整产物。
 * 位图 ownership 规则与原 InAppCameraPlugin.processJpeg 完全一致（移动语义）：
 *   rawBitmap    = decode 产物
 *   normalized   = 旋转归一化产物（无旋转时直接接管 rawBitmap，rawBitmap 置 null）
 *   mainBitmap   = 正式 OCR 图（宽 ≤ maxW 时直接接管 normalized）
 *   layoutBitmap = 布局图（宽 ≤ layW 时直接接管 mainBitmap）
 * 每个阶段结束时，上一阶段产物在完成“作为新图的采样源”这一最后用途后
 * 立即 recycle 并把变量置 null，因此每个实例整个生命周期恰好 recycle 一次；
 * finally 只兜底回收仍非空的变量（异常路径同样恰好一次），无 use-after-recycle。
 * 正式图 maxWidth=3000/q85、布局图 maxWidth=1280/q70，设备低于 3000 时不放大。
 */
public final class CapturedPage {

    public final byte[] mainJpeg;
    public final byte[] layoutJpeg;
    public final int sensorWidth;
    public final int sensorHeight;
    public final int normalizedWidth;
    public final int normalizedHeight;
    public final int outputWidth;
    public final int outputHeight;
    public final int layoutWidth;
    public final int layoutHeight;

    private CapturedPage(byte[] mainJpeg, byte[] layoutJpeg,
                         int sensorWidth, int sensorHeight,
                         int normalizedWidth, int normalizedHeight,
                         int outputWidth, int outputHeight,
                         int layoutWidth, int layoutHeight) {
        this.mainJpeg = mainJpeg;
        this.layoutJpeg = layoutJpeg;
        this.sensorWidth = sensorWidth;
        this.sensorHeight = sensorHeight;
        this.normalizedWidth = normalizedWidth;
        this.normalizedHeight = normalizedHeight;
        this.outputWidth = outputWidth;
        this.outputHeight = outputHeight;
        this.layoutWidth = layoutWidth;
        this.layoutHeight = layoutHeight;
    }

    /** 从 CameraX 捕获结果构建；ImageProxy 在任何路径下都恰好 close 一次。 */
    static CapturedPage fromImageProxy(ImageProxy proxy, int maxW, int qual, int layW) {
        byte[] jpeg;
        int rotation;
        try {
            if (proxy.getFormat() != ImageFormat.JPEG) {
                throw new IllegalArgumentException("UNSUPPORTED_FORMAT");
            }
            ByteBuffer buf = proxy.getPlanes()[0].getBuffer();
            jpeg = new byte[buf.remaining()];
            buf.get(jpeg);
            rotation = proxy.getImageInfo().getRotationDegrees();
        } finally {
            // 异常路径也必须关闭 ImageProxy，否则相机管线阻塞在缓冲区上
            proxy.close();
        }
        return process(jpeg, rotation, maxW, qual, layW);
    }

    public static CapturedPage process(byte[] jpegBytes, int rotation, int maxW, int qual, int layW) {
        Bitmap rawBitmap = null;
        Bitmap normalized = null;
        Bitmap mainBitmap = null;
        Bitmap layoutBitmap = null;
        byte[] mainJpeg;
        byte[] layoutJpeg;
        int sensorW;
        int sensorH;
        int normW;
        int normH;
        int outW;
        int outH;
        int layW2;
        int layH2;
        try {
            rawBitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
            if (rawBitmap == null) {
                throw new IllegalArgumentException("DECODE_FAILED");
            }
            sensorW = rawBitmap.getWidth();
            sensorH = rawBitmap.getHeight();

            if (rotation != 0) {
                Matrix m = new Matrix();
                m.postRotate(rotation);
                normalized = Bitmap.createBitmap(rawBitmap, 0, 0, sensorW, sensorH, m, true);
                rawBitmap.recycle();
                rawBitmap = null;
            } else {
                normalized = rawBitmap;
                rawBitmap = null;
            }
            normW = normalized.getWidth();
            normH = normalized.getHeight();

            if (normW > maxW) {
                float ratio = (float) maxW / normW;
                Matrix m = new Matrix();
                m.postScale(ratio, ratio);
                mainBitmap = Bitmap.createBitmap(normalized, 0, 0, normW, normH, m, true);
                normalized.recycle();
                normalized = null;
            } else {
                mainBitmap = normalized;
                normalized = null;
            }
            mainJpeg = toJpeg(mainBitmap, qual);
            outW = mainBitmap.getWidth();
            outH = mainBitmap.getHeight();

            if (layW > 0 && mainBitmap.getWidth() > layW) {
                float ratio = (float) layW / mainBitmap.getWidth();
                Matrix m = new Matrix();
                m.postScale(ratio, ratio);
                layoutBitmap = Bitmap.createBitmap(mainBitmap, 0, 0,
                        mainBitmap.getWidth(), mainBitmap.getHeight(), m, true);
                mainBitmap.recycle();
                mainBitmap = null;
            } else {
                layoutBitmap = mainBitmap;
                mainBitmap = null;
            }
            layoutJpeg = toJpeg(layoutBitmap, 70);
            layW2 = layoutBitmap.getWidth();
            layH2 = layoutBitmap.getHeight();

            layoutBitmap.recycle();
            layoutBitmap = null;
            return new CapturedPage(mainJpeg, layoutJpeg,
                    sensorW, sensorH, normW, normH, outW, outH, layW2, layH2);
        } finally {
            // 兜底：异常路径下仅回收“仍在变量手里”的实例；正常路径全部已置 null。
            // 因为从不别名，同一实例不可能被这里二次回收。
            if (rawBitmap != null) { rawBitmap.recycle(); }
            if (normalized != null) { normalized.recycle(); }
            if (mainBitmap != null) { mainBitmap.recycle(); }
            if (layoutBitmap != null) { layoutBitmap.recycle(); }
        }
    }

    /** REVIEW 页显示用：解码布局图（≤1280 宽），调用方持有并负责恰好 recycle 一次。 */
    public Bitmap decodeLayoutBitmap() {
        return BitmapFactory.decodeByteArray(layoutJpeg, 0, layoutJpeg.length);
    }

    /** 正式 OCR 图 dataUrl（JPEG base64），交给现有 JS OCR 管线。 */
    public String mainDataUrl() {
        return "data:image/jpeg;base64," + Base64.encodeToString(mainJpeg, Base64.NO_WRAP);
    }

    /** 布局图 dataUrl（JPEG q70 base64），交给现有 JS 自动定位管线。 */
    public String layoutDataUrl() {
        return "data:image/jpeg;base64," + Base64.encodeToString(layoutJpeg, Base64.NO_WRAP);
    }

    /** 汇总为 JS 结果对象（字段与原 capture() 返回完全一致 + cropNormalized 由调用方补齐）。 */
    public JSObject toJsObject() {
        JSObject ret = new JSObject();
        ret.put("dataUrl", mainDataUrl());
        ret.put("width", outputWidth);
        ret.put("height", outputHeight);
        ret.put("layoutDataUrl", layoutDataUrl());
        ret.put("layoutWidth", layoutWidth);
        ret.put("layoutHeight", layoutHeight);
        ret.put("sensorWidth", sensorWidth);
        ret.put("sensorHeight", sensorHeight);
        ret.put("normalizedWidth", normalizedWidth);
        ret.put("normalizedHeight", normalizedHeight);
        ret.put("outputWidth", outputWidth);
        ret.put("outputHeight", outputHeight);
        return ret;
    }

    private static byte[] toJpeg(Bitmap b, int q) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, q, bo);
        return bo.toByteArray();
    }
}
