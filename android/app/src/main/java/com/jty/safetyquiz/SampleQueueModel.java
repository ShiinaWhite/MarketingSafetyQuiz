package com.jty.safetyquiz;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1 队列状态机纯逻辑（无 Android 依赖，JVM 单测覆盖）。
 * 状态：pending → uploading → (成功标记 sampleUploaded/feedbackUploaded) 或
 * retry_wait（退避）→ failed（超过自动重试上限，等待手动重试）。
 * App 启动恢复：uploading 一律视为 pending（服务端幂等，重传安全）。
 *
 * R2_FAST_TRANSFER_V1 扩展（capture.jpg 直传私有 R2，不再经 Tunnel）：
 *   pending → uploading_capture → capture_uploaded → (commit) → sampleUploaded → feedback → done
 * 新增状态/字段：
 *   status=uploading_capture 正在向 R2 presigned URL PUT capture.jpg
 *   status=capture_uploaded  capture.jpg 已在 R2；下一步是 /api/sample/commit
 *   captureUploaded / captureObjectKey / captureSha256  直传进度（持久化，重启可续）
 *   sampleCommitted          与 sampleUploaded 同一事件的显式名字
 * 协议幂等：init 对同一 sampleId 恒返回同一 objectKey；重传相同字节是安全覆盖；
 * commit 对相同 (sampleId, sha256, objectKey) 返回 200 alreadyCommitted。
 * 因此 App 被杀在 uploading_capture 时，下次启动重新 init+PUT 一定安全。
 */
public final class SampleQueueModel {

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_UPLOADING = "uploading";
    /** R2 直传：正在 PUT capture.jpg 到 presigned URL */
    public static final String STATUS_UPLOADING_CAPTURE = "uploading_capture";
    /** R2 直传：capture.jpg 已就位，等待 /api/sample/commit */
    public static final String STATUS_CAPTURE_UPLOADED = "capture_uploaded";
    public static final String STATUS_RETRY_WAIT = "retry_wait";
    public static final String STATUS_FAILED = "failed";
    /** 认证失败（401/403）：非瞬时错误，不自动重试；OTA 新版本或手动重试后恢复。 */
    public static final String STATUS_AUTH_FAILED = "auth_failed";

    /** 自动重试退避：5s / 15s / 60s（之后保持 60s 间隔直到上限）。 */
    public static final long[] RETRY_BACKOFF_MS = {5000L, 15000L, 60000L};
    public static final int MAX_AUTO_RETRY = 5;

    private SampleQueueModel() {
    }

    /** App 启动恢复：进程死亡时可能停在任一进行中状态，统一视为 pending 重新入队。
     *  R2 直传的两个中间态同样回落 pending——真实进度由 captureUploaded 等字段承载，
     *  所以「回到 pending」不会丢失已完成的工作，也不会假设 PUT 已经成功。 */
    public static String normalizeStatusOnBoot(String status) {
        if (STATUS_UPLOADING.equals(status)
                || STATUS_UPLOADING_CAPTURE.equals(status)
                || STATUS_CAPTURE_UPLOADED.equals(status)) {
            return STATUS_PENDING;
        }
        return status;
    }

    /** 第 retryCount 次失败后的退避时长（retryCount 从 1 计）。 */
    public static long retryDelayMs(int retryCount) {
        int idx = Math.min(Math.max(retryCount - 1, 0), RETRY_BACKOFF_MS.length - 1);
        return RETRY_BACKOFF_MS[idx];
    }

    /** 该样本现在是否应该被 worker 拾起（failed/auth_failed 只等手动重试或新版本）。 */
    public static boolean isRetryDue(JSONObject state, long now) {
        String st = state.optString("status", STATUS_PENDING);
        if (STATUS_PENDING.equals(st)) { return true; }
        if (STATUS_RETRY_WAIT.equals(st)) { return state.optLong("nextRetryAt", 0L) <= now; }
        return false;   // uploading / failed / auth_failed 均不自动拾取
    }

    /**
     * 认证失败（401/403）：数据绝不删除，等待 App 更新（新 token）或手动重试。
     * 记录失败发生时的 AUTH_GENERATION（非敏感整数，非 token/hash）：
     * 未来 App generation 更大时，启动恢复逻辑会自动重试一次。
     */
    public static JSONObject markAuthFailed(JSONObject state, String error, int authGeneration)
            throws JSONException {
        state.put("status", STATUS_AUTH_FAILED);
        state.put("lastError", error == null ? "" : error);
        state.put("authFailedGeneration", authGeneration);
        state.put("nextRetryAt", JSONObject.NULL);
        return state;
    }

    /**
     * auth_failed 自动恢复判定（QUEUE_RECOVERY_AND_CLEANUP_V1）：
     * 仅 auth_failed 且记录的失败 generation 严格小于当前 App generation 时恢复
     * （legacy 无 authFailedGeneration 视为 0，升级后自动恢复一次）；
     * 同 generation 说明当前版本的 token 本身仍被拒，保持 auth_failed 防循环 401。
     * 普通 failed 不受 generation 影响，永不因升级自动重试。
     */
    public static boolean shouldAutoRecoverAuthFailed(JSONObject state, int currentGeneration) {
        if (!STATUS_AUTH_FAILED.equals(state.optString("status", ""))) { return false; }
        int failedGeneration = state.optInt("authFailedGeneration", 0);
        return failedGeneration < currentGeneration;
    }

    /** 恢复为 pending：清零重试计数、清除下次重试时间；旧错误移入 previousError 保留历史。 */
    public static JSONObject recoverToPending(JSONObject state) throws JSONException {
        String lastError = state.optString("lastError", "");
        if (!lastError.isEmpty()) { state.put("previousError", lastError); }
        state.put("status", STATUS_PENDING);
        state.put("retryCount", 0);
        state.put("nextRetryAt", JSONObject.NULL);
        return state;
    }

    /** 是否已到达可清理条件：已 sealed 且 sample/feedback 均同步完成。 */
    public static boolean canCleanup(JSONObject state, boolean sealed) {
        return sealed
                && state.optBoolean("sampleUploaded", false)
                && state.optBoolean("feedbackUploaded", true);
    }

    /** 初始 state（无反馈时 feedbackUploaded=true，表示没有待传反馈）。 */
    public static JSONObject initialState(String sampleId, long now, boolean hasFeedback)
            throws JSONException {
        JSONObject st = new JSONObject();
        st.put("schemaVersion", 1);
        st.put("sampleId", sampleId);
        st.put("createdAt", now);
        st.put("status", STATUS_PENDING);
        st.put("retryCount", 0);
        st.put("nextRetryAt", JSONObject.NULL);
        st.put("sampleUploaded", false);
        st.put("feedbackUploaded", !hasFeedback);
        st.put("lastError", JSONObject.NULL);
        st.put("sealed", false);
        st.put("feedbackRevision", 0);
        /* R2 直传进度（R2_FAST_TRANSFER_V1） */
        st.put("captureUploaded", false);
        st.put("captureObjectKey", JSONObject.NULL);
        st.put("captureSha256", JSONObject.NULL);
        st.put("sampleCommitted", false);
        return st;
    }

    /** capture.jpg 已成功 PUT 到 R2：记录服务器分配的 objectKey 与本地算出的 sha256。
     *  objectKey 恒为服务器派生值，客户端只是把它持久化以便 commit 时回传。 */
    public static JSONObject markCaptureUploaded(JSONObject state, String objectKey, String sha256)
            throws JSONException {
        state.put("captureUploaded", true);
        state.put("captureObjectKey", objectKey == null ? JSONObject.NULL : objectKey);
        state.put("captureSha256", sha256 == null ? JSONObject.NULL : sha256);
        state.put("status", STATUS_CAPTURE_UPLOADED);
        return state;
    }

    /** commit 成功：capture 已在服务端确认落库。
     *  sampleCommitted 是本轮新增的显式名字；sampleUploaded 是既有字段，
     *  两者描述同一事件，因此**只在这里一起写入**，避免出现两个真相。 */
    public static JSONObject markCommitted(JSONObject state) throws JSONException {
        state.put("sampleCommitted", true);
        state.put("sampleUploaded", true);
        return state;
    }

    /** commit 发现 R2 上对象不存在（例如 PUT 其实没完成就重启了）：
     *  清掉直传进度，下次重新 init + PUT。协议幂等，重传安全。 */
    public static JSONObject resetCaptureUpload(JSONObject state) throws JSONException {
        state.put("captureUploaded", false);
        state.put("captureObjectKey", JSONObject.NULL);
        state.put("sampleCommitted", false);
        state.put("sampleUploaded", false);
        return state;
    }

    /** 是否已完成 R2 直传（可直接进入 commit）。 */
    public static boolean isCaptureReady(JSONObject state) {
        return state.optBoolean("captureUploaded", false)
                && state.optString("captureObjectKey", "").length() > 0;
    }

    /** 记录一次失败：未达上限 → retry_wait + nextRetryAt；达上限 → failed。 */
    public static JSONObject markError(JSONObject state, String error, long now)
            throws JSONException {
        int retryCount = state.optInt("retryCount", 0) + 1;
        state.put("retryCount", retryCount);
        state.put("lastError", error == null ? "" : error);
        if (retryCount >= MAX_AUTO_RETRY) {
            state.put("status", STATUS_FAILED);
            state.put("nextRetryAt", JSONObject.NULL);
        } else {
            state.put("status", STATUS_RETRY_WAIT);
            state.put("nextRetryAt", now + retryDelayMs(retryCount));
        }
        return state;
    }

    /** 服务端限流（429）：尊重 Retry-After，封顶 10 分钟，绝不到 failed。 */
    public static final long RATE_LIMIT_MAX_WAIT_MS = 600_000L;

    public static JSONObject markRateLimited(JSONObject state, String error, long now,
                                             long retryAfterMs) throws JSONException {
        long wait = retryAfterMs > 0 ? Math.min(retryAfterMs, RATE_LIMIT_MAX_WAIT_MS)
                : retryDelayMs(1);
        state.put("status", STATUS_RETRY_WAIT);
        state.put("lastError", error == null ? "" : error);
        state.put("retryCount", state.optInt("retryCount", 0) + 1);
        state.put("nextRetryAt", now + wait);
        return state;
    }

    /* ---------------- 反馈补传（FEEDBACK_PERSISTENCE_REPAIR_V1） ----------------
       修复的两个根因都在这里收口为可 JVM 单测的纯函数：
       1) 样本 commit 成功后 status 停在 capture_uploaded（历史遗留），isRetryDue
          永远不放行 → commit 后提交的反馈被搁浅。现在样本完成后的反馈补传
          改由 isFeedbackUploadDue 判定，不再依赖上传重试节奏。
       2) 反馈上传失败曾把整个样本降级 failed（样本本体明明已同步）。
          现在反馈失败只退避反馈自身（独立计数/时间），绝不改样本状态。 */

    /** 反馈退避上限（与 RATE_LIMIT_MAX_WAIT_MS 一致）。 */
    public static final long FEEDBACK_RETRY_MAX_WAIT_MS = 600_000L;

    /**
     * worker 是否应拾取该样本的反馈补传（调用方保证 feedback.json 存在）。
     * 样本本体已同步 → 只看反馈自身的退避时间；样本未同步 → 随样本上传节奏
     * （isRetryDue）处理，processSample 的 needFeedback 会一并补传。
     */
    public static boolean isFeedbackUploadDue(JSONObject state, long now) {
        if (state.optBoolean("feedbackUploaded", true)) { return false; }
        if (!state.optBoolean("sampleUploaded", false)) { return false; }
        return state.optLong("feedbackNextRetryAt", 0L) <= now;
    }

    /** 反馈已同步（2xx 且 revision 未变）：清除退避，标记 synced。 */
    public static JSONObject markFeedbackSynced(JSONObject state) throws JSONException {
        state.put("feedbackUploaded", true);
        state.put("feedbackSyncState", "synced");
        state.put("feedbackNextRetryAt", JSONObject.NULL);
        return state;
    }

    /** 反馈上传失败（4xx/5xx/网络）：仅退避反馈自身，绝不改样本状态/绝不 failed。 */
    public static JSONObject markFeedbackError(JSONObject state, String error, long now)
            throws JSONException {
        int count = state.optInt("feedbackRetryCount", 0) + 1;
        state.put("feedbackRetryCount", count);
        state.put("feedbackLastError", error == null ? "" : error);
        state.put("feedbackSyncState", "pending");
        long wait = Math.min(retryDelayMs(count), FEEDBACK_RETRY_MAX_WAIT_MS);
        state.put("feedbackNextRetryAt", now + wait);
        return state;
    }

    /** 反馈被限流（429）：尊重服务端 Retry-After，封顶 10 分钟。 */
    public static JSONObject markFeedbackRateLimited(JSONObject state, String error, long now,
                                                     long retryAfterMs) throws JSONException {
        state.put("feedbackRetryCount", state.optInt("feedbackRetryCount", 0) + 1);
        state.put("feedbackLastError", error == null ? "" : error);
        state.put("feedbackSyncState", "pending");
        long wait = retryAfterMs > 0 ? Math.min(retryAfterMs, FEEDBACK_RETRY_MAX_WAIT_MS)
                : retryDelayMs(1);
        state.put("feedbackNextRetryAt", now + wait);
        return state;
    }

    public static JSONObject fromJson(String json) throws JSONException {
        return new JSONObject(json);
    }

    public static String toJson(JSONObject state) {
        return state.toString();
    }
}
