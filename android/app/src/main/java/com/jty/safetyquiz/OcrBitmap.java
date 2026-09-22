package com.jty.safetyquiz;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 整页拍照的位图归一化与原生裁剪工具（仅供 OcrPlugin 与 androidTest 使用）。
 *
 * decodeNormalized：解码 JPEG 后按 EXIF orientation 旋转/翻转，使位图方向与
 * WebView 中 <img> 的显示方向一致——框选页看到的区域即实际裁剪区域。
 * cropNormalized：按 0~1 归一化坐标（相对归一化后的位图）裁剪，输出新位图。
 * 只做像素裁剪，不做任何重新压缩；OCR 输入仍来自同一份原始解码数据。
 */
public final class OcrBitmap {

    private OcrBitmap() { }

    /** 解码并按 EXIF orientation 归一化方向。EXIF 读取走临时文件（全 API 级别可用）。 */
    public static Bitmap decodeNormalized(byte[] jpegBytes, File cacheDir) throws IOException {
        Bitmap src = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
        if (src == null) { return null; }
        int orientation = 1;
        File tmp = new File(cacheDir, "ocr_exif_" + System.nanoTime() + ".jpg");
        try {
            FileOutputStream fo = new FileOutputStream(tmp);
            fo.write(jpegBytes);
            fo.close();
            ExifInterface exif = new ExifInterface(tmp.getAbsolutePath());
            orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException ignored) {
            // 读不到 EXIF 时按方向 1 处理
        } finally {
            if (tmp.exists() && !tmp.delete()) {
                tmp.deleteOnExit();
            }
        }
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                m.postRotate(180f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                m.postRotate(180f);
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                m.postRotate(90f);
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                m.postRotate(90f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                m.postRotate(-90f);
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                m.postRotate(270f);
                break;
            default:
                return src;
        }
        Bitmap out = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
        if (out != src) { src.recycle(); }
        return out;
    }

    /** 按 0~1 归一化坐标裁剪（坐标相对归一化后的位图），输出裁剪位图。 */
    public static Bitmap cropNormalized(Bitmap src, double left, double top,
                                        double right, double bottom) {
        int w = src.getWidth(), h = src.getHeight();
        int l = clampPx(left, w, 0);
        int t = clampPx(top, h, 0);
        int rr = Math.max(l + 1, clampPx(right, w, w));
        int bb = Math.max(t + 1, clampPx(bottom, h, h));
        return Bitmap.createBitmap(src, l, t, rr - l, bb - t);
    }

    private static int clampPx(double v, int max, int def) {
        if (Double.isNaN(v)) { return def; }
        int px = (int) Math.round(v * max);
        return Math.max(0, Math.min(max, px));
    }
}
