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
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
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

@CapacitorPlugin(name = "InAppCamera", permissions = {
        @Permission(strings = { Manifest.permission.CAMERA })
})
public class InAppCameraPlugin extends Plugin {

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
        bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);

        ProcessCameraProvider.getInstance(ctx()).addListener(() -> {
            try {
                ProcessCameraProvider provider = ProcessCameraProvider.getInstance(ctx()).get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                ImageCapture.Builder cb = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY);
                ImageCapture ic = cb.build();
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
        if (proxy.getFormat() != ImageFormat.JPEG) {
            proxy.close();
            throw new IllegalArgumentException("UNSUPPORTED_FORMAT");
        }
        ByteBuffer buf = proxy.getPlanes()[0].getBuffer();
        byte[] bytes = new byte[buf.remaining()];
        buf.get(bytes);
        int rotation = proxy.getImageInfo().getRotationDegrees();
        proxy.close();

        Bitmap raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (raw == null) {
            throw new IllegalArgumentException("DECODE_FAILED");
        }
        int sensorW = raw.getWidth();
        int sensorH = raw.getHeight();
        if (rotation != 0) {
            Matrix m = new Matrix();
            m.postRotate(rotation);
            Bitmap r = Bitmap.createBitmap(raw, 0, 0, raw.getWidth(), raw.getHeight(), m, true);
            if (r != raw) { raw.recycle(); }
            raw = r;
        }
        int normW = raw.getWidth();
        int normH = raw.getHeight();

        Bitmap main = raw;
        if (normW > maxW) {
            float ratio = (float) maxW / normW;
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            Bitmap s = Bitmap.createBitmap(raw, 0, 0, normW, normH, m, true);
            if (s != raw) { raw.recycle(); }
            main = s;
        }
        String dataUrl = toDataUrl(main, qual);
        int outW = main.getWidth();
        int outH = main.getHeight();

        Bitmap layout = main;
        if (layW > 0 && main.getWidth() > layW) {
            float ratio = (float) layW / main.getWidth();
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            layout = Bitmap.createBitmap(main, 0, 0, main.getWidth(), main.getHeight(), m, true);
        }
        String layoutUrl = toDataUrl(layout, 70);
        int layW2 = layout.getWidth();
        int layH2 = layout.getHeight();
        if (layout != main) { layout.recycle(); }
        main.recycle();
        raw.recycle();

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
    }

    private String toDataUrl(Bitmap b, int q) {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
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

    private ProcessCameraProvider provider;
}
