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
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
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
 *
 * R2_FAST_TRANSFER_V1（大文件数据面迁移）：
 *   capture.jpg 不再走 Tunnel。上传改为三步小请求 + 一次直传：
 *     1) POST /api/sample/init    （走 Tunnel，带 device credential，body 只有标量）
 *        → 服务器派生 objectKey + 返回短时 presigned PUT URL + requiredHeaders
 *     2) PUT <presignedPutUrl>    （手机 → R2，**原生文件流**，不经 Tunnel/Collector）
 *     3) POST /api/sample/commit  （走 Tunnel，body 只有 run.json 与校验字段）
 *   绝不把 JPEG 转 base64、绝不整图进内存、绝不把 JPEG 塞 JSON。
 *   presigned URL 是临时 bearer credential：只在内存中存在，不落盘、不打日志。
 */
@CapacitorPlugin(name = "SampleQueue")
public class SampleQueuePlugin extends Plugin {

    public static final String DEFAULT_SERVER_URL = "https://update.shiinalab.top";
    private static final Pattern SAMPLE_ID = Pattern.compile("^\\d{8}_\\d{6}_[0-9a-f]{6}$");
    private static final String CAPTURE_NAME = "capture.jpg";
    private static final String RUN_NAME = "run.json";
    private static final String FEEDBACK_NAME = "feedback.json";
    private static final String STATE_NAME = "state.json";
    /** janitor 诊断记录（非敏感：时间戳与字节数，SIMPLIFY_CAPTURE_FLOW_V1） */
    private static final String JANITOR_NAME = "janitor.json";
    private static final String CAPTURE_CONTENT_TYPE = "image/jpeg";
    private static final long HTTP_TIMEOUT_MS = 60_000;
    private static final int HTTP_READ_TIMEOUT_MS = 60_000;
    /** 控制面响应体上限（init/commit 只回小 JSON）；防止异常响应把内存吃满 */
    private static final int MAX_CONTROL_RESPONSE_BYTES = 256 * 1024;

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
                                /* QUEUE_RECOVERY_AND_CLEANUP_V1：旧 generation 的
                                   auth_failed 随新版本 App 自动恢复一次（无需用户操作）；
                                   同 generation 保持 auth_failed 防循环 401 */
                                if (SampleQueueModel.shouldAutoRecoverAuthFailed(st, authGeneration())) {
                                    SampleQueueModel.recoverToPending(st);
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
                /* SIMPLIFY_CAPTURE_FLOW_V1：冷启动是 janitor 的合法时机之一；
                   24h 节流在 runJanitor 内部判定。单线程 workerExecutor 保证与
                   上传 worker 串行（active/uploading/committing 样本天然受保护）。 */
                workerExecutor.execute(new Runnable() {
                    @Override
                    public void run() { runJanitor(false); }
                });
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

    /** 反馈持久化：写本地 feedback.json 并等待队列补传（sample 成功后才发送）。
     *  FEEDBACK_PERSISTENCE_REPAIR_V1：先标记 state 待传、再写文档——崩溃窗口
     *  只会留下「待传 + 旧/无文档」，绝不会留下「已同步 + 新文档」的静默丢失。
     *  诊断字段（非敏感）：feedbackRevision / feedbackPersistedAt / feedbackSyncState。 */
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
                    synchronized (stateLock) {
                        JSONObject st = readState(dir, sampleId);
                        st.put("feedbackUploaded", false);
                        st.put("feedbackRevision", st.optInt("feedbackRevision", 0) + 1);
                        st.put("feedbackPersistedAt", System.currentTimeMillis());
                        st.put("feedbackSyncState", "pending");
                        st.put("feedbackNextRetryAt", JSONObject.NULL);  // 用户主动修改 → 立即可传
                        if (!st.optBoolean("sampleUploaded", false)) {
                            st.put("sealed", false);   // sample 还没传成功：队列必须保留完整样本
                        }
                        writeState(dir, st);
                    }
                    writeFileAtomic(new File(dir, FEEDBACK_NAME), feedbackJson.getBytes(StandardCharsets.UTF_8));
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

    /** 清理失败样本（QUEUE_RECOVERY_AND_CLEANUP_V1）：仅删除 failed / auth_failed
     *  目录；pending / uploading / retry_wait 与已同步数据绝不触碰。
     *  逐目录独立 try：单个删除失败如实计入 failedToDelete，不虚报成功。 */
    @PluginMethod
    public void cleanupFailed(final PluginCall call) {
        workerExecutor.execute(new Runnable() {
            @Override
            public void run() {
                int deleted = 0;
                int failedToDelete = 0;
                long bytesFreed = 0;
                File[] dirs = queueDir().listFiles();
                if (dirs != null) {
                    for (File dir : dirs) {
                        if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
                        JSONObject st = readState(dir, dir.getName());
                        String cleanupStatus = st.optString("status", "");
                        boolean cleanupEligible =
                            SampleQueueModel.STATUS_FAILED.equals(cleanupStatus)
                            || SampleQueueModel.STATUS_AUTH_FAILED.equals(cleanupStatus);
                        if (!cleanupEligible) {
                            continue;   // pending/uploading/retry_wait/已完成 绝不清理
                        }
                        long bytes = 0;
                        File[] files = dir.listFiles();
                        boolean allDeleted = true;
                        if (files != null) {
                            for (File f : files) {
                                bytes += f.length();
                                if (!f.delete()) { allDeleted = false; }
                            }
                        }
                        if (allDeleted && dir.delete()) {
                            deleted++;
                            bytesFreed += bytes;
                        } else {
                            failedToDelete++;
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("ok", failedToDelete == 0);
                ret.put("deleted", deleted);
                ret.put("failedToDelete", failedToDelete);
                ret.put("bytesFreed", bytesFreed);
                call.resolve(ret);
                notifyChanged();
            }
        });
    }

    /* ---------------- 自动 Janitor（SIMPLIFY_CAPTURE_FLOW_V1） ----------------
       用户不再有「清理失败样本」按钮，队列完全自维护：
         synced → 及时删除；failed/auth_failed → 7 天；pending/retry_wait → 14 天；
         256 MiB 硬限内先删最老 failed/auth_failed，再删长期滞留 pending/retry_wait。
       完整扫描 24h 最多一次（runJanitorNow 可强制）。删除判定在 SampleQueueModel
       纯函数（JVM 单测 CAP-S12~16），本类只负责 IO 与调度。
       调用约定：必须在 workerExecutor 线程执行 —— 与 processSample 串行，
       active/uploading/committing 样本天然不会被并发删除。 */

    private File janitorFile() {
        return new File(queueDir(), JANITOR_NAME);
    }

    private synchronized JSONObject readJanitorRecord() {
        try {
            return SampleQueueModel.fromJson(
                    new String(readFile(janitorFile()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static long dirSize(File dir) {
        long total = 0;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) { total += f.length(); }
        }
        return total;
    }

    private long sampleAgeMs(File dir, JSONObject st, long now) {
        long createdAt = st.optLong("createdAt", 0L);
        if (createdAt <= 0L) { createdAt = dir.lastModified(); }
        long age = now - createdAt;
        return age > 0L ? age : 0L;
    }

    /** 删除整个 sample 目录：先原子改名隔离（.del），再递归删除；
     *  改名失败 = 目录正被并发占用，本轮跳过；残留 .del 由下次 init/janitor 兜底。 */
    private boolean deleteSampleDirWhole(File dir) {
        File tomb = new File(dir.getParentFile(), dir.getName() + ".del");
        if (tomb.exists() && !deleteRecursively(tomb)) { return false; }
        if (!dir.renameTo(tomb)) { return false; }
        return deleteRecursively(tomb);
    }

    private static boolean deleteRecursively(File f) {
        if (f == null || !f.exists()) { return true; }
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            boolean ok = true;
            if (children != null) {
                for (File c : children) { ok = deleteRecursively(c) && ok; }
            }
            return ok && f.delete();
        }
        return f.delete();
    }

    /** 完整 janitor 扫描。force=true 绕过 24h 节流（仅 DEV 诊断入口使用）。 */
    private void runJanitor(boolean force) {
        try {
            long now = System.currentTimeMillis();
            JSONObject rec = readJanitorRecord();
            if (!force && !SampleQueueModel.janitorDue(rec.optLong("lastJanitorAt", 0L), now)) {
                return;
            }
            File[] dirs = queueDir().listFiles();
            long bytesBefore = 0;
            List<File> toDelete = new ArrayList<File>();
            long bytesToDelete = 0;
            if (dirs != null) {
                for (File dir : dirs) {
                    if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
                    bytesBefore += dirSize(dir);
                    JSONObject st = readState(dir, dir.getName());
                    String reason = SampleQueueModel.janitorDeleteReason(
                            st.optString("status", SampleQueueModel.STATUS_PENDING),
                            st.optBoolean("sampleUploaded", false),
                            st.optBoolean("feedbackUploaded", true),
                            st.optBoolean("sealed", false),
                            sampleAgeMs(dir, st, now));
                    if (reason != null) {
                        toDelete.add(dir);
                        bytesToDelete += dirSize(dir);
                    }
                }
            }
            long bytesAfterRetention = bytesBefore - bytesToDelete;
            /* 硬限：retention 后仍超 256 MiB → 最老 failed/auth_failed 优先，
               再删长期滞留（≥24h）pending/retry_wait（CAP-S14/15） */
            if (bytesAfterRetention > SampleQueueModel.QUEUE_HARD_LIMIT_BYTES && dirs != null) {
                List<File> rest = new ArrayList<File>();
                for (File dir : dirs) {
                    if (dir.isDirectory() && validSampleId(dir.getName()) && !toDelete.contains(dir)) {
                        rest.add(dir);
                    }
                }
                rest.sort(new Comparator<File>() {
                    @Override
                    public int compare(File a, File b) {
                        return Long.compare(sampleCreatedAt(a), sampleCreatedAt(b));
                    }
                });
                JSONArray candidates = new JSONArray();
                for (File d : rest) {
                    JSONObject st = readState(d, d.getName());
                    JSONObject c = new JSONObject();
                    c.put("sampleId", d.getName());
                    c.put("rank", SampleQueueModel.janitorHardLimitRank(
                            st.optString("status", SampleQueueModel.STATUS_PENDING),
                            sampleAgeMs(d, st, now)));
                    c.put("bytes", dirSize(d));
                    candidates.put(c);
                }
                java.util.Set<String> plan = SampleQueueModel.janitorHardLimitPlan(candidates,
                        bytesAfterRetention, SampleQueueModel.QUEUE_HARD_LIMIT_BYTES);
                for (File d : rest) {
                    if (plan.contains(d.getName())) {
                        toDelete.add(d);
                        bytesToDelete += dirSize(d);
                    }
                }
            }
            int deleted = 0;
            long freed = 0;
            for (File d : toDelete) {
                long sz = dirSize(d);
                if (deleteSampleDirWhole(d)) {
                    deleted++;
                    freed += sz;
                }
            }
            /* 诊断记录（非敏感）：只有时间戳与字节数，绝不进入普通 UI */
            JSONObject next = new JSONObject();
            next.put("lastJanitorAt", now);
            next.put("deletedSamples", deleted);
            next.put("deletedBytes", freed);
            next.put("queueBytesBefore", bytesBefore);
            File[] after = queueDir().listFiles();
            next.put("queueBytesAfter", after == null ? 0L : totalQueueBytes(after));
            writeFileAtomic(janitorFile(), next.toString().getBytes(StandardCharsets.UTF_8));
            if (deleted > 0) { notifyChanged(); }
        } catch (Exception e) {
            /* janitor 失败完全静默（best-effort），只留非敏感 logcat 诊断 */
            android.util.Log.i("MSQSampleQueue", "janitor skipped: " + e.getClass().getSimpleName());
        }
    }

    private static long sampleCreatedAt(File dir) {
        try {
            JSONObject st = SampleQueueModel.fromJson(
                    new String(readFile(new File(dir, STATE_NAME)), StandardCharsets.UTF_8));
            long createdAt = st.optLong("createdAt", 0L);
            if (createdAt > 0L) { return createdAt; }
        } catch (Exception e) { /* 状态缺失：退回目录时间 */ }
        return dir.lastModified();
    }

    private static long totalQueueBytes(File[] dirs) {
        long total = 0;
        if (dirs != null) {
            for (File dir : dirs) {
                if (!dir.isDirectory() || dir.getName().endsWith(".del")) { continue; }
                total += dirSize(dir);
            }
        }
        return total;
    }

    /** DEV 隐藏诊断（SIMPLIFY_CAPTURE_FLOW_V1）：全部为非敏感聚合数字；
     *  绝不含 token / SecretKey / presigned URL / Authorization / 服务器域名。 */
    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        ioExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    long now = System.currentTimeMillis();
                    File[] dirs = queueDir().listFiles();
                    long oldestAgeMs = -1;
                    long lastUploadBytesPerSec = 0;
                    long lastUploadAt = -1;
                    int feedbackPending = 0;
                    if (dirs != null) {
                        for (File dir : dirs) {
                            if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
                            JSONObject st = readState(dir, dir.getName());
                            long age = sampleAgeMs(dir, st, now);
                            if (age > oldestAgeMs) { oldestAgeMs = age; }
                            long speed = st.optLong("captureBytesPerSec", 0L);
                            long at = st.optLong("createdAt", 0L);
                            if (speed > 0 && at >= lastUploadAt) {
                                lastUploadAt = at;
                                lastUploadBytesPerSec = speed;
                            }
                            if (new File(dir, FEEDBACK_NAME).exists()
                                    && !st.optBoolean("feedbackUploaded", true)) {
                                feedbackPending++;
                            }
                        }
                    }
                    JSONObject rec = readJanitorRecord();
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("oldestSampleAgeMs", oldestAgeMs);
                    ret.put("lastUploadBytesPerSec", lastUploadBytesPerSec);
                    ret.put("feedbackPendingCount", feedbackPending);
                    ret.put("lastJanitorAt", rec.optLong("lastJanitorAt", 0L));
                    ret.put("deletedSamples", rec.optInt("deletedSamples", 0));
                    ret.put("deletedBytes", rec.optLong("deletedBytes", 0L));
                    ret.put("queueBytesBefore", rec.optLong("queueBytesBefore", 0L));
                    ret.put("queueBytesAfter", rec.optLong("queueBytesAfter", 0L));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("诊断读取失败", "IO_ERROR");
                }
            }
        });
    }

    /** DEV 诊断入口「Run janitor now」：绕过 24h 节流立即扫描一次。 */
    @PluginMethod
    public void runJanitorNow(final PluginCall call) {
        workerExecutor.execute(new Runnable() {
            @Override
            public void run() {
                runJanitor(true);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void retryFailed(PluginCall call) {
        int count = 0;
        File[] dirs = queueDir().listFiles();
        if (dirs != null) {
            for (File dir : dirs) {
                if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
                synchronized (stateLock) {
                    try {
                        JSONObject st = readState(dir, dir.getName());
                        String status = st.optString("status", "");
                        if (SampleQueueModel.STATUS_FAILED.equals(status)
                                || SampleQueueModel.STATUS_AUTH_FAILED.equals(status)) {
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
        int pending = 0, uploading = 0, retryWait = 0, failed = 0, authFailed = 0, uploaded = 0;
        long pendingBytes = 0;
        File[] dirs = queueDir().listFiles();
        if (dirs != null) {
            for (File dir : dirs) {
                if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
                JSONObject st = readState(dir, dir.getName());
                String status = st.optString("status", SampleQueueModel.STATUS_PENDING);
                boolean sampleDone = st.optBoolean("sampleUploaded", false);
                boolean feedbackDone = st.optBoolean("feedbackUploaded", true)
                        || !new File(dir, FEEDBACK_NAME).exists();
                if (sampleDone && feedbackDone) {
                    uploaded++;
                    continue;
                }
                if (SampleQueueModel.STATUS_UPLOADING.equals(status)
                        || SampleQueueModel.STATUS_UPLOADING_CAPTURE.equals(status)
                        || SampleQueueModel.STATUS_CAPTURE_UPLOADED.equals(status)) { uploading++; }
                else if (SampleQueueModel.STATUS_RETRY_WAIT.equals(status)) { retryWait++; }
                else if (SampleQueueModel.STATUS_FAILED.equals(status)) { failed++; }
                else if (SampleQueueModel.STATUS_AUTH_FAILED.equals(status)) { authFailed++; }
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
        ret.put("authFailed", authFailed);
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
            if (next == null) {
                /* 无待处理样本：顺路做一次 24h 节流的 janitor 扫描
                   （SIMPLIFY_CAPTURE_FLOW_V1：sample sync success 后的时机之一） */
                runJanitor(false);
                return;
            }
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

    /** 最老的一条待处理样本（FIFO）；上传完成但未 sealed 的跳过。
     *  FEEDBACK_PERSISTENCE_REPAIR_V1：样本已同步但反馈待传的样本必须被拾取——
     *  旧逻辑依赖 isRetryDue，而 commit 成功后 status 停在 capture_uploaded，
     *  isRetryDue 永远返回 false → commit 后提交的反馈被永久搁浅（根因之一）。 */
    private File pickNextDue() {
        File[] dirs = queueDir().listFiles();
        if (dirs == null) { return null; }
        List<File> due = new ArrayList<File>();
        for (File dir : dirs) {
            if (!dir.isDirectory() || !validSampleId(dir.getName())) { continue; }
            JSONObject st = readState(dir, dir.getName());
            boolean sampleDone = st.optBoolean("sampleUploaded", false);
            boolean feedbackPending = new File(dir, FEEDBACK_NAME).exists()
                    && !st.optBoolean("feedbackUploaded", true);
            if (sampleDone && !feedbackPending) { continue; }   // 已同步完成
            if (sampleDone) {
                // 反馈补传：不受上传重试节奏约束，只看反馈自身退避
                if (SampleQueueModel.isFeedbackUploadDue(st, System.currentTimeMillis())) {
                    due.add(dir);
                }
                continue;
            }
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
        final boolean captureReady = SampleQueueModel.isCaptureReady(st);
        st.put("status", captureReady
                ? SampleQueueModel.STATUS_CAPTURE_UPLOADED
                : SampleQueueModel.STATUS_UPLOADING_CAPTURE);
        st.put("lastError", JSONObject.NULL);
        writeState(dir, st);
        notifyChanged();

        boolean needFeedback = new File(dir, FEEDBACK_NAME).exists()
                && !st.optBoolean("feedbackUploaded", true);

        if (!st.optBoolean("sampleUploaded", false)) {
            /* R2_FAST_TRANSFER_V1：init → presigned PUT → commit。
               任一步失败都保留全部本地数据（recordFailure 只改状态）。 */
            File capture = new File(dir, CAPTURE_NAME);
            if (!capture.exists() || capture.length() == 0) {
                recordFailure(dir, "capture.jpg missing", false);
                return;
            }
            /* sha256 本地算一次并持久化：重试时不必重算（大图也只是一次线性读） */
            String sha = st.optString("captureSha256", "");
            if (sha == null || sha.length() != 64) {
                sha = sha256OfFile(capture);
            }
            final long captureSize = capture.length();

            if (!SampleQueueModel.isCaptureReady(readState(dir, sampleId))) {
                /* ---- Step 1: /api/sample/init（小请求，走 Tunnel，带 device credential） ---- */
                JSONObject initBody = new JSONObject();
                initBody.put("sampleId", sampleId);
                initBody.put("captureSha256", sha);
                initBody.put("captureSize", captureSize);
                initBody.put("contentType", CAPTURE_CONTENT_TYPE);

                HttpResult initRes = httpPostJsonResult(serverUrl + "/api/sample/init",
                        initBody.toString().getBytes(StandardCharsets.UTF_8));
                if (initRes.status == 401 || initRes.status == 403) {
                    markAuthFailed(dir, "init HTTP " + initRes.status);
                    return;
                }
                if (initRes.status == 429) {
                    /* 限流：尊重 Retry-After（没有则用默认退避） */
                    recordRateLimited(dir, "init HTTP 429", initRes.retryAfterMs);
                    return;
                }
                if (initRes.status < 200 || initRes.status >= 300) {
                    recordFailure(dir, "init HTTP " + initRes.status, isRetryableStatus(initRes.status));
                    return;
                }
                JSONObject init = tryParseObject(initRes.body);
                final String putUrl = init == null ? null : init.optString("presignedPutUrl", "");
                final String objectKey = init == null ? null : init.optString("objectKey", "");
                if (putUrl == null || putUrl.isEmpty() || objectKey == null || objectKey.isEmpty()) {
                    recordFailure(dir, "init response missing upload target", true);
                    return;
                }
                if (!putUrl.startsWith("https://")) {
                    /* presigned URL 必须是 https：明文上传不可接受 */
                    recordFailure(dir, "init returned non-https upload url", false);
                    return;
                }

                /* ---- Step 2: 直传 COS（原生文件流；不经 Tunnel/Collector，不 base64） ---- */
                long putStartedAt = android.os.SystemClock.elapsedRealtime();
                int putStatus = httpPutFile(putUrl, capture, init.optJSONObject("requiredHeaders"));
                long putElapsedMs = android.os.SystemClock.elapsedRealtime() - putStartedAt;
                /* 非敏感诊断（真机验收用）：大小 / 耗时 / 平均速率。绝不记录 URL。 */
                recordUploadDiagnostics(dir, captureSize, putElapsedMs);
                if (putStatus == 403 || putStatus == 400) {
                    /* presigned 过期或签名不符：不做永久 failed，本次放弃，
                       下次重新 init 拿新 URL（objectKey 由服务器派生，幂等安全） */
                    recordFailure(dir, "COS PUT HTTP " + putStatus + " (will re-init)", true);
                    return;
                }
                if (putStatus < 200 || putStatus >= 300) {
                    recordFailure(dir, "COS PUT HTTP " + putStatus, isRetryableStatus(putStatus));
                    return;
                }
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    SampleQueueModel.markCaptureUploaded(cur, objectKey, sha);
                    writeState(dir, cur);
                }
                notifyChanged();
                st = readState(dir, sampleId);
            }

            /* ---- Step 3: /api/sample/commit（小请求：只带 run.json 与校验字段） ---- */
            String manifestJson = new String(readFile(new File(dir, RUN_NAME)), StandardCharsets.UTF_8);
            JSONObject manifest = tryParseObject(manifestJson.getBytes(StandardCharsets.UTF_8));
            if (manifest == null) {
                recordFailure(dir, "run.json unreadable", false);
                return;
            }
            JSONObject commitBody = new JSONObject();
            commitBody.put("sampleId", sampleId);
            commitBody.put("objectKey", st.optString("captureObjectKey", ""));
            commitBody.put("captureSha256", sha);
            commitBody.put("captureSize", captureSize);
            commitBody.put("manifest", manifest);

            HttpResult commitRes = httpPostJsonResult(serverUrl + "/api/sample/commit",
                    commitBody.toString().getBytes(StandardCharsets.UTF_8));
            if (commitRes.status == 401 || commitRes.status == 403) {
                markAuthFailed(dir, "commit HTTP " + commitRes.status);
                return;
            }
            if (commitRes.status == 429) {
                recordRateLimited(dir, "commit HTTP 429", commitRes.retryAfterMs);
                return;
            }
            if (commitRes.status == 404) {
                /* COS 上对象不在（例如上次 PUT 其实没完成就重启）：清直传进度，下次重传 */
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    SampleQueueModel.resetCaptureUpload(cur);
                    writeState(dir, cur);
                }
                recordFailure(dir, "commit object missing", true);
                return;
            }
            if (commitRes.status < 200 || commitRes.status >= 300) {
                recordFailure(dir, "commit HTTP " + commitRes.status, isRetryableStatus(commitRes.status));
                return;
            }
            synchronized (stateLock) {
                JSONObject cur = readState(dir, sampleId);
                SampleQueueModel.markCommitted(cur);
                writeState(dir, cur);
            }
            notifyChanged();
        }

        if (needFeedback && !readState(dir, sampleId).optBoolean("feedbackUploaded", true)) {
            File fbFile = new File(dir, FEEDBACK_NAME);
            String revision = readRevision(fbFile);
            byte[] body = readFile(fbFile);
            /* body 是本机当前反馈的 v2 全量文档；server 端按幂等全量替换处理
               （FEEDBACK_PERSISTENCE_REPAIR_V1：旧 worker 直接 POST 文档曾被
               当作操作模型拒绝 400，进而把已同步样本打成 failed——双根因之二） */
            HttpResult fbRes = httpPostJsonResult(serverUrl + "/api/feedback", body);
            int status = fbRes.status;
            if (status >= 200 && status < 300) {
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    // revision 保护：仅当本地反馈未再变化才标记已同步
                    //（server ACK 旧 revision 时不得覆盖本机新 revision）
                    if (readRevision(fbFile).equals(revision)) {
                        SampleQueueModel.markFeedbackSynced(cur);
                    }
                    writeState(dir, cur);
                }
                notifyChanged();
            } else if (status == 401 || status == 403) {
                markAuthFailed(dir, "feedback HTTP " + status);
                return;
            } else if (status == 429) {
                /* 限流：仅退避反馈自身，绝不影响已同步的样本本体 */
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    SampleQueueModel.markFeedbackRateLimited(cur, "feedback HTTP 429",
                            System.currentTimeMillis(), fbRes.retryAfterMs);
                    writeState(dir, cur);
                }
                notifyChanged();
            } else {
                /* FEEDBACK_PERSISTENCE_REPAIR_V1：反馈失败不再 recordFailure——
                   旧逻辑把整个已同步样本降级 failed（4xx 永久），现在只退避反馈 */
                synchronized (stateLock) {
                    JSONObject cur = readState(dir, sampleId);
                    SampleQueueModel.markFeedbackError(cur, "feedback HTTP " + status,
                            System.currentTimeMillis());
                    writeState(dir, cur);
                }
                notifyChanged();
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

    /** 401/403：认证失败，保留数据不自动重试（等待新版本或手动重试）。 */
    private void markAuthFailed(File dir, String error) throws Exception {
        synchronized (stateLock) {
            JSONObject cur = readState(dir, dir.getName());
            SampleQueueModel.markAuthFailed(cur, error, authGeneration());
            writeState(dir, cur);
        }
        notifyChanged();
    }

    /** 5xx / 408 / 网络类错误可退避重试；429 单独处理（尊重 Retry-After）。 */
    private static boolean isRetryableStatus(int status) {
        return status >= 500 || status == 408;
    }

    /**
     * 429 限流：尊重服务端 Retry-After（逻辑在 SampleQueueModel，可 JVM 单测）。
     * 数据照旧保留，只是推迟下次尝试，绝不进入 failed。
     */
    private void recordRateLimited(File dir, String error, long retryAfterMs) throws Exception {
        synchronized (stateLock) {
            JSONObject cur = readState(dir, dir.getName());
            SampleQueueModel.markRateLimited(cur, error, System.currentTimeMillis(), retryAfterMs);
            writeState(dir, cur);
        }
        notifyChanged();
    }

    /**
     * 非敏感上传诊断（真机验收用）：capture 大小、COS PUT 耗时、平均速率。
     * 只写数字到本地 state.json，绝不含 URL / 签名 / secret。
     */
    private void recordUploadDiagnostics(File dir, long captureSize, long putElapsedMs) {
        try {
            synchronized (stateLock) {
                JSONObject cur = readState(dir, dir.getName());
                cur.put("captureSize", captureSize);
                cur.put("captureUploadMs", putElapsedMs);
                if (putElapsedMs > 0) {
                    cur.put("captureBytesPerSec", (long) (captureSize * 1000.0 / putElapsedMs));
                }
                writeState(dir, cur);
            }
        } catch (Exception e) { /* 诊断失败不影响上传主链路 */ }
    }

    private static JSONObject tryParseObject(byte[] body) {
        if (body == null || body.length == 0) { return null; }
        try { return new JSONObject(new String(body, StandardCharsets.UTF_8)); }
        catch (Exception e) { return null; }
    }

    /** 文件 SHA-256（流式，不整文件进内存）。 */
    private static String sha256OfFile(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        FileInputStream in = new FileInputStream(f);
        byte[] buf = new byte[64 * 1024];
        int n;
        try {
            while ((n = in.read(buf)) > 0) { md.update(buf, 0, n); }
        } finally {
            try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
        byte[] digest = md.digest();
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) { sb.append(Character.forDigit((b >> 4) & 0xF, 16))
                .append(Character.forDigit(b & 0xF, 16)); }
        return sb.toString();
    }

    private static final class HttpResult {
        final int status;
        final byte[] body;
        /* 服务端 Retry-After（毫秒），无则为 0 */
        final long retryAfterMs;
        HttpResult(int status, byte[] body, long retryAfterMs) {
            this.status = status; this.body = body; this.retryAfterMs = retryAfterMs;
        }
    }

    /** 解析 Retry-After（仅支持秒数形式；HTTP-date 罕见，忽略并回退默认退避）。 */
    private static long parseRetryAfterMs(String value) {
        if (value == null || value.isEmpty()) { return 0L; }
        try { return Math.max(0L, Long.parseLong(value.trim()) * 1000L); }
        catch (NumberFormatException e) { return 0L; }
    }

    /** 读响应体（上限保护），失败时返回空体而不是抛错。 */
    private static byte[] readResponseBody(HttpURLConnection conn, int maxBytes) {
        InputStream in = null;
        try {
            in = conn.getInputStream();
        } catch (Exception e) {
            try { in = conn.getErrorStream(); } catch (Exception e2) { return new byte[0]; }
        }
        if (in == null) { return new byte[0]; }
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (bos.size() + n > maxBytes) { break; }
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            return new byte[0];
        } finally {
            try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
    }

    /** POST JSON 并读回响应体（init/commit 需要看 body）。 */
    private HttpResult httpPostJsonResult(String url, byte[] body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(HTTP_READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(body.length);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        final String token = writeToken();
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        try {
            OutputStream out = conn.getOutputStream();
            try { out.write(body); } finally {
                try { out.close(); } catch (Exception e) { /* 尽力关闭 */ }
            }
            int status = conn.getResponseCode();
            return new HttpResult(status, readResponseBody(conn, MAX_CONTROL_RESPONSE_BYTES),
                    parseRetryAfterMs(conn.getHeaderField("Retry-After")));
        } finally {
            conn.disconnect();
        }
    }

    /**
     * R2 presigned PUT：从本地文件**流式**上传（setFixedLengthStreamingMode + 64KB 缓冲）。
     * - 绝不 base64、绝不整图进内存
     * - 绝不附加 Authorization：presigned URL 自带临时授权，附加头会破坏签名
     * - requiredHeaders（Content-Type / x-amz-meta-*）是签名的一部分，必须原样发送
     */
    private int httpPutFile(String url, File file, JSONObject requiredHeaders) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(HTTP_READ_TIMEOUT_MS);
        conn.setRequestMethod("PUT");
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(file.length());
        conn.setRequestProperty("Content-Type", CAPTURE_CONTENT_TYPE);
        if (requiredHeaders != null) {
            Iterator<String> keys = requiredHeaders.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = requiredHeaders.optString(k, "");
                if (k != null && !k.isEmpty() && v != null && !v.isEmpty()) {
                    conn.setRequestProperty(k, v);
                }
            }
        }
        try {
            FileInputStream in = new FileInputStream(file);
            try {
                OutputStream out = conn.getOutputStream();
                try {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); }
                } finally {
                    try { out.close(); } catch (Exception e) { /* 尽力关闭 */ }
                }
            } finally {
                try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
            }
            int status = conn.getResponseCode();
            readResponseBody(conn, 8 * 1024);   /* 排空小错误体，避免连接悬挂 */
            return status;
        } finally {
            conn.disconnect();
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

    /* 写接口认证 token：来自编译期 BuildConfig（发布流程注入），JS/localStorage 永远拿不到 */
    private String writeToken() {
        try {
            return BuildConfig.MSQ_SAMPLE_WRITE_TOKEN;
        } catch (Exception e) {
            return "";
        }
    }

    /* 认证 generation（编译期非敏感整数，非 token/hash）：token 轮换发布新版时递增，
       用于旧 auth_failed 样本的启动自动恢复判定 */
    private int authGeneration() {
        try {
            return BuildConfig.MSQ_SAMPLE_AUTH_GENERATION;
        } catch (Exception e) {
            return 1;
        }
    }

    private int httpPostJson(String url, byte[] body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(HTTP_READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(body.length);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        final String token = writeToken();
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
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
