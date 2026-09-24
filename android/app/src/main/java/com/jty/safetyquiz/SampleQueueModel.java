package com.jty.safetyquiz;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1 队列状态机纯逻辑（无 Android 依赖，JVM 单测覆盖）。
 * 状态：pending → uploading → (成功标记 sampleUploaded/feedbackUploaded) 或
 * retry_wait（退避）→ failed（超过自动重试上限，等待手动重试）。
 * App 启动恢复：uploading 一律视为 pending（服务端幂等，重传安全）。
 */
public final class SampleQueueModel {

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_UPLOADING = "uploading";
    public static final String STATUS_RETRY_WAIT = "retry_wait";
    public static final String STATUS_FAILED = "failed";
    /** 认证失败（401/403）：非瞬时错误，不自动重试；OTA 新版本或手动重试后恢复。 */
    public static final String STATUS_AUTH_FAILED = "auth_failed";

    /** 自动重试退避：5s / 15s / 60s（之后保持 60s 间隔直到上限）。 */
    public static final long[] RETRY_BACKOFF_MS = {5000L, 15000L, 60000L};
    public static final int MAX_AUTO_RETRY = 5;

    private SampleQueueModel() {
    }

    /** App 启动恢复：进程死亡时可能停在 uploading，统一视为 pending 重新入队。 */
    public static String normalizeStatusOnBoot(String status) {
        return STATUS_UPLOADING.equals(status) ? STATUS_PENDING : status;
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

    /** 认证失败（401/403）：数据绝不删除，等待 App 更新（新 token）或手动重试。 */
    public static JSONObject markAuthFailed(JSONObject state, String error) throws JSONException {
        state.put("status", STATUS_AUTH_FAILED);
        state.put("lastError", error == null ? "" : error);
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
        return st;
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

    public static JSONObject fromJson(String json) throws JSONException {
        return new JSONObject(json);
    }

    public static String toJson(JSONObject state) {
        return state.toString();
    }
}
