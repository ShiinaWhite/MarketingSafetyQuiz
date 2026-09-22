package com.jty.safetyquiz;

/**
 * 裁剪框纯几何工具：归一化(0~1)坐标与视图像素坐标的换算、命中测试、
 * 整体平移 / 四角缩放的钳制。不依赖任何 Android 类，可纯 JVM 单测。
 *
 * 坐标约定：
 *   归一化坐标相对“照片实际内容区域”（letterbox 之后图像真正显示的矩形），
 *   而不是整个 View——用户看到的位置与最终按归一化裁剪的 Bitmap 区域一致；
 *   像素坐标相对 CropOverlayView 自身。
 */
public final class CropMath {

    private CropMath() { }

    /** 命中测试结果 / 缩放角标。 */
    public static final int HIT_NONE = 0;
    public static final int HIT_MOVE = 1;
    public static final int HIT_NW = 2;
    public static final int HIT_NE = 3;
    public static final int HIT_SW = 4;
    public static final int HIT_SE = 5;

    /** 归一化最小边长下限，与 JS 侧 CROP_MIN_SIZE 保持一致。 */
    public static final float MIN_CROP_RATIO = 0.06f;

    /** 简单 {left, top, right, bottom} 浮点矩形（替代 android.graphics 以保持纯 JVM 可测）。 */
    public static final class Rect {
        public float left;
        public float top;
        public float right;
        public float bottom;

        public Rect() { }

        public Rect(float left, float top, float right, float bottom) {
            set(left, top, right, bottom);
        }

        public void set(float left, float top, float right, float bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        public void set(Rect r) {
            set(r.left, r.top, r.right, r.bottom);
        }

        public float width() { return right - left; }

        public float height() { return bottom - top; }

        public boolean contains(float x, float y) {
            return x >= left && x <= right && y >= top && y <= bottom;
        }
    }

    /**
     * FIT_CENTER：等比缩放图像适配视图并居中，返回图像实际显示区域。
     * 处理竖拍/横拍照片在竖屏视图中的 letterbox，保证归一化坐标的换算基准正确。
     */
    public static Rect fitCenter(float viewW, float viewH, float imgW, float imgH) {
        if (viewW <= 0 || viewH <= 0 || imgW <= 0 || imgH <= 0) {
            return new Rect(0, 0, 0, 0);
        }
        float scale = Math.min(viewW / imgW, viewH / imgH);
        float w = imgW * scale;
        float h = imgH * scale;
        return new Rect((viewW - w) / 2f, (viewH - h) / 2f, (viewW + w) / 2f, (viewH + h) / 2f);
    }

    /** 归一化 crop → content 区域内的像素矩形。 */
    public static Rect toPixel(Rect cropNorm, Rect content) {
        float w = content.width();
        float h = content.height();
        return new Rect(
                content.left + cropNorm.left * w,
                content.top + cropNorm.top * h,
                content.left + cropNorm.right * w,
                content.top + cropNorm.bottom * h);
    }

    /**
     * 归一化最小边长：取固定比例下限与“最小像素下限换算”的较大者，
     * 保证小图/极端长宽比下选框不会小到不可操作（minPx 来自 44dp 触控热区标度）。
     */
    public static float minSizeNorm(float contentDimPx, float minPx) {
        float byPx = contentDimPx > 0 ? minPx / contentDimPx : 0f;
        return Math.max(MIN_CROP_RATIO, byPx);
    }

    /**
     * 命中测试：四角热区优先（中心对齐角点、边长 2×cornerRadiusPx 的正方形，
     * 即触控热区 ≥ 44dp 标度；多个角同时命中时取距离最近者），其次框内整体拖动。
     */
    public static int hitTest(float x, float y, Rect cropPx, float cornerRadiusPx) {
        float[] cx = {cropPx.left, cropPx.right, cropPx.left, cropPx.right};
        float[] cy = {cropPx.top, cropPx.top, cropPx.bottom, cropPx.bottom};
        int[] cornerOf = {HIT_NW, HIT_NE, HIT_SW, HIT_SE};
        int hit = HIT_NONE;
        float bestDist = Float.MAX_VALUE;
        for (int i = 0; i < 4; i++) {
            float dx = Math.abs(x - cx[i]);
            float dy = Math.abs(y - cy[i]);
            if (dx <= cornerRadiusPx && dy <= cornerRadiusPx) {
                float d = dx * dx + dy * dy;
                if (d < bestDist) {
                    bestDist = d;
                    hit = cornerOf[i];
                }
            }
        }
        if (hit != HIT_NONE) { return hit; }
        return cropPx.contains(x, y) ? HIT_MOVE : HIT_NONE;
    }

    /** 归一化钳制：保证 w/h ≥ 最小值、整体落在 [0,1] 内（等价 JS pageCropClamp 语义）。 */
    public static Rect clampNorm(Rect r, float minW, float minH) {
        float w = Math.min(Math.max(r.right - r.left, minW), 1f);
        float h = Math.min(Math.max(r.bottom - r.top, minH), 1f);
        float l = clamp(r.left, 0f, 1f - w);
        float t = clamp(r.top, 0f, 1f - h);
        return new Rect(l, t, l + w, t + h);
    }

    /** 整体平移：框尺寸不变，位置钳制在 [0,1] 内。 */
    public static Rect translateNorm(Rect src, float dxNorm, float dyNorm, float minW, float minH) {
        Rect r = clampNorm(src, minW, minH);
        float w = r.right - r.left;
        float h = r.bottom - r.top;
        float l = clamp(r.left + dxNorm, 0f, 1f - w);
        float t = clamp(r.top + dyNorm, 0f, 1f - h);
        return new Rect(l, t, l + w, t + h);
    }

    /**
     * 四角缩放：拖动的边随手指移动，相对边不动；钳制在 [0,1] 内且
     * 与相对边的距离不小于最小尺寸（不允许翻转、不允许拖出内容区域）。
     */
    public static Rect resizeNorm(Rect src, int corner, float dxNorm, float dyNorm,
                                  float minW, float minH) {
        Rect r = clampNorm(src, minW, minH);
        float l = r.left;
        float t = r.top;
        float rt = r.right;
        float b = r.bottom;
        switch (corner) {
            case HIT_NW:
                l = clamp(r.left + dxNorm, 0f, r.right - minW);
                t = clamp(r.top + dyNorm, 0f, r.bottom - minH);
                break;
            case HIT_NE:
                rt = clamp(r.right + dxNorm, r.left + minW, 1f);
                t = clamp(r.top + dyNorm, 0f, r.bottom - minH);
                break;
            case HIT_SW:
                l = clamp(r.left + dxNorm, 0f, r.right - minW);
                b = clamp(r.bottom + dyNorm, r.top + minH, 1f);
                break;
            case HIT_SE:
                rt = clamp(r.right + dxNorm, r.left + minW, 1f);
                b = clamp(r.bottom + dyNorm, r.top + minH, 1f);
                break;
            default:
                break;
        }
        return new Rect(l, t, rt, b);
    }

    public static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(v, hi));
    }
}
