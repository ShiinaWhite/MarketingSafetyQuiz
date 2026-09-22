package com.jty.safetyquiz;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

/**
 * 插件 ↔ CameraActivity 的会话持有器：
 * open() 先 begin() 占住 PluginCall，CameraActivity 确认/取消后回投结果，
 * 插件在主线程 resolve。同一时刻只允许一个相机会话。
 */
final class NativeCameraSession {

    @Nullable
    private static PluginCall pending;

    private NativeCameraSession() { }

    /** 占住调用；已有进行中的会话时返回 false（调用方 reject CAMERA_BUSY）。 */
    static synchronized boolean begin(PluginCall call) {
        if (pending != null) { return false; }
        pending = call;
        return true;
    }

    /** CameraActivity 确认 ✓：带回完整结果（含 cropNormalized）。 */
    static synchronized void deliverResult(JSObject result) {
        PluginCall call = pending;
        pending = null;
        if (call != null) { call.resolve(result); }
    }

    /** CameraActivity 返回键/LIVE 期间退出：不视为错误，resolve {cancelled:true}。 */
    static synchronized void deliverCancel() {
        PluginCall call = pending;
        pending = null;
        if (call != null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
        }
    }

    @Nullable
    static synchronized PluginCall peek() {
        return pending;
    }
}
