package com.jty.safetyquiz;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import android.util.Base64;

/**
 * PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1：真实样本"先落盘、后上传"持久化队列。
 *
 * 存储：filesDir/sample_queue/<sampleId>/{capture.jpg, run.json, feedback.json?, state.json}
 * 状态机：pending → uploading → retry_wait/failed（SampleQueueModel 纯逻辑）。
 * 关键保证：
 * - 持久化成功 = 数据 SAFE；网络上传是后台旁路，绝不阻塞拍照/展示
 * - 每个 sampleId 独立目录，新拍摄绝不覆盖旧样本
 * - App 重启恢复：uploading → pending；incomplete/临时文件安全删除
 * - 服务端幂等（同内容重传 200 alreadyExists），重传安全
 * - feedback.json 落盘后由 worker 在 sample 成功后补传，revision 保护
 * - sealed（用户拍下一页）且全部同步完成后自动清理本地大文件
 */
@CapacitorPlugin(name = "SampleQueue")
public class SampleQueuePlugin extends Plugin {

    public static final String DEFAULT_SERVER_URL = "https://update.shiinalab.top";
    private static final Pattern SAMPLE_ID = Pattern.compile("^\\d{8}_\\d{6}_[0-9a-f]{6}$");
    private static final String CAPTURE_NAME = "capture.jpg";
    private static final String RUN_NAME = "run.json";
    private static final String FEEDBACK_NAME = "feedback.json";
    private static final String STATE_NAME = "state.json";
    private static final long HTTP_TIMEOUT_MS = 60_000;
    private static final int HTTP_READ_TIMEOUT_MS = 60_000;

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService workerExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean workerRunning = new AtomicBoolean(false);
    private final Object stateLock = new Object();

    private volatile String serverUrl = DEFAULT_SERVER_URL;

    private File queueDir() {
        return new File(getContext().getFilesDir(), "sample_queue");
    }

    private File sampleDir(String sampleId) {
        return new File(queueDir(), sampleId);
    }

    private boolean validSampleId(String s) {
        return s != null && SAMPLE_ID.matcher(s).matches();
    }

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

    private static byte[] readFile(File f) throws IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) Math.min(Integer.MAX_VALUE - 8, f.length() + 1));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) { bos.write(buf, 0, n); }
            return bos.toByteArray();
        } finally {
            try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
    }

    private synchronized JSONObject readState(File dir, String sampleId) {
        try {
            return SampleQueueModel.fromJson(new String(readFile(new File(dir, STATE_NAME)), StandardCharsets.UTF_8));
        } catch (Exception e) {
            try { return SampleQueueModel.initialState(sampleId, System.currentTimeMillis(), true); }
            catch (JSONException e2) { return new JSONObject(); }
        }
    }

    private synchronized void writeState(File dir, JSONObject state) throws IOException, JSONException {
        writeFileAtomic(new File(dir, STATE_NAME), SampleQueueModel.toJson(state).getBytes(StandardCharsets.UTF_8));
    }

    /* ---------------- 对 JS 的接口 ---------------- */

    /** 设置上传服务器（App 启动时由 JS 传入统一公网地址）。 */
    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("serverUrl");
        if (url == null || !url.startsWith("https://")) {
            call.reject("serverUrl must be https", "BAD_ARGS");
            return;
        }
        serverUrl = url.replaceAll("/+$", "");
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("serverUrl", serverUrl);
        call.resolve(ret);
    }

    /** App 启动恢复：uploading → pending；incomplete/临时残留安全删除。 */
    @PluginMethod
    public void init(PluginCall call) {
        String url = call.getString("serverUrl");
        if (url != null && url.startsWith("https://")) {
            serverUrl = url.replaceAll("/+$", "");
        }
        ioExecutor.execute(new Runnable() {
            @Override
            public void run() {
                int recovered = 0;
                int removed = 0;
                File[] dirs = queueDir().listFiles();
                if (dirs != null) {
                    for (File dir : dirs) {
                        if (!dir.isDirectory()) { continue; }
                        boolean hasCapture = new File(dir, CAPTURE_NAME).exists();
                        boolean hasRun = new File(dir, RUN_NAME).exists();
                        File[] children = dir.listFiles();
                        if (children != null) {
                            for (File f : children) {
                                if (f.getName().endsWith(".tmp") && f.delete()) { /* 临时残留清理 */ }
                            }
                        }
                        if (!hasCapture || !hasRun || !new File(dir, STATE_NAME).exists()) {
                            // 半个 sample：不能上传，安全删除
                            for (File f : children != null ? children : new File[0]) { f.delete(); }
                            //noinspection ResultOfMethodCallIgnored
                            dir.delete();
                            removed++;
                            continue;
                        }
                        synchronized (stateLock) {
                            try {
                                JSONObject st = readState(dir, dir.getName());
                                String before = st.optString("status", "");
                                String after = SampleQueueModel.normalizeStatusOnBoot(before);
                                if (!before.equals(after)) {
                                    st.put("status", after);
                                    writeState(dir, st);
                                    recovered++;
                                }
                            } catch (Exception e) { /* 单个状态恢复失败不影响其它 */ }
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("recovered", recovered);
                ret.put("removed", removed);
                call.resolve(ret);
                startWorker();
            }
        });
    }

    /** 落盘一个样本（capture.jpg 从 dataUrl 原字节解码，无二次压缩）。 */
    @PluginMethod
    public void persistSample(final PluginCall call) {
        final String sampleId = call.getString("sampleId");
        final String photoDataUrl = call.getString("photoDataUrl");
        final String runJson = call.getString("runJson");
        final String feedbackJson = call.getString("feedbackJson");
        if (!validSampleId(sampleId) || photoDataUrl == null || runJson == null) {
            call.reject("sampleId/photoDataUrl/runJson 必填且 sampleId 格式合法", "BAD_ARGS");
            return;
        }
        ioExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = sampleDir(sampleId);
                    if (dir.exists()) {
                        // 同 sampleId 已落盘（极端重试）：视为已持久化
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        ret.put("alreadyPersisted", true);
                        ret.put("sampleId", sampleId);
                        call.resolve(ret);
                        startWorker();
                        return;
                    }
                    if (!dir.mkdirs()) {
                        call.reject("无法创建样本目录", "IO_ERROR");
                        return;
                    }
                    final int base64Start = photoDataUrl.indexOf(";base64,");
                    byte[] jpg;
                    try {
                        jpg = Base64.decode(
                                photoDataUrl.substring(base64Start + ";base64,".length()), Base64.NO_WRAP);
                    } catch (Exception e) {
                        call.reject("照片数据解码失败", "BAD_ARGS");
                        return;
                    }
                    writeFileAtomic(new File(dir, CAPTURE_NAME), jpg);
                    writeFileAtomic(new File(dir, RUN_NAME), runJson.getBytes(StandardCharsets.UTF_8));
                    if (feedbackJson != null) {
                        writeFileAtomic(new File(dir, FEEDBACK_NAME), feedbackJson.getBytes(StandardCharsets.UTF_8));
                    }
                    // 完整性闸门：核心文件齐全才进入队列
                    if (!new File(dir, CAPTURE_NAME).exists() || !new File(dir, RUN_NAME).exists()) {
                        for (File f : dir.listFiles() != null ? dir.listFiles() : new File[0]) { f.delete(); }
                        //noinspection ResultOfMethodCallIgnored
                        dir.delete();
                        call.reject("样本写入不完整", "IO_ERROR");
                        return;
                    }
                    synchronized (stateLock) {
                        JSONObject st = SampleQueueModel.initialState(sampleId,
                                System.currentTimeMillis(), feedbackJson == null);
                        writeState(dir, st);
                        // 旧样本 sealed：不再接收反馈；同步完成后由 worker 清理
                        File[] dirs = queueDir().listFiles();
                        if (dirs != null) {
                            for (File other : dirs) {
                                if (!other.isDirectory() || other.getName().equals(sampleId)) { continue; }
                                JSONObject ost = readState(other, other.getName());
                                if (!ost.optBoolean("sealed", false)) {
                                    ost.put("sealed", true);
                                    writeState(other, ost);
                                }
                            }
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("sampleId", sampleId);
                    ret.put("bytes", jpg.length);
                    call.resolve(ret);
                    startWorker();
                } catch (Exception e) {
                    call.reject("样本持久化失败：" + e.getMessage(), "IO_ERROR");
                }
            }
        });
    }

    /** 反馈持久化：写本地 feedback.json 并等待队列补传（sample 成功后才发送）。 */
    @PluginMethod
    public void persistFeedback(final PluginCall call) {
        final String sampleId = call.getString("sampleId");
        final String feedbackJson = call.getString("feedbackJson");
        if (!validSampleId(sampleId) || feedbackJson == null) {
            call.reject("sampleId/feedbackJson 必填", "BAD_ARGS");
            return;
        }
        ioExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = sampleDir(sampleId);
                    if (!new File(dir, RUN_NAME).exists()) {
                        call.reject("sample 不存在于本地队列", "NOT_FOUND");
                        return;
                    }
                    writeFileAtomic(new File(dir, FEEDBACK_NAME), feedbackJson.getBytes(StandardCharsets.UTF_8));
                    synchronized (stateLock) {
                        JSONObject st = readState(dir, sampleId);
                        st.put("feedbackUploaded", false);
                        st.put("feedbackRevision", st.optInt("feedbackRevision", 0) + 1);
                        if (!st.optBoolean("sampleUploaded", false)) {
                            st.put("sealed", false);   // sample 还没传成功：队列必须保留完整样本
                        }
                        writeState(dir, st);
                    }
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("sampleId", sampleId);
                    call.resolve(ret);
                    startWorker();
                } catch (Exception e) {
                    call.reject("反馈持久化失败：" + e.getMessage(), "IO_ERROR");
                }
            }
        });
    }

    @PluginMethod
    public void stats(PluginCall call) {
        JSObject ret = queueStats();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void retryFailed(PluginCall call) {
        int count = 0;
        File[] dirs = queueDir().listFiles();
        if (dirs != null) {
            for (File dir : dirs) {
                if (!dir.isDirectory()) { continue; }
                synchronized (stateLock) {
                    try {
                        JSONObject st = readState(dir, dir.getName());
                        if (SampleQueueModel.STATUS_FAILED.equals(st.optString("status", ""))) {
                            st.put("status", SampleQueueModel.STATUS_PENDING);
                            writeState(dir, st);
                            count++;
                        }
                    } catch (Exception e) { /* 下次再试 */ }
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("retried", count);
        call.resolve(ret);
        startWorker();
    }

    private JSObject queueStats() {
        int pending = 0, uploading = 0, retryWait = 0, failed = 0, uploaded = 0;
        long pendingBytes = 0;
        File[] dirs = queueDir().listFiles();
        if (dirs != null) {
            for (File dir : dirs) {
                if (!dir.isDirectory()) { continue; }
                JSONObject st = readState(dir, dir.getName());
                String status = st.optString("status", SampleQueueModel.STATUS_PENDING);
                boolean sampleDone = st.optBoolean("sampleUploaded", false);
                boolean feedbackDone = st.optBoolean("feedbackUploaded", true)
                        || !new File(dir, FEEDBACK_NAME).exists();
                if (sampleDone && feedbackDone) {
                    uploaded++;
                    continue;
                }
                if (SampleQueueModel.STATUS_UPLOADING.equals(status)) { uploading++; }
                else if (SampleQueueModel.STATUS_RETRY_WAIT.equals(status)) { retryWait++; }
                else if (SampleQueueModel.STATUS_FAILED.equals(status)) { failed++; }
                else { pending++; }
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) { pendingBytes += f.length(); }
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("pending", pending);
        ret.put("uploading", uploading);
        ret.put("retryWait", retryWait);
        ret.put("failed", failed);
        ret.put("uploaded", uploaded);
        ret.put("pendingBytes", pendingBytes);
        return ret;
    }

    /* ---------------- 后台 worker（并发 = 1，FIFO） ---------------- */

    private void startWorker() {
        if (workerRunning.compareAndSet(false, true)) {
            workerExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        runQueueLoop();
                    } finally {
                        workerRunning.set(false);
                    }
                    notifyChanged();
                }
            });
        }
    }

    private void runQueueLoop() {
        while (true) {
            File next = pickNextDue();
            if (next == null) { return; }
            try {
                processSample(next);
            } catch (Exception e) {
                synchronized (stateLock) {
                    JSONObject st = readState(next, next.getName());
                    try {
                        SampleQueueModel.markError(st, String.valueOf(e.getMessage()),
                                System.currentTimeMillis());
                        writeState(next, st);
                    } catch (Exception e2) { /* 状态写入失败：下次启动恢复兜底 */ }
                }
            }
        }
    }

    /** 最老的一条待处理样本（FIFO）；上传完成但未 sealed 的跳过。 */
    private File pickNextDue() {
        File[] dirs = queueDir().listFiles();
        if (dirs == null) { return null; }
        List<File> due = new ArrayList<File>();
        for (File dir : dirs) {
            if (!dir.isDirectory()) { continue; }
            JSONObject st = readState(dir, dir.getName());
            boolean sampleDone = st.optBoolean("sampleUploaded", false);
            boolean feedbackPending = new File(dir, FEEDBACK_NAME).exists()
                    && !st.optBoolean("feedbackUploaded", true);
            if (sampleDone && !feedbackPending) { continue; }   // 已同步完成
            if (SampleQueueModel.isRetryDue(st, System.currentTimeMillis())) {
                due.add(dir);
            }
        }
        due.sort(new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                long ca = readState(a, a.getName()).optLong("createdAt", 0);
                long cb = readState(b, b.getName()).optLong("createdAt", 0);
                return Long.compare(ca, cb);
            }
        });
        return due.isEmpty() ? null : due.get(0);
    }

    private void processSample(final File dir) throws Exception {
        final String sampleId = dir.getName();
        JSONObject st = readState(dir, sampleId);
        st.put("status", SampleQueueModel.STATUS_UPLOADING);
        st.put("lastError", JSONObject.NULL);
        writeState(dir, st);
        notifyChanged();

        boolean needFeedback = new File(dir, FEEDBACK_NAME).exists()
                && !st.optBoolean("feedbackUploaded", true);

        if (!st.optBoolean("sampleUploaded", false)) {
            byte[] jpg = readFile(new File(dir, CAPTURE_NAME));
            String manifestJson = new String(readFile(new File(dir, RUN_NAME)), StandardCharsets.UTF_8);
            int status = httpPostJson(serverUrl + "/api/sample",
                    SampleUploadBody.build(sampleId, jpg, manifestJson));
            if (status < 200 || status >= 300) {
                recordFailure(dir, "HTTP " + status, status >= 500 || status == 408);
                return;   // 失败不堵队列：回到循环继续下一条件/退出
            }
            synchronized (stateLock) {
                st = readState(dir, sampleId);
                st.put("sampleUploaded", true);
                writeState(dir, st);
            }
        }

        if (needFeedback && !readState(dir, sampleId).optBoolean("feedbackUploaded", true)) {
            File fbFile = new File(dir, FEEDBACK_NAME);
            String revision = readRevision(fbFile);
            byte[] body = readFile(fbFile);
            int status = httpPostJson(serverUrl + "/api/feedback", body);
            if (status >= 200 && status < 300) {
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    // revision 保护：仅当本地反馈未再变化才标记已同步
                    if (readRevision(fbFile).equals(revision)) {
                        cur.put("feedbackUploaded", true);
                    }
                    writeState(dir, cur);
                }
            } else {
                recordFailure(dir, "feedback HTTP " + status, status >= 500 || status == 408);
                return;
            }
        }

        // sealed 且全部同步 → 清理本地大文件
        synchronized (stateLock) {
            JSONObject cur = readState(dir, sampleId);
            if (SampleQueueModel.canCleanup(cur, cur.optBoolean("sealed", false))) {
                File[] files = dir.listFiles();
                if (files != null) { for (File f : files) { f.delete(); } }
                //noinspection ResultOfMethodCallIgnored
                dir.delete();
            }
        }
    }

    private String readRevision(File feedbackFile) {
        try {
            return new JSONObject(new String(readFile(feedbackFile), StandardCharsets.UTF_8))
                    .optString("updatedAt", "");
        } catch (Exception e) {
            return String.valueOf(feedbackFile.lastModified());
        }
    }

    private void recordFailure(File dir, String error, boolean retryable) throws Exception {
        synchronized (stateLock) {
            JSONObject st = readState(dir, dir.getName());
            if (!retryable) {
                // 明确非法（4xx 冲突/校验）：不无限重试，标 failed 等手动处理
                st.put("status", SampleQueueModel.STATUS_FAILED);
                st.put("retryCount", st.optInt("retryCount", 0) + 1);
                st.put("lastError", error);
                st.put("nextRetryAt", JSONObject.NULL);
            } else {
                SampleQueueModel.markError(st, error, System.currentTimeMillis());
            }
            writeState(dir, st);
        }
        notifyChanged();
    }

    private int httpPostJson(String url, byte[] body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(HTTP_READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(body.length);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        OutputStream out = conn.getOutputStream();
        try {
            out.write(body);
        } finally {
            try { out.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
        int status = conn.getResponseCode();
        try { conn.getInputStream().close(); } catch (Exception e) { /* 无 body */ }
        conn.disconnect();
        return status;
    }

    private void notifyChanged() {
        JSObject stats = queueStats();
        stats.put("ok", true);
        notifyListeners("sampleQueueChanged", stats);
    }
}
