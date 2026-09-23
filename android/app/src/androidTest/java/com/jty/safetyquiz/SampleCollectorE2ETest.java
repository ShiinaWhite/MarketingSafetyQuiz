package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.webkit.WebView;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 真实样本采集链路端到端验证（真实 LAN 链路：设备/模拟器 → PC collector）。
 *
 * 前置：PC 已运行 node tools/sample_collector/server.js（默认端口 8787）。
 * collector 地址通过 instrumentation 参数注入：
 *   - 模拟器（默认）：宿主为 http://10.0.2.2:8787，无需传参；
 *   - 实机：-Pandroid.testInstrumentationRunnerArguments.collectorUrl=http://<PC局域网IP>:8787
 * sampleId 每次运行自动生成（时间戳+随机段），可重复运行，不会撞 409。
 *
 * 验证点：
 * 1) 采集 UI 元素存在且默认关闭（默认 OFF，普通用户不上传）；
 * 2) CapacitorHttp 原生传输可用（WebView https 源到局域网 http 不走 fetch）；
 * 3) testConnection 经 debug 明文策略连通 collector；
 * 4) 经 App 自身传输层上传 fixture 样本，collector 落盘 capture.jpg + run.json，
 *    响应 SHA256 与 fixture 字节哈希一致（宿主侧再比对文件）。
 */
@RunWith(AndroidJUnit4.class)
public class SampleCollectorE2ETest {

    private static String collectorUrl() {
        String arg = InstrumentationRegistry.getArguments().getString("collectorUrl");
        return (arg != null && !arg.isEmpty()) ? arg : "http://10.0.2.2:8787";
    }

    /* 每次运行生成新 sampleId：YYYYMMDD_HHMMSS_hex6，与 collector 校验规则一致 */
    private static String makeSampleId() {
        java.text.SimpleDateFormat fmt =
                new java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US);
        return fmt.format(new java.util.Date()) + "_"
                + String.format(java.util.Locale.US, "%06x", (int) (Math.random() * 0xffffff));
    }
    /* 与 tools/sample_collector/test_collector.js 同源的 640x480 结构 fixture（148 字节） */
    private static final String FIXTURE_B64 =
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg"
            + "ICAgICAgICAgICAgICAgICAgICAj/wAARCAHgAoADASIAAhEBAxEB/8QAFAAAAAAAAAAAAAAAAAAAAAAAAP/"
            + "aAAwDAQACEQMRAD8AABL/2Q==";
    private static final String FIXTURE_SHA256 =
            "4a4caa09d1aa1263cad713b2a6657c984ad5c6473564c11409249a47695b0201";

    private BridgeActivity activity;
    private WebView web;

    private String evalJs(String js) {
        final String[] out = new String[1];
        WebView w = web;
        InstrumentationRegistry.getInstrumentation().runOnMainSync(
                () -> w.evaluateJavascript(js, value -> out[0] = value));
        return out[0];
    }

    private static String unwrap(String json) {
        if (json == null) { return null; }
        if (json.length() >= 2 && json.startsWith("\"") && json.endsWith("\"")) {
            return json.substring(1, json.length() - 1);
        }
        return json;
    }

    private String pollRaw(String expr, int timeoutMs, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String raw = null;
        while (System.currentTimeMillis() < deadline) {
            raw = evalJs(expr);
            if (raw != null && !"null".equals(raw) && !"undefined".equals(raw)) { return raw; }
            Thread.sleep(300);
        }
        throw new AssertionError("超时: " + what + " expr=" + expr + " last=" + raw);
    }

    private void pollTrue(String expr, int timeoutMs, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String raw = null;
        while (System.currentTimeMillis() < deadline) {
            raw = evalJs(expr);
            if ("true".equals(unwrap(raw))) { return; }
            Thread.sleep(300);
        }
        throw new AssertionError("超时: " + what + " expr=" + expr + " last=" + raw);
    }

    @Test
    public void collectorLinkEndToEnd() throws Exception {
        String collector = collectorUrl();
        String sampleId = makeSampleId();
        Context ctx = ApplicationProvider.getApplicationContext();
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = (BridgeActivity) InstrumentationRegistry.getInstrumentation()
                .startActivitySync(intent);

        Bridge bridge = null;
        long deadline = System.currentTimeMillis() + 60000;
        while (System.currentTimeMillis() < deadline) {
            bridge = activity.getBridge();
            if (bridge != null && bridge.getWebView() != null) { break; }
            Thread.sleep(300);
        }
        assertTrue("Bridge/WebView 未就绪", bridge != null && bridge.getWebView() != null);
        web = bridge.getWebView();

        /* 1) App 与采集模块就绪（WebView 加载完成 + sample-collector.js 已注入） */
        pollTrue("typeof MSQ !== 'undefined' && typeof MSQSample !== 'undefined' "
                + "&& !!document.getElementById('sample-panel') && !!document.body "
                + "&& document.body.innerText.length > 0", 60000, "App 页面就绪");

        String ui = evalJs("JSON.stringify({"
                + "cb: !!document.getElementById('sample-enabled'),"
                + "url: !!document.getElementById('sample-server'),"
                + "test: !!document.getElementById('btn-sample-test'),"
                + "status: !!document.getElementById('batch-sample-status'),"
                + "retry: !!document.getElementById('btn-sample-retry'),"
                + "flag: !!document.getElementById('btn-sample-flag'),"
                + "toolsHidden: document.getElementById('batch-sample-tools').classList.contains('hidden')})");
        assertTrue("采集 UI 元素不齐: " + ui,
                ui.contains("cb:true") && ui.contains("url:true") && ui.contains("test:true")
                        && ui.contains("status:true") && ui.contains("retry:true")
                        && ui.contains("flag:true") && ui.contains("toolsHidden:true"));

        /* 默认 OFF：无任何已存设置 */
        assertEquals("默认不应有采集设置", "null",
                evalJs("String(localStorage.getItem('msq.sampleCollection.v1'))"));

        /* 2) CapacitorHttp 原生传输可用（https 源发局域网 http 的前提） */
        pollTrue("!!(window.Capacitor && window.Capacitor.Plugins "
                + "&& window.Capacitor.Plugins.CapacitorHttp)", 10000, "CapacitorHttp 可用");

        /* 3) 配置采集目标并测试连接（真实 HTTP：设备 → PC collector） */
        evalJs("localStorage.setItem('msq.sampleCollection.v1', "
                + "JSON.stringify({enabled:true, serverUrl:'" + collector + "'}))");
        assertEquals("shouldCollect 应为 true", "true",
                unwrap(evalJs("String(MSQSample.shouldCollect(MSQSample.loadSettings()))")));

        evalJs("window.__tcOk=null;window.__tcMsg=null;"
                + "MSQSample.testConnection('" + collector + "',6000).then(function(r){"
                + "window.__tcOk=r.ok;window.__tcMsg=r.message;});");
        pollTrue("window.__tcOk", 15000, "测试连接完成");
        String msg = unwrap(evalJs("window.__tcMsg"));
        assertTrue("测试连接消息不符: " + msg, msg != null && msg.contains("已连接到样本接收器"));

        /* 4) 经 App 传输层上传 fixture 样本 → collector 落盘 */
        evalJs("window.__upOk=null;window.__upSha=null;window.__upBytes=null;"
                + "(function(){var p;try{p=MSQSample.buildUploadPayload({"
                + "photoDataUrl:'data:image/jpeg;base64," + FIXTURE_B64 + "',"
                + "sampleId:'" + sampleId + "',capturedAt:new Date().toISOString(),"
                + "pageType:'single',text:'fixture',lines:[],out:{blocks:[]},"
                + "timing:{ocrMs:1,splitMs:1,matchMs:1,totalMs:1},bankById:null});"
                + "}catch(e){window.__upOk=false;window.__upErr='build:'+String(e);return;}"
                + "MSQSample.postJSON(MSQSample.joinUrl('" + collector + "','/api/sample'),p,20000)"
                + ".then(function(d){window.__upOk=(d&&d.ok===true);"
                + "window.__upSha=d.sha256;window.__upBytes=d.bytes;},"
                + "function(e){window.__upOk=false;window.__upErr=String(e&&e.message||e);});})();");
        pollTrue("window.__upOk", 30000, "fixture 上传完成");
        assertEquals("响应 SHA256 与 fixture 哈希一致", "\"" + FIXTURE_SHA256 + "\"",
                evalJs("window.__upSha"));
        assertEquals("响应 bytes 与 fixture 长度一致", "148", unwrap(evalJs("window.__upBytes")));
    }

    @After
    public void tearDown() {
        if (activity != null) { activity.finish(); }
    }
}
