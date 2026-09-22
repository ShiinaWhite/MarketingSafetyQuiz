package com.jty.safetyquiz;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * CropMath 纯几何测试（JVM，无 Android 依赖）：
 * FIT_CENTER 内容矩形（竖图/横图 letterbox）、归一化↔像素映射、四角命中、
 * 整体拖动与四角缩放的边界钳制、最小尺寸限制。
 * 与真机拖不动的历史问题对应：这里先在 JVM 层证明几何正确，
 * instrumented 测试再发真实 MotionEvent 证明事件链可用。
 */
public class CropMathTest {

    private static final float DELTA = 1e-4f;

    /* ---------------- fitCenter ---------------- */

    @Test
    public void fitCenter_portraitImageInPortraitView_letterboxesSides() {
        // 竖图 3000×4000 放进 1000×2000 视图：scale=1/3，宽 1000、高 ~1333.33，上下留黑
        CropMath.Rect r = CropMath.fitCenter(1000, 2000, 3000, 4000);
        assertEquals(0f, r.left, DELTA);
        assertEquals(1000f, r.right, DELTA);
        assertEquals((2000 - 1333.3333f) / 2f, r.top, 1e-3f);
        assertEquals(2000 - r.top, r.bottom, DELTA);
        assertEquals(1000f, r.width(), DELTA);
        assertEquals(1333.3333f, r.height(), 1e-3f);
    }

    @Test
    public void fitCenter_landscapeImageInPortraitView_letterboxesTopBottom() {
        // 横图 4000×3000 放进 1000×2000 视图：scale=1/4，宽 1000、高 750
        CropMath.Rect r = CropMath.fitCenter(1000, 2000, 4000, 3000);
        assertEquals(0f, r.left, DELTA);
        assertEquals(1000f, r.right, DELTA);
        assertEquals((2000 - 750f) / 2f, r.top, DELTA);
        assertEquals(750f, r.height(), DELTA);
    }

    /* ---------------- 归一化 ↔ 像素映射 ---------------- */

    @Test
    public void mapping_normalizedCropMatchesDisplayedContent_portrait() {
        // 用户在内容区域看到的框必须与最终按归一化裁剪的区域一致
        CropMath.Rect content = CropMath.fitCenter(1080, 1800, 3000, 4000);
        CropMath.Rect cropNorm = new CropMath.Rect(0.1f, 0.2f, 0.7f, 0.8f);
        CropMath.Rect px = CropMath.toPixel(cropNorm, content);

        assertEquals(content.left + 0.1f * content.width(), px.left, DELTA);
        assertEquals(content.top + 0.2f * content.height(), px.top, DELTA);
        assertEquals(content.left + 0.7f * content.width(), px.right, DELTA);
        assertEquals(content.top + 0.8f * content.height(), px.bottom, DELTA);

        // 反向换算闭合
        assertEquals(0.1f, (px.left - content.left) / content.width(), DELTA);
        assertEquals(0.8f, (px.bottom - content.top) / content.height(), DELTA);
    }

    @Test
    public void mapping_normalizedCropMatchesDisplayedContent_landscape() {
        CropMath.Rect content = CropMath.fitCenter(1080, 1800, 4000, 3000);
        CropMath.Rect cropNorm = new CropMath.Rect(0.25f, 0.1f, 0.9f, 0.6f);
        CropMath.Rect px = CropMath.toPixel(cropNorm, content);
        assertEquals(content.left + 0.25f * content.width(), px.left, DELTA);
        assertEquals(content.top + 0.1f * content.height(), px.top, DELTA);
    }

    /* ---------------- 命中测试 ---------------- */

    private CropMath.Rect normCropPx() {
        // content 1000×1000 的像素 crop (100,100)-(900,900)
        return new CropMath.Rect(100, 100, 900, 900);
    }

    @Test
    public void hitTest_cornersWithin44dpBox() {
        CropMath.Rect px = normCropPx();
        float radius = 22f; // 44dp 热区半径的一半，即热区边长 44
        assertEquals(CropMath.HIT_NW, CropMath.hitTest(100, 100, px, radius));
        assertEquals(CropMath.HIT_NE, CropMath.hitTest(900, 100, px, radius));
        assertEquals(CropMath.HIT_SW, CropMath.hitTest(100, 900, px, radius));
        assertEquals(CropMath.HIT_SE, CropMath.hitTest(900, 900, px, radius));
        // 角点外侧 21px 仍命中（热区≥44dp 见方的核心断言）
        assertEquals(CropMath.HIT_NW, CropMath.hitTest(100 - 21, 100 - 21, px, radius));
        assertEquals(CropMath.HIT_SE, CropMath.hitTest(900 + 21, 900 + 21, px, radius));
    }

    @Test
    public void hitTest_insideIsMove_outsideIsNone() {
        CropMath.Rect px = normCropPx();
        assertEquals(CropMath.HIT_MOVE, CropMath.hitTest(500, 500, px, 22f));
        assertEquals(CropMath.HIT_NONE, CropMath.hitTest(50, 500, px, 22f));
        assertEquals(CropMath.HIT_NONE, CropMath.hitTest(500, 950, px, 22f));
    }

    @Test
    public void hitTest_overlappingCorners_pickNearest() {
        CropMath.Rect tiny = new CropMath.Rect(480, 480, 520, 520);
        assertEquals(CropMath.HIT_NW, CropMath.hitTest(485, 485, tiny, 22f));
        assertEquals(CropMath.HIT_SE, CropMath.hitTest(515, 515, tiny, 22f));
    }

    /* ---------------- clamp / translate ---------------- */

    @Test
    public void clampNorm_enforcesMinSizeAndBounds() {
        // JS pageCropClamp 语义：过小的 w/h 只放大到 min、绝不缩小大框；位置钳制 [0,1-w]
        // 左负越界 + 高度尚可：x 拉回 0，尺寸保持
        CropMath.Rect r = CropMath.clampNorm(new CropMath.Rect(-0.2f, 0.9f, 0.2f, 0.98f),
                0.06f, 0.06f);
        assertEquals(0f, r.left, DELTA);
        assertEquals(0.4f, r.width(), DELTA);
        assertEquals(0.9f, r.top, DELTA);
        assertEquals(0.98f, r.bottom, DELTA);
        // 过小的宽被放大到 min：right = left + minW
        CropMath.Rect r2 = CropMath.clampNorm(new CropMath.Rect(0.5f, 0.5f, 0.53f, 0.9f),
                0.06f, 0.06f);
        assertEquals(0.5f, r2.left, DELTA);
        assertEquals(0.56f, r2.right, DELTA);
        assertEquals(0.5f, r2.top, DELTA);
        assertEquals(0.9f, r2.bottom, DELTA);
    }

    @Test
    public void translateNorm_movesWholeBox_clampedInsideUnitSquare() {
        CropMath.Rect r = CropMath.translateNorm(new CropMath.Rect(0.2f, 0.2f, 0.5f, 0.5f),
                0.7f, -0.5f, 0.06f, 0.06f);
        assertEquals(0.7f, r.left, DELTA);   // 1-w = 0.7，贴右缘
        assertEquals(1f, r.right, DELTA);
        assertEquals(0f, r.top, DELTA);      // 贴上缘
        assertEquals(0.3f, r.bottom, DELTA);
        assertEquals(0.3f, r.width(), DELTA); // 尺寸不变
        assertEquals(0.3f, r.height(), DELTA);
    }

    /* ---------------- 四角缩放 ---------------- */

    @Test
    public void resizeCorner_NW_movesOnlyTopLeft_respectsMinAndBounds() {
        CropMath.Rect src = new CropMath.Rect(0.2f, 0.2f, 0.8f, 0.8f);
        CropMath.Rect r = CropMath.resizeNorm(src, CropMath.HIT_NW, -0.05f, 0.1f, 0.06f, 0.06f);
        assertEquals(0.15f, r.left, DELTA);
        assertEquals(0.3f, r.top, DELTA);
        assertEquals(0.8f, r.right, DELTA);   // 相对边不动
        assertEquals(0.8f, r.bottom, DELTA);
    }

    @Test
    public void resizeCorner_SE_movesOnlyBottomRight_respectsMinAndBounds() {
        CropMath.Rect src = new CropMath.Rect(0.2f, 0.2f, 0.8f, 0.8f);
        CropMath.Rect r = CropMath.resizeNorm(src, CropMath.HIT_SE, 0.3f, 0.3f, 0.06f, 0.06f);
        assertEquals(1f, r.right, DELTA);     // 钳在 1
        assertEquals(1f, r.bottom, DELTA);
        assertEquals(0.2f, r.left, DELTA);
    }

    @Test
    public void resizeCorner_NE_neverFlipsPastOppositeEdge() {
        CropMath.Rect src = new CropMath.Rect(0.2f, 0.2f, 0.8f, 0.8f);
        // 右边界向左拖穿左边界：必须停在 left+minW，不得翻转
        CropMath.Rect r = CropMath.resizeNorm(src, CropMath.HIT_NE, -0.9f, 0f, 0.06f, 0.06f);
        assertEquals(0.26f, r.right, DELTA);
        assertEquals(0.2f, r.left, DELTA);
        // 上边界向下拖穿下边界：停在 bottom-minH
        CropMath.Rect r2 = CropMath.resizeNorm(src, CropMath.HIT_NE, 0f, 0.9f, 0.06f, 0.06f);
        assertEquals(0.74f, r2.top, DELTA);
        assertEquals(0.8f, r2.bottom, DELTA);
    }

    @Test
    public void resizeCorner_SW_symmetricClamp() {
        CropMath.Rect src = new CropMath.Rect(0.2f, 0.2f, 0.8f, 0.8f);
        CropMath.Rect r = CropMath.resizeNorm(src, CropMath.HIT_SW, -0.5f, 0.5f, 0.06f, 0.06f);
        assertEquals(0f, r.left, DELTA);
        assertEquals(1f, r.bottom, DELTA);
        assertEquals(0.8f, r.right, DELTA);
        assertEquals(0.2f, r.top, DELTA);
    }

    @Test
    public void resizeCorner_minSizeFloor_appliedWhenContentSmall() {
        CropMath.Rect src = new CropMath.Rect(0.47f, 0.47f, 0.53f, 0.53f);
        CropMath.Rect r = CropMath.resizeNorm(src, CropMath.HIT_SE, -0.1f, -0.1f, 0.06f, 0.06f);
        // 收缩到最小尺寸即停
        assertEquals(0.53f, r.right, DELTA);
        assertEquals(0.47f, r.right - 0.06f, DELTA);
        assertEquals(0.53f, r.bottom, DELTA);
    }

    /* ---------------- minSizeNorm ---------------- */

    @Test
    public void minSizeNorm_ratioFloorWinsOnLargeContent() {
        assertEquals(0.06f, CropMath.minSizeNorm(2000, 100), DELTA);
    }

    @Test
    public void minSizeNorm_pxFloorWinsOnSmallContent() {
        // 内容太窄时用 44dp 换算的下限（100px 内容、44px 下限 → 0.44）
        assertEquals(0.44f, CropMath.minSizeNorm(100, 44), DELTA);
    }
}
