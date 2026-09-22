package com.jty.safetyquiz;

import android.view.MotionEvent;
import android.view.View;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * CropOverlayView 真实事件链验证：不直接调用几何函数，而是向挂在窗口里的
 * View 派发真实 MotionEvent（ACTION_DOWN/MOVE/UP），断言 crop 确实变化。
 * 针对“测试全绿但真机框完全拖不动”的历史问题：
 *   - 命中走 hitTest（44dp 热区）而非直接设 mode；
 *   - 归一化坐标由触摸像素经 contentRect 反算（用户看到的框 = 最终裁剪区域）。
 * 四角 NW/NE/SW/SE、整体拖动、边界钳制、最小尺寸、userTouched 标记全覆盖。
 */
@RunWith(AndroidJUnit4.class)
public class CropOverlayInstrumentedTest {

    /** 视图尺寸：与 dp 无关，直接用像素布局，contentRect 覆盖完整视图（方形无 letterbox）。 */
    private static final int VIEW_SIZE = 1000;

    private CropOverlayView overlay;

    private void setUpOverlay() throws Exception {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            overlay = new CropOverlayView(InstrumentationRegistry.getInstrumentation().getContext());
            overlay.measure(
                    View.MeasureSpec.makeMeasureSpec(VIEW_SIZE, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(VIEW_SIZE, View.MeasureSpec.EXACTLY));
            overlay.layout(0, 0, VIEW_SIZE, VIEW_SIZE);
            android.graphics.RectF content =
                    new android.graphics.RectF(0, 0, VIEW_SIZE, VIEW_SIZE);
            overlay.setContentRect(content);
            overlay.setCropNorm(0.1f, 0.1f, 0.9f, 0.9f);
        });
    }

    private CropMath.Rect cropOnMain() throws Exception {
        final CropMath.Rect[] out = new CropMath.Rect[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                out[0] = overlay.getCropNorm());
        return out[0];
    }

    /** 派发一次真实手势：DOWN→(x1,y1)，MOVE→(x2,y2)，UP。 */
    private void gesture(float x1, float y1, float x2, float y2) throws Exception {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            long now = System.currentTimeMillis();
            overlay.dispatchTouchEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x1, y1, 0));
            long t2 = now + 50;
            overlay.dispatchTouchEvent(MotionEvent.obtain(now, t2, MotionEvent.ACTION_MOVE, x2, y2, 0));
            overlay.dispatchTouchEvent(MotionEvent.obtain(now, t2 + 20, MotionEvent.ACTION_UP, x2, y2, 0));
        });
    }

    /** 分步手势（多段 MOVE 模拟真实拖动）。 */
    private void gesture(float... points) throws Exception {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            long now = System.currentTimeMillis();
            overlay.dispatchTouchEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN,
                    points[0], points[1], 0));
            for (int i = 2; i + 1 < points.length; i += 2) {
                overlay.dispatchTouchEvent(MotionEvent.obtain(now, now + i * 20,
                        MotionEvent.ACTION_MOVE, points[i], points[i + 1], 0));
            }
            overlay.dispatchTouchEvent(MotionEvent.obtain(now, now + 9999,
                    MotionEvent.ACTION_UP, points[points.length - 2], points[points.length - 1], 0));
        });
    }

    @Test
    public void cornerNW_drag_outward_growsSelection() throws Exception {
        setUpOverlay();
        // 初始 (0.1,0.1)-(0.9,0.9)；NW 角点在 (100,100)，向外拖 50px → left/top = 0.05
        gesture(100, 100, 50, 50);
        CropMath.Rect r = cropOnMain();
        assertEquals(0.05f, r.left, 0.01f);
        assertEquals(0.05f, r.top, 0.01f);
        assertEquals(0.9f, r.right, 0.01f);   // 相对边不动
        assertEquals(0.9f, r.bottom, 0.01f);
        assertTrue(overlay.hasUserTouched());
    }

    @Test
    public void cornerNE_drag_shrinksFromRight() throws Exception {
        setUpOverlay();
        gesture(900, 100, 800, 100);
        CropMath.Rect r = cropOnMain();
        assertEquals(0.8f, r.right, 0.01f);
        assertEquals(0.1f, r.left, 0.01f);
        assertEquals(0.1f, r.top, 0.01f);
    }

    @Test
    public void cornerSW_drag_growsDownLeft() throws Exception {
        setUpOverlay();
        gesture(100, 900, 60, 950);
        CropMath.Rect r = cropOnMain();
        assertEquals(0.06f, r.left, 0.01f);
        assertEquals(0.95f, r.bottom, 0.01f);
        assertEquals(0.9f, r.right, 0.01f);
    }

    @Test
    public void cornerSE_drag_outward_hitsBoundaryClamp() throws Exception {
        setUpOverlay();
        // SE (900,900) 向外拖 500px → 钳到 (1,1)
        gesture(900, 900, 1400, 1400);
        CropMath.Rect r = cropOnMain();
        assertEquals(1f, r.right, 0.001f);
        assertEquals(1f, r.bottom, 0.001f);
        assertEquals(0.1f, r.left, 0.01f);
    }

    @Test
    public void wholeCropDrag_movesSelection_clampedInside() throws Exception {
        setUpOverlay();
        // 框中心 (500,500) 拖 (+80,+40)
        gesture(500, 500, 580, 540);
        CropMath.Rect r = cropOnMain();
        assertEquals(0.18f, r.left, 0.01f);
        assertEquals(0.98f, r.right, 0.01f);
        assertEquals(0.14f, r.top, 0.01f);
        // 再大幅拖动 → 右缘钳在 1.0
        gesture(540, 300, 1200, 300);
        CropMath.Rect r2 = cropOnMain();
        assertEquals(1f, r2.right, 0.001f);
        assertEquals(0.8f, r2.width(), 0.02f);   // 尺寸保持
    }

    @Test
    public void cornerDrag_cannotFlipPastOppositeEdge_minSizeEnforced() throws Exception {
        setUpOverlay();
        // SE 向左上狂拖 → 右缘停在 left+min(≥0.06) 之外不得翻转
        gesture(900, 900, 20, 20);
        CropMath.Rect r = cropOnMain();
        assertTrue("不得翻转：right 必须 > left", r.right > r.left);
        assertTrue("最小尺寸 ≥ 0.06", r.right - r.left >= 0.06f - 0.001f);
        assertTrue("最小高度 ≥ 0.06", r.bottom - r.top >= 0.06f - 0.001f);
        assertEquals(0.1f, r.left, 0.01f);   // 相对边不动
    }

    @Test
    public void touchOutsideContent_returnsFalse_cropUnchanged() throws Exception {
        setUpOverlay();
        // 覆盖 letterbox 场景：contentRect 只占视图中部（横图在竖视图里）
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                overlay.setContentRect(new android.graphics.RectF(0, 250, 1000, 750)));
        CropMath.Rect before = cropOnMain();
        final Boolean[] consumed = new Boolean[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            long now = System.currentTimeMillis();
            consumed[0] = overlay.dispatchTouchEvent(
                    MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 500, 100, 0));
        });
        assertFalse("letterbox 区域触摸不应被消费", consumed[0]);
        CropMath.Rect after = cropOnMain();
        assertEquals(before.left, after.left, 0.0001f);
        assertEquals(before.right, after.right, 0.0001f);
    }

    @Test
    public void multiStepDrag_accumulates() throws Exception {
        setUpOverlay();
        // 三段 MOVE 的真实拖动轨迹：SE 角逐步外扩，位移累计生效
        gesture(900, 900, 920, 920, 940, 940, 960, 960);
        CropMath.Rect r = cropOnMain();
        assertEquals(0.96f, r.right, 0.01f);
        assertEquals(0.96f, r.bottom, 0.01f);
    }

    @Test
    public void resetUserTouched_afterRetake() throws Exception {
        setUpOverlay();
        assertFalse(overlay.hasUserTouched());
        gesture(500, 500, 520, 520);
        assertTrue(overlay.hasUserTouched());
        InstrumentationRegistry.getInstrumentation().runOnMainSync(overlay::resetUserTouched);
        assertFalse(overlay.hasUserTouched());
    }
}
