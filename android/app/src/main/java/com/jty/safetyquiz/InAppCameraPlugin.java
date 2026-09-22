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
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "InAppCamera", permissions = {
        @Permission(strings = { Manifest.permission.CAMERA })
})
public class InAppCameraPlugin extends Plugin {

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private boolean previewRunning = false;

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
        Context ctx = getContext();
        Activity activity = getActivity();
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (previewView == null) {
            previewView = new PreviewView(ctx);
        }
        if (previewView.getParent() == null) {
            root.addView(previewView, 0,
                    new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        }
        bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);

        ProcessCameraProvider.getInstance(ctx).addListener(() -> {
            try {
                ProcessCameraProvider provider = ProcessCameraProvider.getInstance(ctx).get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                ImageCapture.Builder builder = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY);
                ImageCapture capture = builder.build();
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
        }, command -> new android.os.Handler(android.os.Looper.getMainLooper()).post(command));
    }

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

    private JSObject processProxy(ImageProxy proxy, int maxWidth, int quality, int layoutMaxWidth) {
        if (proxy.getFormat() != ImageFormat.JPEG) {
            throw new IllegalArgumentException("UNSUPPORTED_FORMAT");
        }
        ByteBuffer buf = proxy.getPlanes()[0].getBuffer();
        byte[] bytes = new byte[buf.remaining()];
        buf.get(bytes);
        int rotation = proxy.getImageInfo().getRotationDegrees();
        proxy.close();

        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) { throw new IllegalArgumentException("DECODE_FAILED"); }
        if (rotation != 0) {
            Matrix m = new Matrix();
            m.postRotate(rotation);
            Bitmap r = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (r != bmp) { bmp.recycle(); }
            bmp = r;
        }
        if (bmp.getWidth() > maxWidth) {
            float ratio = (float) maxWidth / bmp.getWidth();
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            Bitmap s = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (s != bmp) { bmp.recycle(); }
            bmp = s;
        }
        String dataUrl = bitmapToDataUrl(bmp, quality);
        Bitmap layout = bmp;
        if (layoutMaxWidth > 0 && bmp.getWidth() > layoutMaxWidth) {
            float ratio = (float) layoutMaxWidth / bmp.getWidth();
            Matrix m = new Matrix();
            m.postScale(ratio, ratio);
            Bitmap s = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (s != bmp) { layout.recycle(); }
            layout = s;
        }
        String layoutUrl = bitmapToDataUrl(layout, 70);
        if (layout != bmp) { layout.recycle(); }

        JSObject ret = new JSObject();
        ret.put("dataUrl", dataUrl);
        ret.put("width", bmp.getWidth());
        ret.put("height", bmp.getHeight());
        ret.put("layoutDataUrl", layoutUrl);
        ret.put("layoutWidth", layout.getWidth());
        ret.put("layoutHeight", layout.getHeight());
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
    }

    @Override
    protected void handleOnDestroy() {
        stopPreviewOnly();
        super.handleOnDestroy();
    }

    private ProcessCameraProvider provider;
}
