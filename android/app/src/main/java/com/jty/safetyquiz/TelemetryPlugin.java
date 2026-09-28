package com.jty.safetyquiz;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.provider.Settings;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * DATA_PLATFORM_V1（USAGE_TELEMETRY_V1）：telemetry 客户端仅有的两个原生能力。
 *
 * - getAndroidId：读 Settings.Secure.ANDROID_ID（64bit → 16 hex）。统计口径 = 活跃设备；
 *   不申请 IMEI/MEID/序列号/MAC/Advertising ID/定位任何权限。已知坏值
 *   "9774d56d682e549c"（Android 2.3 及以前的全局 bug 值，跨设备相同）视为不可用。
 *   原始 ANDROID_ID 只经内存传给 JS（用于 /api/telemetry/register 注册后即弃），
 *   绝不写日志、绝不落盘。
 * - loadState / saveState：telemetry 客户端聚合态（msq.telemetry.v1）在
 *   filesDir/telemetry/state.json 的原子读写（与 SampleQueue 同级可靠性）；
 *   state 只含计数器/直方图/桶边界/outbox，绝不含任何内容文本或 ANDROID_ID。
 *
 * 网络上传不经过本插件：JS 侧复用 CapacitorHttp（HTTPS），secret 永不进 APK。
 */
@CapacitorPlugin(name = "Telemetry")
public class TelemetryPlugin extends Plugin {

    /** Android 2.3 及以前的已知全局坏值：所有设备相同，用它会把所有用户算成一台设备 */
    private static final String KNOWN_BUGGY_ANDROID_ID = "9774d56d682e549c";
    private static final long MAX_STATE_BYTES = 512 * 1024;

    private File stateFile() {
        File dir = new File(getContext().getFilesDir(), "telemetry");
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return new File(dir, "state.json");
    }

    /** 原子写：先写 .tmp 再 rename，避免半文件（进程被杀也不产生损坏状态）。 */
    private static void writeFileAtomic(File target, byte[] data) throws IOException {
        final File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(data);
        } finally {
            try { out.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("rename failed: " + target.getName());
        }
    }

    @PluginMethod
    public void getAndroidId(PluginCall call) {
        String androidId = null;
        try {
            androidId = Settings.Secure.getString(
                getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception e) {
            androidId = null;
        }
        boolean usable = androidId != null
            && androidId.length() == 16
            && !KNOWN_BUGGY_ANDROID_ID.equals(androidId.toLowerCase());
        JSObject ret = new JSObject();
        /* 只在内存交给 JS；绝不打日志 */
        ret.put("androidId", usable ? androidId.toLowerCase() : null);
        call.resolve(ret);
    }

    @PluginMethod
    public void loadState(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            File f = stateFile();
            if (f.exists() && f.length() > 0 && f.length() <= MAX_STATE_BYTES) {
                java.io.FileInputStream in = new java.io.FileInputStream(f);
                try {
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) { bos.write(buf, 0, n); }
                    ret.put("stateJson", new String(bos.toByteArray(), StandardCharsets.UTF_8));
                } finally {
                    try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
                }
            } else {
                ret.put("stateJson", null);
            }
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("stateJson", null);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void saveState(PluginCall call) {
        String stateJson = call.getString("stateJson");
        JSObject ret = new JSObject();
        if (stateJson == null || stateJson.isEmpty() || stateJson.length() > MAX_STATE_BYTES) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        try {
            writeFileAtomic(stateFile(), stateJson.getBytes(StandardCharsets.UTF_8));
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("ok", false);
            call.resolve(ret);
        }
    }
}
