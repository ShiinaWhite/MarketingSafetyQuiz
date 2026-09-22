package com.jty.safetyquiz;

import android.Manifest;
import android.os.ParcelFileDescriptor;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 真实运行时验证（模拟器）：
 * 1) JS 插件发现：window.Capacitor.Plugins.InAppCamera / Ocr 可见且方法齐全
 *    （验证 Capacitor Bridge registerPlugin 生效，而不是只看 DEX 里有类）；
 * 2) CameraX start()/stop() 在模拟器虚拟相机上可绑定、可解绑；
 * 3) capture() 返回真实运行尺寸（sensor/normalized/output/layout）；
 * 4) 连续 10 轮 start→capture 生命周期压力。
 * 真实手机相机质量另测，此处只证明管线可用。
 */
@RunWith(AndroidJUnit4.class)
public class InAppCameraInstrumentedTest {

    private static final String PKG = "com.jty.safetyquiz";
    private ActivityScenario<MainActivity> scenario;

    @Before
    public void setUp() throws Exception {
        grantCameraPermission();
        scenario = ActivityScenario.launch(MainActivity.class);
        awaitWebViewReady();
    }

    @After
    public void tearDown() {
        try {
            evalJs("try{window.Capacitor.Plugins.InAppCamera.stop();}catch(e){}");
        } catch (Exception ignored) { }
        if (scenario != null) { scenario.close(); }
    }

    private void grantCameraPermission() throws Exception {
        ParcelFileDescriptor pfd = InstrumentationRegistry.getInstrumentation().getUiAutomation()
                .executeShellCommand("pm grant " + PKG + " android.permission.CAMERA");
        InputStream is = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        byte[] buf = new byte[1024];
        while (is.read(buf) > 0) { /* 读完命令输出，确保 grant 完成 */ }
        is.close();
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

    /** evaluateJavascript 的返回值是 JSON 编码的，字符串结果需解包为原始内容 */
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

    /** 轮询直到表达式结果出现且不为 undefined/null/false（页面未就绪、Promise 未完成都靠它等待） */
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

    /** 在 WebView 内等待一个 JS Promise，结果写入 window.__msqLast */
    private String awaitJsPromise(String promiseExpr, long timeoutSec) throws Exception {
        evalJs("window.__msqLast=null; (function(){ var p=" + promiseExpr + ";"
                + "p.then(function(r){window.__msqLast=JSON.stringify({ok:true,r:r});},"
                + "function(e){window.__msqLast=JSON.stringify({ok:false,err:String(e&&(e.message||e))});}); })();"
                + "String(window.__msqLast)");
        String raw = pollJs("window.__msqLast", timeoutSec);
        assertNotNull("Promise 未在 " + timeoutSec + "s 内完成: " + promiseExpr, raw);
        return raw;
    }

    @Test
    public void jsPluginDiscovery_ocrAndInAppCameraVisible() throws Exception {
        assertEquals("true", evalJs(
                "String(!!window.Capacitor.Plugins.Ocr && typeof window.Capacitor.Plugins.Ocr.recognizeText === 'function')"));
        assertEquals("InAppCamera 插件未被 Bridge 发现", "true", evalJs(
                "String(!!window.Capacitor.Plugins.InAppCamera)"));
        assertEquals("true", evalJs(
                "String(typeof window.Capacitor.Plugins.InAppCamera.start === 'function'"
                + " && typeof window.Capacitor.Plugins.InAppCamera.capture === 'function'"
                + " && typeof window.Capacitor.Plugins.InAppCamera.stop === 'function')"));
    }

    @Test
    public void cameraStart_bindsOnEmulatorVirtualCamera() throws Exception {
        String raw = awaitJsPromise("window.Capacitor.Plugins.InAppCamera.start()", 60);
        JSONObject r = new JSONObject(raw);
        assertTrue("start() 应 resolve，实际: " + raw, r.getBoolean("ok"));
    }

    @Test
    public void cameraStop_resolves() throws Exception {
        String raw = awaitJsPromise("window.Capacitor.Plugins.InAppCamera.stop()", 30);
        JSONObject r = new JSONObject(raw);
        assertTrue("stop() 应 resolve，实际: " + raw, r.getBoolean("ok"));
    }

    @Test
    public void cameraCapture_returnsActualRuntimeSizes() throws Exception {
        String startRaw = awaitJsPromise("window.Capacitor.Plugins.InAppCamera.start()", 60);
        assertTrue("start() 失败: " + startRaw,
                new JSONObject(startRaw).getBoolean("ok"));

        String raw = awaitJsPromise(
                "window.Capacitor.Plugins.InAppCamera.capture("
                        + "{maxWidth:3000, quality:85, layoutMaxWidth:1280})", 120);
        JSONObject r = new JSONObject(raw);
        assertTrue("capture() 应 resolve，实际: " + raw, r.getBoolean("ok"));
        JSONObject cap = r.getJSONObject("r");
        int sensorW = cap.getInt("sensorWidth");
        int sensorH = cap.getInt("sensorHeight");
        int normW = cap.getInt("normalizedWidth");
        int outW = cap.getInt("outputWidth");
        int outH = cap.getInt("outputHeight");
        int layW = cap.getInt("layoutWidth");

        assertTrue("sensorWidth 应 > 0（实际值: " + sensorW + "x" + sensorH + "）", sensorW > 0);
        assertTrue("normalizedWidth 应 > 0", normW > 0);
        assertTrue("outputWidth 不得超过 maxWidth=3000（实际 " + outW + "）", outW <= 3000);
        assertTrue("outputWidth 应 > 0", outW > 0);
        assertTrue("outputHeight 应 > 0", outH > 0);
        assertTrue("layoutWidth 不得超过 layoutMaxWidth=1280（实际 " + layW + "）", layW <= 1280);
        assertTrue("dataUrl 应为 JPEG base64",
                cap.getString("dataUrl").startsWith("data:image/jpeg;base64,"));
        assertTrue("layoutDataUrl 应存在", cap.getString("layoutDataUrl").length() > 100);

        org.junit.Assert.assertNotEquals("layoutWidth 必须是实际运行值而非缺省 0", 0, layW);
        android.util.Log.i("MsqCapture", "RUNTIME_SIZES"
                + " sensor=" + sensorW + "x" + sensorH
                + " normalized=" + normW + "x" + cap.getInt("normalizedHeight")
                + " output=" + outW + "x" + outH
                + " layout=" + layW + "x" + cap.getInt("layoutHeight"));
    }

    @Test
    public void captureStress10x_startCaptureCycle_noError() throws Exception {
        evalJs("(function(){"
                + "var P=window.Capacitor.Plugins.InAppCamera;"
                + "var st={done:0,errs:[],finished:false}; window.__msqStress=JSON.stringify(st);"
                + "var i=0;"
                + "function one(){"
                + " if(i>=10){st.finished=true;window.__msqStress=JSON.stringify(st);return;}"
                + " i++;"
                + " P.start().then(function(){return P.capture({maxWidth:3000,quality:85,layoutMaxWidth:1280});})"
                + " .then(function(){st.done++;window.__msqStress=JSON.stringify(st);one();},"
                + "       function(e){st.errs.push(String(e&&(e.message||e)));"
                + "                    window.__msqStress=JSON.stringify(st);one();});"
                + "} one(); })(); String(window.__msqStress)");
        long deadline = System.currentTimeMillis() + 300_000;
        JSONObject st = null;
        while (System.currentTimeMillis() < deadline) {
            String raw = evalJs("String(window.__msqStress)");
            if (raw != null && raw.startsWith("{")) {
                st = new JSONObject(raw);
                if (st.optBoolean("finished")) { break; }
            }
            Thread.sleep(1000);
        }
        assertNotNull("10 轮 start→capture 未在 300s 内完成", st);
        assertTrue("压力轮未正常结束", st.optBoolean("finished"));
        assertEquals("10 轮 start→capture 应全部成功，错误: " + st.optJSONArray("errs"),
                10, st.optInt("done"));
    }
}
