package com.jty.safetyquiz;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

/**
 * REVIEW 冻结照片上的原生裁剪框：
 *  - 全图半透明蒙层，选区内恢复清晰（不遮盖下方 ImageView）；
 *  - 四个白色粗 L 型角标 + 细边框 + 三分线；
 *  - 原生 touch：整体拖动 / 四角缩放（NW/NE/SW/SE），边界钳制 [0,1]，
 *    最小尺寸钳制（0.06 与 44dp 换算取大者）；
 *  - 四角触控热区为 44dp 见方（中心对齐角点）；
 *  - crop 坐标统一保存为 left/top/right/bottom 的 0~1 归一化值，
 *    且相对“照片实际内容区域”（contentRect，letterbox 修正后传入），
 *    用户看到的位置与最终归一化裁剪完全一致。
 * 几何逻辑全部在 CropMath（纯 JVM 可测），本类只做绘制与事件分发。
 */
public class CropOverlayView extends View {

    /** 第一次有效触摸即回调：用于“人工碰过框之后，迟到的自动框不得覆盖”。 */
    public interface OnCropUserTouchListener {
        void onCropUserTouch();
    }

    private static final float MASK_ALPHA = 0.55f;
    private static final float CORNER_STROKE_DP = 4f;
    private static final float CORNER_ARM_DP = 22f;
    private static final float BORDER_STROKE_DP = 1.5f;
    private static final float GRID_STROKE_DP = 1f;
    private static final float GRID_ALPHA = 0.33f;
    /** 四角触控热区边长（dp）：命中测试用 44dp。 */
    private static final float CORNER_TOUCH_DP = 44f;
    /** 最小框的像素下限标度（dp），与归一化 0.06 取大者。 */
    private static final float MIN_CROP_DP = 44f;

    private final CropMath.Rect contentRect = new CropMath.Rect();
    /** 归一化 crop（0~1，相对 contentRect）。 */
    private final CropMath.Rect cropNorm = new CropMath.Rect(0.04f, 0.04f, 0.96f, 0.96f);

    private final Paint maskPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint cornerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private float density = 1f;
    private int dragMode = CropMath.HIT_NONE;
    private final CropMath.Rect dragOrig = new CropMath.Rect();
    private float downX;
    private float downY;
    private boolean userTouched;
    private OnCropUserTouchListener userTouchListener;

    public CropOverlayView(Context context) {
        super(context);
        init();
    }

    public CropOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public CropOverlayView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        density = getResources().getDisplayMetrics().density;
        maskPaint.setColor(composeArgb(MASK_ALPHA, 0, 0, 0));
        borderPaint.setStyle(Paint.Style.STROKE);
        borderPaint.setStrokeWidth(BORDER_STROKE_DP * density);
        borderPaint.setColor(0xFFFFFFFF);
        cornerPaint.setStyle(Paint.Style.STROKE);
        cornerPaint.setStrokeWidth(CORNER_STROKE_DP * density);
        cornerPaint.setStrokeCap(Paint.Cap.ROUND);
        cornerPaint.setColor(0xFFFFFFFF);
        gridPaint.setStyle(Paint.Style.STROKE);
        gridPaint.setStrokeWidth(GRID_STROKE_DP * density);
        gridPaint.setColor(composeArgb(GRID_ALPHA, 255, 255, 255));
    }

    private static int composeArgb(float alpha, int r, int g, int b) {
        return ((int) (alpha * 255) << 24) | (r << 16) | (g << 8) | b;
    }

    public void setOnCropUserTouchListener(OnCropUserTouchListener l) {
        userTouchListener = l;
    }

    /** 设置照片内容在 View 内的实际显示矩形（FIT_CENTER letterbox 计算，像素）。 */
    public void setContentRect(RectF rect) {
        if (rect == null) { return; }
        contentRect.set(rect.left, rect.top, rect.right, rect.bottom);
        invalidate();
    }

    /** 设置归一化 crop（钳制到合法范围）。 */
    public void setCropNorm(float left, float top, float right, float bottom) {
        CropMath.Rect r = clampWithMin(new CropMath.Rect(left, top, right, bottom));
        cropNorm.set(r);
        invalidate();
    }

    /** 当前归一化 crop（已经钳制，与最终裁剪一致）。 */
    public CropMath.Rect getCropNorm() {
        return new CropMath.Rect(cropNorm.left, cropNorm.top, cropNorm.right, cropNorm.bottom);
    }

    /** 用户是否碰过裁剪框（LIVE 冻结后重置）。 */
    public boolean hasUserTouched() {
        return userTouched;
    }

    public void resetUserTouched() {
        userTouched = false;
    }

    private float cornerTouchRadiusPx() {
        return CORNER_TOUCH_DP * density / 2f;
    }

    private float minSizeNormW() {
        return CropMath.minSizeNorm(contentRect.width(), MIN_CROP_DP * density);
    }

    private float minSizeNormH() {
        return CropMath.minSizeNorm(contentRect.height(), MIN_CROP_DP * density);
    }

    private CropMath.Rect clampWithMin(CropMath.Rect r) {
        return CropMath.clampNorm(r, minSizeNormW(), minSizeNormH());
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (contentRect.width() <= 0 || contentRect.height() <= 0) { return; }
        CropMath.Rect px = CropMath.toPixel(cropNorm, contentRect);

        // 选区外蒙层（四条矩形覆盖整个 View，缺口即选区；内部区域不绘制 → 保持清晰）
        canvas.drawRect(0, 0, getWidth(), px.top, maskPaint);
        canvas.drawRect(0, px.bottom, getWidth(), getHeight(), maskPaint);
        canvas.drawRect(0, px.top, px.left, px.bottom, maskPaint);
        canvas.drawRect(px.right, px.top, getWidth(), px.bottom, maskPaint);

        // 细边框 + 三分线
        canvas.drawRect(px.left, px.top, px.right, px.bottom, borderPaint);
        float w3 = px.width() / 3f;
        float h3 = px.height() / 3f;
        canvas.drawLine(px.left + w3, px.top, px.left + w3, px.bottom, gridPaint);
        canvas.drawLine(px.left + 2 * w3, px.top, px.left + 2 * w3, px.bottom, gridPaint);
        canvas.drawLine(px.left, px.top + h3, px.right, px.top + h3, gridPaint);
        canvas.drawLine(px.left, px.top + 2 * h3, px.right, px.top + 2 * h3, gridPaint);

        // 四个白色粗 L 型角标
        float arm = CORNER_ARM_DP * density;
        drawCorner(canvas, px.left, px.top, arm, 1, 1);
        drawCorner(canvas, px.right, px.top, arm, -1, 1);
        drawCorner(canvas, px.left, px.bottom, arm, 1, -1);
        drawCorner(canvas, px.right, px.bottom, arm, -1, -1);
    }

    private void drawCorner(Canvas canvas, float cx, float cy, float arm, int sx, int sy) {
        canvas.drawLine(cx, cy, cx + sx * arm, cy, cornerPaint);
        canvas.drawLine(cx, cy, cx, cy + sy * arm, cornerPaint);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (contentRect.width() <= 0 || contentRect.height() <= 0) { return false; }
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN: {
                float x = event.getX();
                float y = event.getY();
                CropMath.Rect px = CropMath.toPixel(cropNorm, contentRect);
                int hit = CropMath.hitTest(x, y, px, cornerTouchRadiusPx());
                if (hit == CropMath.HIT_NONE) { return false; }
                if (!userTouched) {
                    userTouched = true;
                    if (userTouchListener != null) { userTouchListener.onCropUserTouch(); }
                }
                dragMode = hit;
                dragOrig.set(cropNorm);
                downX = x;
                downY = y;
                if (getParent() != null) {
                    getParent().requestDisallowInterceptTouchEvent(true);
                }
                return true;
            }
            case MotionEvent.ACTION_MOVE: {
                if (dragMode == CropMath.HIT_NONE) { return true; }
                // 与 JS 逻辑一致：相对“按下点”的绝对位移，基准框为按下时的快照
                float dxNorm = (event.getX() - downX) / contentRect.width();
                float dyNorm = (event.getY() - downY) / contentRect.height();
                if (dragMode == CropMath.HIT_MOVE) {
                    cropNorm.set(CropMath.translateNorm(dragOrig, dxNorm, dyNorm,
                            minSizeNormW(), minSizeNormH()));
                } else {
                    cropNorm.set(CropMath.resizeNorm(dragOrig, dragMode, dxNorm, dyNorm,
                            minSizeNormW(), minSizeNormH()));
                }
                invalidate();
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                dragMode = CropMath.HIT_NONE;
                return true;
            default:
                return super.onTouchEvent(event);
        }
    }
}
