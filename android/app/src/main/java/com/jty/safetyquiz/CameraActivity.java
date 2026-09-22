package com.jty.safetyquiz;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.BitmapDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生相机页：LIVE（CameraX PreviewView 铺满 + 顶部返回 + 底部圆形快门）与
 * REVIEW（冻结照片 + CropOverlayView + 重拍/✓）属于同一个 Native View hierarchy，
 * 与 WebView 完全独立（不再有 WebView 透明 / 相机透出方案）。
 *
 * 交互：快门捕获 → 立即进 REVIEW 并显示默认框（不等 OCR）→ 后台用 1280px 布局图
 * 跑 ML Kit，suggestQuizCrop（Java 等价移植）出自动框；用户碰过框则迟到结果作废。
 * ✓ → 回投 cropNormalized + 全尺寸字段给 InAppCameraPlugin → 关闭本页。
 * 返回键：LIVE 取消关闭；REVIEW 回 LIVE（与重拍一致）。
 */
public class CameraActivity extends AppCompatActivity {

    public static final String EXTRA_MAX_WIDTH = "maxWidth";
    public static final String EXTRA_QUALITY = "quality";
    public static final String EXTRA_LAYOUT_MAX_WIDTH = "layoutMaxWidth";

    /** 正式 OCR 图期望分辨率：接近 4:3 高分辨率上限（宽上限 3000），禁改项。 */
    private static final int TARGET_CAPTURE_W = 3000;
    private static final int TARGET_CAPTURE_H = 4000;
    /** REVIEW 默认框边距，与 JS CROP_DEFAULT_MARGIN 一致。 */
    private static final float DEFAULT_CROP_MARGIN = 0.04f;

    static final int STATE_LIVE = 0;
    static final int STATE_REVIEW = 1;

    private int state = STATE_LIVE;
    private int maxWidth = 3000;
    private int quality = 85;
    private int layoutMaxWidth = 1280;

    private PreviewView previewView;
    private View reviewRoot;
    private ImageView reviewImage;
    private CropOverlayView cropOverlay;
    private ImageButton shutterBtn;
    private View liveBottomBar;
    private TextView tipView;

    @Nullable
    private ProcessCameraProvider provider;
    @Nullable
    private ImageCapture imageCapture;
    private boolean cameraBound;
    private boolean capturing;

    /** 冻结页（正式图/布局图 JPEG 字节 + 全部尺寸）；重拍时置 null 释放。 */
    @Nullable
    private CapturedPage captured;
    /** REVIEW 显示位图（解码自布局图），经 setReviewBitmap 保证恰好 recycle 一次。 */
    @Nullable
    private Bitmap reviewBitmap;
    private boolean autoCropPending;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService captureExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService ocrExecutor = Executors.newSingleThreadExecutor();

    private Executor mainExecutor() {
        return task -> mainHandler.post(task);
    }

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_camera);

        Intent in = getIntent();
        maxWidth = in.getIntExtra(EXTRA_MAX_WIDTH, 3000);
        quality = in.getIntExtra(EXTRA_QUALITY, 85);
        layoutMaxWidth = in.getIntExtra(EXTRA_LAYOUT_MAX_WIDTH, 1280);

        previewView = findViewById(R.id.cam_preview);
        reviewRoot = findViewById(R.id.cam_review_root);
        reviewImage = findViewById(R.id.cam_review_image);
        cropOverlay = findViewById(R.id.cam_crop_overlay);
        shutterBtn = findViewById(R.id.cam_shutter);
        liveBottomBar = findViewById(R.id.cam_live_bottom);
        tipView = findViewById(R.id.cam_tip);
        ImageButton backBtn = findViewById(R.id.cam_back);
        TextView retakeBtn = findViewById(R.id.cam_retake);
        ImageButton confirmBtn = findViewById(R.id.cam_confirm);

        backBtn.setOnClickListener(v -> onBack());
        shutterBtn.setOnClickListener(v -> onShutter());
        retakeBtn.setOnClickListener(v -> onRetake());
        confirmBtn.setOnClickListener(v -> onConfirm());
        cropOverlay.setOnCropUserTouchListener(() -> {
            if (autoCropPending) { setTip(null); }
        });
        // 相机就绪前快门置灰：避免启动抢拍被静默吞掉
        shutterBtn.setEnabled(false);

        // 权限是启动前置条件（插件已确认过）；此处兜底：异常进入直接取消
        if (!hasCameraPermission()) {
            NativeCameraSession.deliverCancel();
            finish();
            return;
        }
        bindCamera();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) { applyImmersive(); }
    }

    private void applyImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyImmersive();
        reviewImage.post(this::updateContentRect);
    }

    private void bindCamera() {
        if (cameraBound || state != STATE_LIVE || isFinishing()) { return; }
        ProcessCameraProvider.getInstance(getApplicationContext()).addListener(() -> {
            try {
                ProcessCameraProvider provider = ProcessCameraProvider
                        .getInstance(getApplicationContext()).get();
                this.provider = provider;
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                // 分辨率策略保持已验证配置：请求 3000×4000，最接近更高优先，无更高取更低
                ImageCapture ic = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setResolutionSelector(new ResolutionSelector.Builder()
                                .setResolutionStrategy(new ResolutionStrategy(
                                        new android.util.Size(TARGET_CAPTURE_W, TARGET_CAPTURE_H),
                                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                                .build())
                        .build();
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, ic);
                imageCapture = ic;
                cameraBound = true;
                if (state == STATE_LIVE) { shutterBtn.setEnabled(true); }
            } catch (Exception e) {
                setTip("相机启动失败，请返回后重试");
            }
        }, mainExecutor());
    }

    /* ---------------- LIVE → 捕获 ---------------- */

    private void onShutter() {
        if (state != STATE_LIVE || capturing || imageCapture == null) { return; }
        capturing = true;
        shutterBtn.setEnabled(false);
        setTip("正在捕获…");
        final ImageCapture ic = imageCapture;
        ic.takePicture(mainExecutor(), new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@NonNull ImageProxy proxy) {
                captureExecutor.execute(() -> {
                    CapturedPage page = null;
                    Exception failure = null;
                    try {
                        page = CapturedPage.fromImageProxy(proxy, maxWidth, quality, layoutMaxWidth);
                    } catch (Exception e) {
                        failure = e;
                    }
                    final CapturedPage finalPage = page;
                    final Exception finalFailure = failure;
                    mainHandler.post(() -> {
                        capturing = false;
                        shutterBtn.setEnabled(true);
                        if (finalPage == null) {
                            setTip("捕获失败，请再按一次快门（"
                                    + (finalFailure != null ? String.valueOf(finalFailure.getMessage()) : "unknown") + "）");
                            return;
                        }
                        enterReview(finalPage);
                    });
                });
            }

            @Override
            public void onError(@NonNull ImageCaptureException e) {
                mainHandler.post(() -> {
                    capturing = false;
                    shutterBtn.setEnabled(true);
                    setTip("拍摄失败，请重试");
                });
            }
        });
    }

    /** 仅测试用：CameraX 是否已绑定（快门可用）。 */
    boolean isCameraBoundForTest() { return cameraBound; }

    /* ---------------- REVIEW ---------------- */

    private void enterReview(@NonNull CapturedPage page) {
        captured = page;
        state = STATE_REVIEW;
        liveBottomBar.setVisibility(View.GONE);
        // previewView 保持可见：不透明 review 层盖住即可，重拍回到 LIVE 无需重建 surface
        reviewRoot.setVisibility(View.VISIBLE);

        Bitmap bm = page.decodeLayoutBitmap();
        setReviewBitmap(bm);

        // 第一时间显示默认框（不等待 OCR），随后后台自动定位
        cropOverlay.resetUserTouched();
        updateContentRect();
        cropOverlay.setCropNorm(DEFAULT_CROP_MARGIN, DEFAULT_CROP_MARGIN,
                1 - DEFAULT_CROP_MARGIN, 1 - DEFAULT_CROP_MARGIN);
        autoCropPending = true;
        setTip("正在自动定位题目区域…");
        reviewImage.post(this::updateContentRect);
        kickAutoCrop(page);
    }

    /** FIT_CENTER letterbox 计算：照片内容实际显示区域 → 传给裁剪框。 */
    private void updateContentRect() {
        Bitmap bm = reviewBitmap;
        if (bm == null || reviewImage.getWidth() <= 0 || reviewImage.getHeight() <= 0) { return; }
        CropMath.Rect content = CropMath.fitCenter(
                reviewImage.getWidth(), reviewImage.getHeight(),
                bm.getWidth(), bm.getHeight());
        RectF rectF = new RectF(content.left, content.top, content.right, content.bottom);
        cropOverlay.setContentRect(rectF);
    }

    private void setReviewBitmap(@Nullable Bitmap next) {
        Bitmap old = reviewBitmap;
        reviewBitmap = next;
        reviewImage.setImageDrawable(next == null ? null : new BitmapDrawable(getResources(), next));
        if (old != null && old != next && !old.isRecycled()) { old.recycle(); }
    }

    /** 后台 1280px 布局图 OCR → QuizCropSuggester 自动框；用户已碰框则作废。 */
    private void kickAutoCrop(@NonNull CapturedPage page) {
        ocrExecutor.execute(() -> {
            Bitmap bmp = BitmapFactory.decodeByteArray(page.layoutJpeg, 0, page.layoutJpeg.length);
            if (bmp == null) {
                mainHandler.post(() -> onAutoCropDone(null));
                return;
            }
            InputImage image = InputImage.fromBitmap(bmp, 0);
            TextRecognizer recognizer = TextRecognition.getClient(
                    new ChineseTextRecognizerOptions.Builder().build());
            recognizer.process(image)
                    .addOnSuccessListener(text -> {
                        List<QuizCropSuggester.OcrLine> lines = new ArrayList<>();
                        for (Text.TextBlock block : text.getTextBlocks()) {
                            for (Text.Line line : block.getLines()) {
                                String t = line.getText();
                                Rect r = line.getBoundingBox();
                                if (t == null || t.trim().isEmpty() || r == null) { continue; }
                                lines.add(new QuizCropSuggester.OcrLine(t,
                                        (double) r.top, (double) r.bottom,
                                        (double) r.left, (double) r.right));
                            }
                        }
                        QuizCropSuggester.SuggestResult sug = QuizCropSuggester.suggestQuizCrop(
                                lines, bmp.getWidth(), bmp.getHeight());
                        recognizer.close();
                        bmp.recycle();
                        mainHandler.post(() -> onAutoCropDone(sug));
                    })
                    .addOnFailureListener(e -> {
                        recognizer.close();
                        bmp.recycle();
                        mainHandler.post(() -> onAutoCropDone(null));
                    });
        });
    }

    private void onAutoCropDone(@Nullable QuizCropSuggester.SuggestResult sug) {
        autoCropPending = false;
        if (state != STATE_REVIEW) { return; }
        if (cropOverlay.hasUserTouched()) { return; }   // 人工框优先，迟到结果作废
        if (sug != null && sug.crop != null) {
            cropOverlay.setCropNorm((float) sug.crop[0], (float) sug.crop[1],
                    (float) sug.crop[2], (float) sug.crop[3]);
            setTip("ok".equals(sug.reason)
                    ? "已自动框出题目区域，可拖动四角微调"
                    : "已粗略框出题目区域，建议拖动四角对准题目");
        } else {
            setTip("请框住需要识别的题目区域");
        }
    }

    private void onRetake() {
        if (state != STATE_REVIEW || capturing) { return; }
        enterLive();
    }

    private void enterLive() {
        state = STATE_LIVE;
        captured = null;
        autoCropPending = false;
        setReviewBitmap(null);
        reviewRoot.setVisibility(View.GONE);
        liveBottomBar.setVisibility(View.VISIBLE);
        shutterBtn.setEnabled(false);   // 重新绑定完成后再启用
        setTip(null);
        cameraBound = false;
        bindCamera();
    }

    /* ---------------- 确认 / 返回 ---------------- */

    private void onConfirm() {
        if (state != STATE_REVIEW || captured == null) { return; }
        CropMath.Rect c = cropOverlay.getCropNorm();
        JSObject ret = captured.toJsObject();
        JSObject crop = new JSObject();
        crop.put("left", c.left);
        crop.put("top", c.top);
        crop.put("right", c.right);
        crop.put("bottom", c.bottom);
        ret.put("cropNormalized", crop);
        ret.put("userAdjustedCrop", cropOverlay.hasUserTouched());
        NativeCameraSession.deliverResult(ret);
        finish();
    }

    private void onBack() {
        if (state == STATE_REVIEW) {
            onRetake();
            return;
        }
        NativeCameraSession.deliverCancel();
        finish();
    }

    @Deprecated
    @Override
    public void onBackPressed() {
        onBack();
    }

    private void setTip(@Nullable String text) {
        boolean show = text != null && !text.isEmpty();
        tipView.setText(text == null ? "" : text);
        tipView.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    /** 仅测试用：当前状态（STATE_LIVE / STATE_REVIEW）。 */
    int getStateForTest() { return state; }

    /** 仅测试用：REVIEW 显示位图（验证冻结照片已解码展示）。 */
    @Nullable
    Bitmap getReviewBitmapForTest() { return reviewBitmap; }

    /** 仅测试用：自动框任务是否仍在进行（并发窗口断言）。 */
    boolean isAutoCropPendingForTest() { return autoCropPending; }

    @Override
    protected void onDestroy() {
        // 若未经 confirm/cancel 就被系统销毁，兜底释放挂起的调用（已交付时为空操作）
        NativeCameraSession.deliverCancel();
        captureExecutor.shutdownNow();
        ocrExecutor.shutdownNow();
        setReviewBitmap(null);
        if (provider != null) {
            try { provider.unbindAll(); } catch (Exception ignored) { }
        }
        super.onDestroy();
    }
}
