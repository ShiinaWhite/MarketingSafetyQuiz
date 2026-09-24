package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

/** SampleQueueModel 队列状态机纯逻辑 JVM 单测（PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1）。 */
public class SampleQueueModelTest {

    private JSONObject state(String status, int retryCount) throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        st.put("status", status);
        st.put("retryCount", retryCount);
        return st;
    }

    @Test
    public void initialState_defaults() throws JSONException {
        // hasFeedback=true：创建时已带 feedback.json → 有待传反馈
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        assertEquals(SampleQueueModel.STATUS_PENDING, st.getString("status"));
        assertEquals(false, st.getBoolean("sampleUploaded"));
        assertEquals(false, st.getBoolean("feedbackUploaded"));
        assertEquals(0, st.getInt("feedbackRevision"));
        // hasFeedback=false：无反馈 → 无待传（feedbackUploaded=true 便于清理判定）
        JSONObject st2 = SampleQueueModel.initialState("20260924_120000_bb22bb", 1000L, false);
        assertEquals(true, st2.getBoolean("feedbackUploaded"));
    }

    @Test
    public void bootRecovery_uploadingBecomesPending() {
        assertEquals(SampleQueueModel.STATUS_PENDING,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_UPLOADING));
        assertEquals(SampleQueueModel.STATUS_PENDING,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_PENDING));
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_RETRY_WAIT));
        assertEquals(SampleQueueModel.STATUS_FAILED,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_FAILED));
    }

    @Test
    public void retryDue_pendingImmediate_retryWaitByTime_failedNever() throws JSONException {
        assertTrue(SampleQueueModel.isRetryDue(state("pending", 0), 5000));
        JSONObject rw = state("retry_wait", 1);
        rw.put("nextRetryAt", 10000);
        assertFalse(SampleQueueModel.isRetryDue(rw, 9999));
        assertTrue(SampleQueueModel.isRetryDue(rw, 10000));
        assertFalse(SampleQueueModel.isRetryDue(state("uploading", 0), 5000));
        assertFalse(SampleQueueModel.isRetryDue(state("failed", 9), 999999));
        assertFalse(SampleQueueModel.isRetryDue(state("auth_failed", 0), 999999));   // 认证失败不自动重试
    }

    @Test
    public void markAuthFailed_noRetryUntilManualOrNewVersion() throws JSONException {
        JSONObject st = state("uploading", 0);
        SampleQueueModel.markAuthFailed(st, "HTTP 401", 1);
        assertEquals(SampleQueueModel.STATUS_AUTH_FAILED, st.getString("status"));
        assertEquals("HTTP 401", st.getString("lastError"));
        assertEquals(1, st.getInt("authFailedGeneration"));   // 记录 generation（非 token/hash）
        // 手动重试（retryFailed）：auth_failed → pending 后恢复可拾取
        st.put("status", SampleQueueModel.STATUS_PENDING);
        assertTrue(SampleQueueModel.isRetryDue(st, 9999));
    }

    /* ---- QUEUE_RECOVERY_AND_CLEANUP_V1：auth generation 恢复（REC-1~5） ---- */
    private JSONObject authFailedState(int generation) throws JSONException {
        JSONObject st = state(SampleQueueModel.STATUS_AUTH_FAILED, 9);
        if (generation >= 0) { st.put("authFailedGeneration", generation); }
        return st;
    }

    @Test
    public void rec1_olderGeneration_authFailed_recoversToPending() throws JSONException {
        JSONObject st = authFailedState(1);
        assertTrue(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 2));
        SampleQueueModel.recoverToPending(st);
        assertEquals(SampleQueueModel.STATUS_PENDING, st.getString("status"));
        assertEquals(0, st.getInt("retryCount"));
        assertTrue(SampleQueueModel.isRetryDue(st, 9999));   // worker 可拾取
    }

    @Test
    public void rec2_sameGeneration_staysAuthFailed() throws JSONException {
        JSONObject st = authFailedState(2);
        assertFalse(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 2));
        assertFalse(SampleQueueModel.isRetryDue(st, 999999));   // 不循环打 401
    }

    @Test
    public void rec3_legacy_missingGeneration_treatedAsZeroAndRecovers() throws JSONException {
        JSONObject st = authFailedState(-1);   // -1 = 不写入字段（legacy）
        assertFalse(st.has("authFailedGeneration"));
        assertTrue(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 1));   // legacy 0 < CURRENT 1
    }

    @Test
    public void rec4_recoveredButStill401_stableAtAuthFailed() throws JSONException {
        JSONObject st = authFailedState(-1);   // legacy
        assertTrue(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 1));
        // 恢复上传后服务器仍 401 → 写入 CURRENT generation
        SampleQueueModel.markAuthFailed(st, "HTTP 401", 1);
        assertEquals(SampleQueueModel.STATUS_AUTH_FAILED, st.getString("status"));
        assertEquals(1, st.getInt("authFailedGeneration"));
        assertFalse(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 1));   // 同 generation 不再自动
        assertFalse(SampleQueueModel.isRetryDue(st, 999999));
    }

    @Test
    public void rec5_normalFailed_notAffectedByGenerationChange() throws JSONException {
        JSONObject st = state(SampleQueueModel.STATUS_FAILED, 5);
        assertFalse(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 2));
        assertFalse(SampleQueueModel.isRetryDue(st, 999999));   // 普通 failed 不因升级乱重试
    }

    @Test
    public void backoff_5s_15s_60s_capped() {
        assertEquals(5000, SampleQueueModel.retryDelayMs(1));
        assertEquals(15000, SampleQueueModel.retryDelayMs(2));
        assertEquals(60000, SampleQueueModel.retryDelayMs(3));
        assertEquals(60000, SampleQueueModel.retryDelayMs(9));
    }

    @Test
    public void markError_retriesThenFails() throws JSONException {
        JSONObject st = state("uploading", 0);
        SampleQueueModel.markError(st, "HTTP 500", 1000);
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT, st.getString("status"));
        assertEquals(1, st.getInt("retryCount"));
        assertEquals(6000, st.getLong("nextRetryAt"));
        SampleQueueModel.markError(st, "HTTP 500", 2000);
        SampleQueueModel.markError(st, "HTTP 500", 3000);
        SampleQueueModel.markError(st, "HTTP 500", 4000);
        SampleQueueModel.markError(st, "HTTP 500", 5000);
        assertEquals(SampleQueueModel.MAX_AUTO_RETRY, st.getInt("retryCount"));
        assertEquals(SampleQueueModel.STATUS_FAILED, st.getString("status"));
    }

    @Test
    public void cleanup_requiresSealedAndFullySynced() throws JSONException {
        // 带反馈创建：sample 传完但 feedback 未传时不可清理
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        st.put("sampleUploaded", true);
        assertFalse(SampleQueueModel.canCleanup(st, true));   // feedback 未同步
        st.put("feedbackUploaded", true);
        assertTrue(SampleQueueModel.canCleanup(st, true));
        // 无反馈样本：sample 传完即可清理
        JSONObject st2 = SampleQueueModel.initialState("20260924_120000_bb22bb", 1000L, false);
        st2.put("sampleUploaded", true);
        assertTrue(SampleQueueModel.canCleanup(st2, true));
    }

    @Test
    public void stateJson_roundTrip() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 42L, true);
        st.put("sealed", true);
        JSONObject back = SampleQueueModel.fromJson(SampleQueueModel.toJson(st));
        assertEquals(42L, back.getLong("createdAt"));
        assertEquals(true, back.getBoolean("sealed"));
        assertEquals(SampleQueueModel.STATUS_PENDING, back.getString("status"));
    }
}
