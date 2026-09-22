package com.jty.safetyquiz;

import android.Manifest;
import android.app.Activity;
import android.graphics.drawable.Drawable;
import android.os.ParcelFileDescriptor;
import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.core.app.ActivityScenario;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.Until;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.util.Collection;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 原生相机架构（CameraActivity + open()）运行时验证（模拟器）：
 * 1) JS 插件发现与权限 alias：checkPermissions 返回 "camera" 键；
 * 2) open() 启动原生 CameraActivity（LIVE），系统返回键取消 → {cancelled:true}；
 * 3) 快门 → REVIEW（冻结照片已解码）→ ✓ → 结果含 dataUrl/全尺寸/cropNormalized；
 * 4) 重拍 / REVIEW 返回 LIVE 的状态机；连续会话不泄漏；
 * 5) WebView 全程不被透明化（预览不再依赖 WebView 透出）；
 * 6) 首装权限流：未授权时系统弹窗出现，允许后 granted（模拟器实弹）；
 *    两次拒绝后 open() 拒绝 CAMERA_PERMISSION_PERMANENTLY_DENIED。
 * 真机专属项（取景画质/触感/实际 sensor 尺寸）另行真机确认，此处只证管线与状态机。
 */
@RunWith(AndroidJUnit4.class)
public class InAppCameraInstrumentedTest {

    private static final String PKG = "com.jty.safetyquiz";
    private ActivityScenario<MainActivity> scenario;
    private UiDevice device;

    @Before
    public void setUp() throws Exception {
        grantPermission("grant");
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        scenario = ActivityScenario.launch(MainActivity.class);
        awaitWebViewReady();
    }

    @After
    public void tearDown() {
        try {
            // 若相机页还开着，退掉并释放挂起调用
            for (Activity a : resumedActivitiesOnMain()) {
                if (a instanceof CameraActivity) {
                    final Activity fa = a;
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(fa::finish);
                }
            }
        } catch (Exception ignored) { }
        if (scenario != null) { scenario.close(); }
    }

    /* ---------------- 基础设施 ---------------- */

    private void grantPermission(String action) throws Exception {
        String cmd = "pm " + action + " " + PKG + " android.permission.CAMERA";
        ParcelFileDescriptor pfd = InstrumentationRegistry.getInstrumentation().getUiAutomation()
                .executeShellCommand(cmd);
        InputStream is = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        byte[] buf = new byte[1024];
        while (is.read(buf) > 0) { /* 读完命令输出，确保完成 */ }
        is.close();
        Thread.sleep(500);
    }

    private WebView webView() throws Exception {
        final AtomicReference<WebView> ref = new AtomicReference<>();
        scenario.onActivity(a -> ref.set(((BridgeActivity) a).getBridge().getWebView()));
        WebView wv = ref.get();
        assertNotNull("Capacitor bridge WebView 不存在", wv);
        return wv;
    }

    private String evalJsRaw(String script) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>();
        final CountDownLatch latch = new CountDownLatch(1);
        final WebView wv = webView();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                wv.evaluateJavascript(script, v -> { out.set(v); latch.countDown(); }));
        assertTrue("evaluateJavascript 超时", latch.await(20, TimeUnit.SECONDS));
        return out.get();
    }

    private String evalJs(String script) throws Exception {
        String v = evalJsRaw(script);
        if (v != null && v.length() >= 2 && v.charAt(0) == '"' && v.charAt(v.length() - 1) == '"') {
            try {
                return new JSONObject("{\"v\":" + v + "}").getString("v");
            } catch (Exception e) {
                return v;
            }
        }
        return v;
    }

    private String pollJs(String expression, long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        String last = null;
        while (System.currentTimeMillis() < deadline) {
            last = evalJs("String(" + expression + ")");
            if (last != null && !last.equals("undefined") && !last.equals("null")
                    && !last.equals("false")) { return last; }
            Thread.sleep(300);
        }
        return last;
    }

    private void awaitWebViewReady() throws Exception {
        String ready = pollJs("!!(window.Capacitor && window.Capacitor.Plugins)", 90);
        assertEquals("Capacitor 桥未在 WebView 内就绪（最后结果: " + ready + "）", "true", ready);
    }

    private java.util.List<Activity> resumedActivitiesOnMain() {
        final java.util.List<Activity> out = new java.util.ArrayList<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Collection<Activity> acts = ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(Stage.RESUMED);
            out.addAll(acts);
        });
        return out;
    }

    /** 轮询等待 RESUMED 的 CameraActivity（open() 的原生页），超时返回 null。 */
    private CameraActivity awaitCameraActivity(long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        while (System.currentTimeMillis() < deadline) {
            for (Activity a : resumedActivitiesOnMain()) {
                if (a instanceof CameraActivity && !a.isFinishing()) { return (CameraActivity) a; }
            }
            Thread.sleep(300);
        }
        return null;
    }

    private int stateOf(CameraActivity activity) {
        final AtomicReference<Integer> st = new AtomicReference<>(-1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> st.set(activity.getStateForTest()));
        return st.get();
    }

    private void awaitState(CameraActivity activity, int expected, long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        while (System.currentTimeMillis() < deadline) {
            if (stateOf(activity) == expected) { return; }
            Thread.sleep(300);
        }
        assertEquals("CameraActivity 状态未到达 " + expected, expected, stateOf(activity));
    }

    /** 等待 CameraX 绑定完成（快门启用），避免抢拍点击被静默忽略。 */
    private void awaitCameraBound(CameraActivity activity, long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        while (System.currentTimeMillis() < deadline) {
            final AtomicReference<Boolean> bound = new AtomicReference<>(false);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                    bound.set(activity.isCameraBoundForTest()));
            if (bound.get()) { return; }
            Thread.sleep(300);
        }
        assertTrue("CameraX 未能绑定（快门未就绪）", activity.isCameraBoundForTest());
    }

    private void clickView(CameraActivity activity, int viewId) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                activity.findViewById(viewId).performClick());
    }

    private void startOpen() throws Exception {
        evalJs("(function(){"
                + "window.__msqOpen=null; window.__msqFull=null; window.__msqResult=null;"
                + "var C=window.Capacitor.Plugins.InAppCamera;"
                + "C.open({maxWidth:3000,quality:85,layoutMaxWidth:1280})"
                + ".then(function(r){"
                + "  window.__msqFull=r;"
                + "  var slim={}; for (var k in r){ slim[k]=r[k]; }"
                + "  if (typeof slim.dataUrl==='string'){ slim.dataUrl=slim.dataUrl.slice(0,40); }"
                + "  if (typeof slim.layoutDataUrl==='string'){ slim.layoutDataUrl=slim.layoutDataUrl.slice(0,40); }"
                + "  window.__msqResult=JSON.stringify(slim); window.__msqOpen='resolved';"
                + "},function(e){ window.__msqOpen='rejected:'+String(e&&(e.message||e)); });"
                + "})(); String(window.__msqOpen)");
    }

    /** 等待 open() 的 promise 落定，返回 'resolved' 或 'rejected:...'。 */
    private String awaitOpenSettled(long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        String last = null;
        while (System.currentTimeMillis() < deadline) {
            last = evalJs("String(window.__msqOpen)");
            if (last != null && !last.equals("null") && !last.equals("undefined")) { return last; }
            Thread.sleep(300);
        }
        return last;
    }

    /* ---------------- 用例 ---------------- */

    @Test
    public void jsPluginDiscovery_openAndPermissionApiVisible() throws Exception {
        assertEquals("true", evalJs(
                "String(!!window.Capacitor.Plugins.Ocr && typeof window.Capacitor.Plugins.Ocr.recognizeText === 'function')"));
        assertEquals("InAppCamera.open 应存在", "true", evalJs(
                "String(typeof window.Capacitor.Plugins.InAppCamera.open === 'function'"
                + " && typeof window.Capacitor.Plugins.InAppCamera.checkPermissions === 'function'"
                + " && typeof window.Capacitor.Plugins.InAppCamera.requestPermissions === 'function')"));
    }

    @Test
    public void permissionAlias_checkPermissionsReturnsCameraKey() throws Exception {
        String raw = awaitJsEvalJson("window.Capacitor.Plugins.InAppCamera.checkPermissions()");
        JSONObject perm = new JSONObject(raw);
        assertTrue("checkPermissions 必须返回 alias 键 camera，实际: " + raw, perm.has("camera"));
        assertEquals("已授权时应为 granted", "granted", perm.getString("camera"));
    }

    @Test
    public void open_launchesNativeCamera_backCancels() throws Exception {
        Drawable originalBg = webViewBackgroundOnMain();
        startOpen();
        CameraActivity cam = awaitCameraActivity(30);
        assertNotNull("open() 应启动原生 CameraActivity", cam);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);

        // 原生相机打开期间 WebView 不得被透明化（透明相机架构已废除）
        Drawable duringBg = webViewBackgroundOnMain();
        assertEquals("WebView 背景不得被改动", originalBg, duringBg);

        runOnMain(cam::onBackPressed);
        String settled = awaitOpenSettled(30);
        assertEquals("LIVE 返回键应 resolve {cancelled:true}", "resolved", settled);
        JSONObject r = new JSONObject(evalJs("window.__msqResult"));
        assertTrue("应带 cancelled 标记", r.optBoolean("cancelled"));
    }

    @Test
    public void fullFlow_shutterReviewConfirm_returnsResultWithCrop() throws Exception {
        startOpen();
        CameraActivity cam = awaitCameraActivity(30);
        assertNotNull(cam);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);
        awaitCameraBound(cam, 60);

        clickView(cam, R.id.cam_shutter);
        awaitState(cam, CameraActivity.STATE_REVIEW, 90);
        // 冻结照片已解码并显示
        final AtomicReference<Boolean> hasBitmap = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                hasBitmap.set(cam.getReviewBitmapForTest() != null
                        && !cam.getReviewBitmapForTest().isRecycled()));
        assertTrue("REVIEW 应显示解码后的照片位图", hasBitmap.get());

        clickView(cam, R.id.cam_confirm);
        String settled = awaitOpenSettled(60);
        assertEquals("✓ 后 open() 应 resolve 完整结果", "resolved", settled);
        JSONObject r = new JSONObject(evalJs("window.__msqResult"));
        assertEquals("dataUrl 应为 JPEG base64",
                "data:image/jpeg;base64,", r.getString("dataUrl").substring(0, 23));
        assertTrue("layoutDataUrl 应存在", r.getString("layoutDataUrl").length() > 10);
        assertTrue("sensorWidth 应 > 0", r.getInt("sensorWidth") > 0);
        assertTrue("outputWidth 应 ≤ 3000", r.getInt("outputWidth") <= 3000);
        assertTrue("layoutWidth 应 ≤ 1280", r.getInt("layoutWidth") <= 1280);
        assertTrue("normalizedWidth 应 > 0", r.getInt("normalizedWidth") > 0);

        JSONObject crop = r.getJSONObject("cropNormalized");
        double l = crop.getDouble("left"), t = crop.getDouble("top");
        double rt = crop.getDouble("right"), b = crop.getDouble("bottom");
        assertTrue("cropNormalized 应在 [0,1] 且 left<right、top<bottom",
                l >= 0 && t >= 0 && rt <= 1 && b <= 1 && l < rt && t < b);
    }

    @Test
    public void reviewBack_returnsToLive_retakeButtonSamePath() throws Exception {
        startOpen();
        CameraActivity cam = awaitCameraActivity(30);
        assertNotNull(cam);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);
        awaitCameraBound(cam, 60);

        clickView(cam, R.id.cam_shutter);
        awaitState(cam, CameraActivity.STATE_REVIEW, 90);

        // 重拍按钮 → LIVE
        clickView(cam, R.id.cam_retake);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);
        awaitCameraBound(cam, 60);

        // 再拍 → REVIEW → 系统返回 → LIVE → ✓ 仍可用
        clickView(cam, R.id.cam_shutter);
        awaitState(cam, CameraActivity.STATE_REVIEW, 90);
        runOnMain(cam::onBackPressed);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);
        awaitCameraBound(cam, 60);

        clickView(cam, R.id.cam_shutter);
        awaitState(cam, CameraActivity.STATE_REVIEW, 90);
        clickView(cam, R.id.cam_confirm);
        assertEquals("最终 ✓ 应 resolve", "resolved", awaitOpenSettled(60));
        JSONObject r = new JSONObject(evalJs("window.__msqResult"));
        assertTrue(r.getJSONObject("cropNormalized").length() >= 4);
    }

    @Test
    public void sessionCycle_repeatOpens_noStuckSession() throws Exception {
        // 两轮 open→confirm + 一轮 open→取消，验证会话持有器不卡死
        for (int i = 0; i < 2; i++) {
            startOpen();
            CameraActivity cam = awaitCameraActivity(30);
            assertNotNull("第 " + (i + 1) + " 轮 open 应启动相机页", cam);
            awaitState(cam, CameraActivity.STATE_LIVE, 30);
            awaitCameraBound(cam, 60);
            clickView(cam, R.id.cam_shutter);
            awaitState(cam, CameraActivity.STATE_REVIEW, 90);
            clickView(cam, R.id.cam_confirm);
            assertEquals("第 " + (i + 1) + " 轮 confirm", "resolved", awaitOpenSettled(60));
        }
        startOpen();
        CameraActivity cam = awaitCameraActivity(30);
        assertNotNull(cam);
        awaitState(cam, CameraActivity.STATE_LIVE, 30);
        runOnMain(cam::onBackPressed);
        assertEquals("取消轮", "resolved", awaitOpenSettled(60));
    }

    /* 首装系统弹窗 / 永久拒绝流程不放 instrumentation 进程内测：
       pm revoke 会以 "permissions revoked" 直接杀掉持有权限的应用进程，
       而 instrumentation 就运行在该进程里（实测 Android 11 模拟器进程崩溃、全轮中止）。
       这两条流程改由 tools/first_install_flow_check.py 从宿主侧以真实 UI 驱动验证：
       全新 revoke → 启动 App → 点“拍摄整页” → 断言系统弹窗出现 → 允许/拒绝链路。 */

    /* ---------------- 工具 ---------------- */

    private String awaitJsEvalJson(String promiseExpr) throws Exception {
        evalJs("window.__msqTmp=null; (function(){ var p=" + promiseExpr + ";"
                + "p.then(function(r){window.__msqTmp=JSON.stringify(r);},"
                + "function(e){window.__msqTmp='rejected:'+String(e&&(e.message||e));}); })();"
                + "String(window.__msqTmp)");
        String raw = pollJsNonNull("window.__msqTmp", 30);
        assertNotNull("Promise 未完成: " + promiseExpr, raw);
        return raw;
    }

    private String pollJsNonNull(String expression, long timeoutSec) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000;
        String last = null;
        while (System.currentTimeMillis() < deadline) {
            last = evalJs("String(" + expression + ")");
            if (last != null && !last.equals("null") && !last.equals("undefined") && !last.isEmpty()) {
                return last;
            }
            Thread.sleep(300);
        }
        return last;
    }

    private Drawable webViewBackgroundOnMain() throws Exception {
        final AtomicReference<Drawable> ref = new AtomicReference<>();
        final Bridge bridge = bridge();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                ref.set(bridge.getWebView().getBackground()));
        return ref.get();
    }

    private Bridge bridge() throws Exception {
        final AtomicReference<Bridge> ref = new AtomicReference<>();
        scenario.onActivity(a -> ref.set(((BridgeActivity) a).getBridge()));
        return ref.get();
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private void runOnMain(ThrowingRunnable r) throws Exception {
        Exception[] err = new Exception[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { r.run(); } catch (Exception e) { err[0] = e; }
        });
        if (err[0] != null) { throw err[0]; }
    }
}
