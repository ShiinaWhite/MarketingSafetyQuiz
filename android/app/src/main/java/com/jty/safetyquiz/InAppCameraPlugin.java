package com.jty.safetyquiz;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * App 内相机插件：open() 打开原生相机页（CameraActivity），一次会话完成
 * LIVE 取景 → 拍照 → REVIEW 调框 → ✓ 确认，返回结果给 WebView 继续 OCR。
 *
 * 权限：alias = "camera"，checkPermissions/requestPermissions 返回的键即
 * "camera"（此前缺 alias 导致 JS 侧 perm.camera 永远为空、首装不弹授权框）。
 * 拒绝与永久拒绝通过错误码区分，文案由 JS 转成中文提示，不把裸码透给用户。
 */
@CapacitorPlugin(name = "InAppCamera", permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class InAppCameraPlugin extends Plugin {

    private boolean hasCameraPermission() {
        return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 打开原生相机。选项：maxWidth（默认 3000）/ quality（85）/ layoutMaxWidth（1280）。
     * resolve：完整结果（dataUrl/layoutDataUrl/尺寸/cropNormalized）或 {cancelled:true}；
     * reject：CAMERA_BUSY / CAMERA_PERMISSION_DENIED / CAMERA_PERMISSION_PERMANENTLY_DENIED。
     */
    @PluginMethod
    public void open(final PluginCall call) {
        if (hasCameraPermission()) {
            launchCamera(call);
            return;
        }
        // 首次安装/未授权：触发系统权限弹窗，结果走 cameraPermissionCallback
        requestPermissionForAlias("camera", call, "cameraPermissionCallback");
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (hasCameraPermission()) {
            launchCamera(call);
            return;
        }
        Activity activity = getActivity();
        // 拒绝后系统不再弹窗（“不再询问”）→ shouldShow 为 false → 引导去系统设置
        boolean permanentlyDenied = activity == null
                || !ActivityCompat.shouldShowRequestPermissionRationale(activity,
                        Manifest.permission.CAMERA);
        call.reject(permanentlyDenied
                        ? "CAMERA_PERMISSION_PERMANENTLY_DENIED"
                        : "CAMERA_PERMISSION_DENIED",
                permanentlyDenied ? "相机权限已被拒绝，请到系统设置中开启" : "相机权限未授予");
    }

    private void launchCamera(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            call.reject("CAMERA_START_FAILED", "宿主 Activity 不可用");
            return;
        }
        if (!NativeCameraSession.begin(call)) {
            call.reject("CAMERA_BUSY", "已有进行中的拍摄");
            return;
        }
        Intent intent = new Intent(activity, CameraActivity.class);
        intent.putExtra(CameraActivity.EXTRA_MAX_WIDTH, call.getInt("maxWidth", 3000));
        intent.putExtra(CameraActivity.EXTRA_QUALITY, call.getInt("quality", 85));
        intent.putExtra(CameraActivity.EXTRA_LAYOUT_MAX_WIDTH,
                call.getInt("layoutMaxWidth", 1280));
        activity.startActivity(intent);
    }

    @Override
    protected void handleOnDestroy() {
        NativeCameraSession.deliverCancel();
        super.handleOnDestroy();
    }
}
