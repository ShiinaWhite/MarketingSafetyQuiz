package com.jty.safetyquiz;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.camera.core.Camera;
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
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "InAppCamera", permissions = {
        @Permission(strings = { Manifest.permission.CAMERA })
})
public class InAppCameraPlugin extends Plugin {

    /** 正式 OCR 图期望分辨率：接近 4:3 高分辨率上限（宽上限 3000，超宽再缩）。 */
    private static final int TARGET_CAPTURE_W = 3000;
    private static final int TARGET_CAPTURE_H = 4000;

    /**
     * 相机非取景期的 WebView 正常底色。本应用 capacitor.config.json 未配置
     * backgroundColor，Capacitor Bridge 不会调用 setBackgroundColor，
     * WebView 默认底色即白色；stop 时恢复到该状态，避免其它页面被透明化。
     */
    private static final int WEBVIEW_NORMAL_BG = Color.WHITE;

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private boolean previewRunning = false;
    private ProcessCameraProvider provider;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** WebView 透明态跟踪：取景期间为 true，恢复后为 false（供测试与防重入使用）。 */
    private boolean webViewTransparent = false;
    /** 进入相机前 WebView 的 View 层背景（可能为 null），stop 时原样恢复。 */
    private Drawable webViewBackground;

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private Executor mainExecutor() {
        return task -> mainHandler.post(task);
    }

    private Context ctx() { return getContext(); }

    /** 仅测试用：WebView 是否处于透出相机取景的透明态。 */
    boolean isWebViewTransparentForTest() { return webViewTransparent; }

    @PluginMethod
    public void start(final PluginCall call) {
        if (!hasCameraPermission()) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        mainExecutor().execute(() -> {
            try {
                doStart(call);
            } catch (Exception e) {
                call.reject("CAMERA_START_FAILED", e != null ? e.getMessage() : "unknown");
            }
        });
    }

    private void doStart(PluginCall call) throws Exception {
        Activity activity = getActivity();
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (previewView == null) {
            previewView = new PreviewView(ctx());
        }
        if (previewView.getParent() == null) {
            // 插到 content 第 0 个：PreviewView 位于 WebView(CoordinatorLayout) 下层
            root.addView(previewView, 0,
                    new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        }
        makeWebViewTransparent();

        ProcessCameraProvider.getInstance(ctx()).addListener(() -> {
            try {
                ProcessCameraProvider provider = ProcessCameraProvider.getInstance(ctx()).get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                // 分辨率策略：请求 3000×4000（4:3 高分辨率上限），优先取最接近的更高分辨率，
                // 没有更高则取最接近的更低分辨率；设备达不到 3000 时如实保留实际宽度。
                ImageCapture ic = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setResolutionSelector(new ResolutionSelector.Builder()
                                .setResolutionStrategy(new ResolutionStrategy(
                                        new Size(TARGET_CAPTURE_W, TARGET_CAPTURE_H),
                                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                                .build())
                        .build();
                provider.unbindAll();
                Camera camera = provider.bindToLifecycle(
                        (LifecycleOwner) activity,
                        CameraSelector.DEFAULT_BACK_CAMERA, preview, ic);
                this.imageCapture = ic;
                this.provider = provider;
                previewRunning = true;
                call.resolve();
            } catch (Exception e) {
                call.reject("CAMERA_BIND_FAILED", e != null ? e.getMessage() : "bind");
            }
        }, mainExecutor());
    }

    /**
     * WebView 默认底色不透明，真机会盖住下层的 PreviewView。
     * HTML 侧已有 body.native-camera-live 透明 CSS，这里补齐原生两层：
     * ① WebView 内部底色 setBackgroundColor(TRANSPARENT)（该值无读取接口，
     *    因此用 webViewTransparent 布尔显式跟踪状态，stop 恢复为 WEBVIEW_NORMAL_BG）；
     * ② View 层背景换成透明 ColorDrawable（可读，测试直接断言），
     *    原背景 Drawable 先保存，stopPreviewOnly 原样恢复。
     */
    private void makeWebViewTransparent() {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null || webViewTransparent) { return; }
        webViewBackground = webView.getBackground();
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setBackground(new ColorDrawable(Color.TRANSPARENT));
        webViewTransparent = true;
    }

    private void restoreWebViewBackground() {
        if (!webViewTransparent) { return; }
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) { return; }
        webView.setBackgroundColor(WEBVIEW_NORMAL_BG);
        webView.setBackground(webViewBackground);
        webViewBackground = null;
        webViewTransparent = false;
    }

    @PluginMethod
    public void capture(final PluginCall call) {
        if (!hasCameraPermission()) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        ImageCapture ic = imageCapture;
        if (ic == null || !previewRunning) {
            call.reject("CAMERA_NOT_STARTED");
            return;
        }
        int maxW = call.getInt("maxWidth", 3000);
        int qual = call.getInt("quality", 85);
        int layW = call.getInt("layoutMaxWidth", 1280);
        ic.takePicture(mainExecutor(), new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(ImageProxy proxy) {
                new Thread(() -> {
                    try {
                        JSObject ret = processProxy(proxy, maxW, qual, layW);
                        mainExecutor().execute(() -> stopPreviewOnly());
                        call.resolve(ret);
                    } catch (Exception e) {
                        mainExecutor().execute(() -> stopPreviewOnly());
                        call.reject("PROCESS_FAILED", e != null ? e.getMessage() : "process");
                    }
                }).start();
            }

            @Override
            public void onError(ImageCaptureException e) {
                call.reject("CAPTURE_FAILED", e != null ? e.getMessage() : "capture");
            }
        });
    }

    private JSObject processProxy(ImageProxy proxy, int maxW, int qual, int layW) {
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
        return processJpeg(jpeg, rotation, maxW, qual, layW);
    }

    /**
     * Bitmap ownership 规则（移动语义：任一时刻每个变量要么为 null，
     * 要么是某张 Bitmap 的唯一持有者，绝无两个变量同时引用同一张活图）：
     *   rawBitmap    = decode 产物
     *   normalized   = 旋转归一化产物（无旋转时直接接管 rawBitmap，rawBitmap 置 null）
     *   mainBitmap   = 正式 OCR 图（宽 ≤ maxW 时直接接管 normalized）
     *   layoutBitmap = 布局图（宽 ≤ layW 时直接接管 mainBitmap）
     * 每个阶段结束时，上一阶段产物在完成"作为新图的采样源"这一最后用途后
     * 立即 recycle 并把变量置 null，因此每个实例整个生命周期恰好 recycle 一次；
     * finally 只兜底回收仍非空的变量（异常路径同样恰好一次），无 use-after-recycle。
     */
    static JSObject processJpeg(byte[] jpegBytes, int rotation, int maxW, int qual, int layW) {
        Bitmap rawBitmap = null;
        Bitmap normalized = null;
        Bitmap mainBitmap = null;
        Bitmap layoutBitmap = null;
        try {
            rawBitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
            if (rawBitmap == null) {
                throw new IllegalArgumentException("DECODE_FAILED");
            }
            int sensorW = rawBitmap.getWidth();
            int sensorH = rawBitmap.getHeight();

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
            int normW = normalized.getWidth();
            int normH = normalized.getHeight();

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
            String dataUrl = toDataUrl(mainBitmap, qual);
            int outW = mainBitmap.getWidth();
            int outH = mainBitmap.getHeight();

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
            String layoutUrl = toDataUrl(layoutBitmap, 70);
            int layW2 = layoutBitmap.getWidth();
            int layH2 = layoutBitmap.getHeight();

            JSObject ret = new JSObject();
            ret.put("dataUrl", dataUrl);
            ret.put("width", outW);
            ret.put("height", outH);
            ret.put("layoutDataUrl", layoutUrl);
            ret.put("layoutWidth", layW2);
            ret.put("layoutHeight", layH2);
            ret.put("sensorWidth", sensorW);
            ret.put("sensorHeight", sensorH);
            ret.put("normalizedWidth", normW);
            ret.put("normalizedHeight", normH);
            ret.put("outputWidth", outW);
            ret.put("outputHeight", outH);

            layoutBitmap.recycle();
            layoutBitmap = null;
            return ret;
        } finally {
            // 兜底：异常路径下仅回收"仍在变量手里"的实例；正常路径全部已置 null。
            // 因为从不别名，同一实例不可能被这里二次回收。
            if (rawBitmap != null) { rawBitmap.recycle(); }
            if (normalized != null) { normalized.recycle(); }
            if (mainBitmap != null) { mainBitmap.recycle(); }
            if (layoutBitmap != null) { layoutBitmap.recycle(); }
        }
    }

    private static String toDataUrl(Bitmap b, int q) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, q, bo);
        return "data:image/jpeg;base64,"
                + android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        mainExecutor().execute(() -> {
            stopPreviewOnly();
            if (call != null) { call.resolve(); }
        });
    }

    private void stopPreviewOnly() {
        previewRunning = false;
        if (provider != null) { try { provider.unbindAll(); } catch (Exception ignored) { } }
        if (previewView != null && previewView.getParent() != null) {
            ((ViewGroup) previewView.getParent()).removeView(previewView);
        }
        restoreWebViewBackground();
    }

    @Override
    protected void handleOnDestroy() {
        stopPreviewOnly();
        super.handleOnDestroy();
    }
}
