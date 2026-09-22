package com.jty.safetyquiz;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
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
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "InAppCamera", permissions = {
        @Permission(strings = { Manifest.permission.CAMERA })
})
public class InAppCameraPlugin extends Plugin {

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private boolean previewRunning = false;
    private final Executor bgExecutor = Executors.newSingleThreadExecutor();

    private boolean hasPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void start(final PluginCall call) {
        if (!hasPermission()) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                doStart(call);
            } catch (Exception e) {
                call.reject("CAMERA_START_FAILED", e.getMessage());
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
        bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);

        ProcessCameraProvider.getInstance(ctx()).addListener(() -> {
            try {
                ProcessCameraProvider provider = ProcessCameraProvider.getInstance(ctx()).get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ResolutionSelector selector = new ResolutionSelector.Builder()
                        .setResolutionStrategy(new ResolutionStrategy(
                                new Size(3000, 4000),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                        .build();

                ImageCapture.Builder capBuilder = new ImageCapture.Builder()
                        .setResolutionSelector(selector)
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY);

                ImageCapture capture = capBuilder.build();
                provider.unbindAll();
                Camera camera = provider.bindToLifecycle(
                        (LifecycleOwner) activity,
                        CameraSelector.DEFAULT_BACK_CAMERA, preview, capture);
                this.imageCapture = capture;
                this.provider = provider;
                previewRunning = true;
                call.resolve();
            } catch (Exception e) {
                call.reject("CAMERA_BIND_FAILED", e.getMessage());
            }
        }, ContextCompat.getMainExecutor(ctx()));
    }

    private Context ctx() { return getContext(); }

    @PluginMethod
    public void capture(final PluginCall call) {
        if (!hasPermission()) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        if (imageCapture == null || !previewRunning) {
            call.reject("CAMERA_NOT_STARTED");
            return;
        }
        int maxWidth = call.getInt("maxWidth", 3000);
        int quality = call.getInt("quality", 85);
        int layoutMaxWidth = call.getInt("layoutMaxWidth", 1280);
        Executor main = command -> new android.os.Handler(android.os.Looper.getMainLooper()).post(command);
        imageCapture.takePicture(main, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(ImageProxy proxy) {
                new Thread(() -> {
                    try {
                        JSObject ret = processProxy(proxy, maxWidth, quality, layoutMaxWidth);
                        getActivity().runOnUiThread(() -> stopPreviewOnly());
                        call.resolve(ret);
                    } catch (Exception e) {
                        getActivity().runOnUiThread(() -> stopPreviewOnly());
                        call.reject("PROCESS_FAILED", e.getMessage());
                    }
                }).start();
            }

            @Override
            public void onError(ImageCaptureException e) {
                call.reject("CAPTURE_FAILED", e.getMessage());
            }
        });
    }

    /**
     * 处理拍摄结果。Bitmap ownership 规则：
     *   rawBitmap   → decode 产出，方法末尾统一 recycle
     *   mainBitmap  → 缩放后的正式 OCR 输入（dataUrl 已在 recycle 前编码完毕）
     *   layoutBitmap → 缩放后的低分辨率副本（layoutDataUrl 已在 recycle 前编码完毕）
     * 每一步的中间 Bitmap 在不再需要时立即 recycle。
     */
    private JSObject processProxy(ImageProxy proxy, int maxWidth, int quality, int layoutMaxWidth) {
        if (proxy.getFormat() != ImageFormat.JPEG) {
            proxy.close();
            throw new IllegalArgumentException("UNSUPPORTED_FORMAT");
        }
        ByteBuffer buf = proxy.getPlanes()[0].getBuffer();
        byte[] bytes = new byte[buf.remaining()];
        buf.get(bytes);
        int rotation = proxy.getImageInfo().getRotationDegrees();
        proxy.close();

        // ---- 解码 + 旋转 ----
        Bitmap rawBitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (rawBitmap == null) {
            throw new IllegalArgumentException("DECODE_FAILED");
        }
        int sensorW = rawBitmap.getWidth();
        int sensorH = rawBitmap.getHeight();
        if (rotation != 0) {
            Matrix m = new Matrix();
            m.postRotate(rotation);
            Bitmap r = Bitmap.createBitmap(rawBitmap, 0, 0,
                    rawBitmap.getWidth(), rawBitmap.getHeight(), m, true);
            if (r != rawBitmap) { rawBitmap.recycle(); }
            rawBitmap = r;
        }
        int normalizedW = rawBitmap.getWidth();
        int normalizedH = rawBitmap.getHeight();

        // ---- 主图缩放（只缩不放）----
        Bitmap mainBitmap = rawBitmap;
        if (normalizedW > maxWidth) {
            float ratio = (float) maxWidth / normalizedW;
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            Bitmap s = Bitmap.createBitmap(rawBitmap, 0, 0,
                    normalizedW, normalizedH, m, true);
            rawBitmap.recycle();
            mainBitmap = s;
        }

        // ---- dataUrl 编码（recycle 前读取全部像素信息）----
        String dataUrl = bitmapToDataUrl(mainBitmap, quality);
        int mainW = mainBitmap.getWidth();
        int mainH = mainBitmap.getHeight();

        // ---- 布局图缩放 ----
        Bitmap layoutBitmap = mainBitmap;
        boolean layoutIsCopy = false;
        if (layoutMaxWidth > 0 && mainBitmap.getWidth() > layoutMaxWidth) {
            float ratio = (float) layoutMaxWidth / mainBitmap.getWidth();
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            layoutBitmap = Bitmap.createBitmap(mainBitmap, 0, 0,
                    mainBitmap.getWidth(), mainBitmap.getHeight(), m, true);
            layoutIsCopy = true;
        }
        String layoutUrl = bitmapToDataUrl(layoutBitmap, 70);
        int layoutW = layoutBitmap.getWidth();
        int layoutH = layoutBitmap.getHeight();
        if (layoutIsCopy) { layoutBitmap.recycle(); }
        mainBitmap.recycle();
        rawBitmap.recycle();

        // ---- 组装返回 ----
        JSObject ret = new JSObject();
        ret.put("dataUrl", dataUrl);
        ret.put("width", mainW);
        ret.put("height", mainH);
        ret.put("layoutDataUrl", layoutUrl);
        ret.put("layoutWidth", layoutW);
        ret.put("layoutHeight", layoutH);
        ret.put("sensorWidth", sensorW);
        ret.put("sensorHeight", sensorH);
        ret.put("normalizedWidth", normalizedW);
        ret.put("normalizedHeight", normalizedH);
        ret.put("outputWidth", mainW);
        ret.put("outputHeight", mainH);
        return ret;
    }


    static String bitmapToDataUrl(Bitmap b, int quality) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, quality, bo);
        return "data:image/jpeg;base64,"
                + android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            previewRunning = false;
            if (provider != null) { try { provider.unbindAll(); } catch (Exception ignored) { } }
            if (previewView != null && previewView.getParent() != null) {
                ((ViewGroup) previewView.getParent()).removeView(previewView);
            }
            if (call != null) { call.resolve(); }
        });
    }

    @Override
    protected void handleOnDestroy() {
        previewRunning = false;
        if (provider != null) { try { provider.unbindAll(); } catch (Exception ignored) { } }
        if (previewView != null && previewView.getParent() != null) {
            ((ViewGroup) previewView.getParent()).removeView(previewView);
        }
        super.handleOnDestroy();
    }

    private ProcessCameraProvider provider;
}
