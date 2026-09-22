package com.jty.safetyquiz;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.view.ViewGroup;

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

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private boolean previewRunning = false;
    private ProcessCameraProvider provider;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private Executor mainExecutor() {
        return task -> mainHandler.post(task);
    }

    private Context ctx() { return getContext(); }

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
            root.addView(previewView, 0,
                    new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        }

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
     * Bitmap ownership 规则（管线是 rawBitmap → normalized → mainBitmap → layoutBitmap 的单向链，
     * 每个变量只拥有"本阶段转换产物"；某阶段不做转换时，该变量就是上一阶段的同一引用）：
     *   rawBitmap    = decode 后唯一拥有
     *   normalized   = rotate 后唯一拥有（无旋转时 == rawBitmap）
     *   mainBitmap   = 最终正式 OCR 图（宽 ≤ maxW 时 == normalized）
     *   layoutBitmap = 独立低分辨率布局图（宽 ≤ layW 时 == mainBitmap）
     * finally 沿别名链回收：每张 Bitmap 恰好 recycle 一次；decode/rotate/resize/encode
     * 全部完成后位图才允许释放，任何阶段抛异常也都由 finally 兜底回收。
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

            normalized = rawBitmap;
            if (rotation != 0) {
                Matrix m = new Matrix();
                m.postRotate(rotation);
                Bitmap r = Bitmap.createBitmap(rawBitmap, 0, 0, sensorW, sensorH, m, true);
                if (r != normalized) { normalized.recycle(); }
                normalized = r;
            }
            int normW = normalized.getWidth();
            int normH = normalized.getHeight();

            mainBitmap = normalized;
            if (normW > maxW) {
                float ratio = (float) maxW / normW;
                Matrix m = new Matrix();
                m.postScale(ratio, ratio);
                Bitmap s = Bitmap.createBitmap(normalized, 0, 0, normW, normH, m, true);
                if (s != mainBitmap) { mainBitmap.recycle(); }
                mainBitmap = s;
            }
            String dataUrl = toDataUrl(mainBitmap, qual);
            int outW = mainBitmap.getWidth();
            int outH = mainBitmap.getHeight();

            layoutBitmap = mainBitmap;
            if (layW > 0 && mainBitmap.getWidth() > layW) {
                float ratio = (float) layW / mainBitmap.getWidth();
                Matrix m = new Matrix();
                m.postScale(ratio, ratio);
                layoutBitmap = Bitmap.createBitmap(mainBitmap, 0, 0,
                        mainBitmap.getWidth(), mainBitmap.getHeight(), m, true);
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
            return ret;
        } finally {
            if (layoutBitmap != null && layoutBitmap != mainBitmap) { layoutBitmap.recycle(); }
            if (mainBitmap != null && mainBitmap != normalized) { mainBitmap.recycle(); }
            if (normalized != null && normalized != rawBitmap) { normalized.recycle(); }
            if (rawBitmap != null) { rawBitmap.recycle(); }
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
        mainExecutor().execute(this::stopPreviewOnly);
        if (call != null) { call.resolve(); }
    }

    private void stopPreviewOnly() {
        previewRunning = false;
        if (provider != null) { try { provider.unbindAll(); } catch (Exception ignored) { } }
        if (previewView != null && previewView.getParent() != null) {
            ((ViewGroup) previewView.getParent()).removeView(previewView);
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopPreviewOnly();
        super.handleOnDestroy();
    }
}
