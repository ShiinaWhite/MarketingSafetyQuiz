package com.jty.safetyquiz;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.util.Random;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Bitmap 管线资源压力测试：连续 20 轮走 CapturedPage.process 真实管线
 * （decode → rotate → 主图缩放 → q85 编码 → 布局图缩放 → q70 编码 → recycle）。
 * 任何 use-after-recycle、双重 recycle、ImageProxy 泄漏式阻塞或 OOM 都会直接抛异常
 * 使测试失败；正常跑完即为本轮资源安全的实测证据。
 */
@RunWith(AndroidJUnit4.class)
public class BitmapPipelineStressTest {

    private static final int ITERATIONS_MAIN = 20;
    private static final int ITERATIONS_ROTATED = 10;

    private byte[] makeJpeg(int w, int h) {
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        c.drawColor(Color.WHITE);
        Paint p = new Paint();
        p.setColor(Color.BLACK);
        p.setTextSize(80);
        p.setAntiAlias(true);
        Random rnd = new Random(42);
        for (int i = 0; i < 40; i++) {
            c.drawText((i + 1) + ". 压力测试题干" + (char) ('甲' + rnd.nextInt(20)) + "乙丙丁",
                    60, (i + 1) * (h - 200) / 41 + 100, p);
        }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 92, bo);
        b.recycle();
        return bo.toByteArray();
    }

    @Test
    public void pipeline20x_decodeRotateResizeEncodeRecycle_noException() throws Exception {
        byte[] big = makeJpeg(4500, 3000); // 高于 3000 宽：必须触发旋转 0 + 主图缩放 + 布局缩放
        for (int i = 0; i < ITERATIONS_MAIN; i++) {
            CapturedPage page = CapturedPage.process(big, 0, 3000, 85, 1280);
            assertEquals("sensorWidth 应为解码原宽", 4500, page.sensorWidth);
            assertEquals("sensorHeight 应为解码原高", 3000, page.sensorHeight);
            assertEquals("normalizedWidth（无旋转）", 4500, page.normalizedWidth);
            assertEquals("outputWidth 应缩到 3000", 3000, page.outputWidth);
            assertEquals("outputHeight 等比", 2000, page.outputHeight);
            assertTrue("layoutWidth 应 ≤ 1280", page.layoutWidth <= 1280);
            assertTrue("正式图 dataUrl 应为 JPEG base64",
                    page.mainDataUrl().startsWith("data:image/jpeg;base64,"));
            assertTrue("布局图 dataUrl 应存在且非空", page.layoutDataUrl().length() > 100);
        }
    }

    @Test
    public void pipeline10x_rotated90_downscaleAfterRotate_noException() throws Exception {
        byte[] portrait = makeJpeg(3000, 4000); // 旋转 90° 后 4000×3000，再缩到 3000 宽
        for (int i = 0; i < ITERATIONS_ROTATED; i++) {
            CapturedPage page = CapturedPage.process(portrait, 90, 3000, 85, 1280);
            assertEquals("sensorWidth 为原始宽", 3000, page.sensorWidth);
            assertEquals("sensorHeight 为原始高", 4000, page.sensorHeight);
            assertEquals("normalizedWidth 应为旋转后的 4000", 4000, page.normalizedWidth);
            assertEquals("normalizedHeight 应为旋转后的 3000", 3000, page.normalizedHeight);
            assertEquals("outputWidth 应缩到 3000", 3000, page.outputWidth);
            assertEquals("outputHeight 等比 2250", 2250, page.outputHeight);
            assertTrue("layoutWidth 应 ≤ 1280", page.layoutWidth <= 1280);
        }
    }

    @Test
    public void pipeline_belowMaxWidth_keepsActualWidth_noFakeUpscale() throws Exception {
        // 设备本身低于 3000 宽时：不放大、不虚构 3000，如实保留实际宽度
        byte[] small = makeJpeg(1600, 1200);
        CapturedPage page = CapturedPage.process(small, 0, 3000, 85, 1280);
        assertEquals(1600, page.sensorWidth);
        assertEquals("低于 maxW 时不得放大", 1600, page.outputWidth);
        assertEquals(1200, page.outputHeight);
        assertTrue("正式图 dataUrl 应为 JPEG base64",
                page.mainDataUrl().startsWith("data:image/jpeg;base64,"));
    }
}
