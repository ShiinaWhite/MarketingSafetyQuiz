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

    /* ================= R2_FAST_TRANSFER_V1：capture 直传 R2 的状态机 ================= */

    private static final String R2_KEY = "samples/2026-09-24/20260924_120000_aa11aa/capture.jpg";
    private static final String R2_SHA =
            "af0b4b46baf42e400f8a299471058e6ab76f75d933dba65fce093f806f364954";

    @Test
    public void r2_initialState_hasDirectUploadFields() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        assertEquals(false, st.getBoolean("captureUploaded"));
        assertEquals(false, st.getBoolean("sampleCommitted"));
        assertTrue(st.isNull("captureObjectKey"));
        assertTrue(st.isNull("captureSha256"));
        assertFalse(SampleQueueModel.isCaptureReady(st));
    }

    /** R2-S12：App 被杀在任一进行中状态，重启后必须回到 pending 并可被 worker 拾取。
     *  「回到 pending」不代表假装 PUT 成功——真实进度由 captureUploaded 承载。 */
    @Test
    public void r2s12_bootRecovery_coversBothR2IntermediateStates() throws JSONException {
        assertEquals(SampleQueueModel.STATUS_PENDING,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_UPLOADING_CAPTURE));
        assertEquals(SampleQueueModel.STATUS_PENDING,
                SampleQueueModel.normalizeStatusOnBoot(SampleQueueModel.STATUS_CAPTURE_UPLOADED));
        JSONObject st = state(SampleQueueModel.STATUS_PENDING, 0);
        assertTrue(SampleQueueModel.isRetryDue(st, 1L));   // 重启后立刻可被拾取
    }

    /** 重启后：captureUploaded 已为 true → 不必重传，直接进入 commit。 */
    @Test
    public void r2_bootRecovery_keepsCompletedCaptureUpload() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        st.put("status", SampleQueueModel.normalizeStatusOnBoot(st.getString("status")));
        assertEquals(SampleQueueModel.STATUS_PENDING, st.getString("status"));
        assertTrue(SampleQueueModel.isCaptureReady(st));   // 不重传 capture
        assertEquals(R2_KEY, st.getString("captureObjectKey"));
        assertEquals(R2_SHA, st.getString("captureSha256"));
    }

    @Test
    public void r2_isCaptureReady_requiresKeyNotJustFlag() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        st.put("captureUploaded", true);            // 只有 flag，没有 key
        assertFalse(SampleQueueModel.isCaptureReady(st));
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        assertTrue(SampleQueueModel.isCaptureReady(st));
    }

    @Test
    public void r2_commit_marksBothSampleCommittedAndSampleUploaded() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        SampleQueueModel.markCommitted(st);
        assertEquals(true, st.getBoolean("sampleCommitted"));
        assertEquals(true, st.getBoolean("sampleUploaded"));   // 既有字段同步，避免两个真相
        assertEquals(SampleQueueModel.STATUS_CAPTURE_UPLOADED, st.getString("status"));
    }

    /** commit 404（R2 上对象不在）：清直传进度，下次重新 init + PUT，绝不留错误完成态。 */
    @Test
    public void r2_commit404_resetsCaptureProgressForRetry() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        SampleQueueModel.resetCaptureUpload(st);
        assertFalse(st.getBoolean("captureUploaded"));
        assertFalse(st.getBoolean("sampleUploaded"));
        assertFalse(st.getBoolean("sampleCommitted"));
        assertFalse(SampleQueueModel.isCaptureReady(st));
        // sha256 保留：重传时不必重算，且内容校验基准不变
        assertEquals(R2_SHA, st.getString("captureSha256"));
    }

    /** 认证失败：数据（含直传进度）绝不丢失，等待新版本或手动重试。 */
    @Test
    public void r2_authFailed_preservesCaptureProgress() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        SampleQueueModel.markAuthFailed(st, "init HTTP 401", 1);
        assertEquals(SampleQueueModel.STATUS_AUTH_FAILED, st.getString("status"));
        assertEquals(R2_KEY, st.getString("captureObjectKey"));   // 进度保留
        assertTrue(SampleQueueModel.isCaptureReady(st));
        assertFalse(SampleQueueModel.isRetryDue(st, 999999L));    // 不循环打 401
        // 新版本 generation 更大 → 自动恢复一次
        assertTrue(SampleQueueModel.shouldAutoRecoverAuthFailed(st, 2));
        SampleQueueModel.recoverToPending(st);
        assertTrue(SampleQueueModel.isRetryDue(st, 1L));
        assertTrue(SampleQueueModel.isCaptureReady(st));          // 恢复后仍不必重传
    }

    /** R2-S11：上传失败（5xx/超时）后进入退避重试，本地数据与直传进度都保留。 */
    @Test
    public void r2s11_uploadFailure_preservesLocalDataAndProgress() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        SampleQueueModel.markError(st, "commit HTTP 502", 1000L);
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT, st.getString("status"));
        assertTrue(SampleQueueModel.isCaptureReady(st));   // capture 已在 R2，只需重试 commit
        assertFalse(st.getBoolean("sampleUploaded"));
        assertEquals(1, st.getInt("retryCount"));
    }

    /** 完整的 R2 成功链路：capture 上传 → commit → feedback → 可清理。 */
    @Test
    public void r2_fullChain_reachesCleanup() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        assertFalse(SampleQueueModel.canCleanup(st, true));        // 还没传
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        assertFalse(SampleQueueModel.canCleanup(st, true));        // capture 到位但未 commit
        SampleQueueModel.markCommitted(st);
        assertFalse(SampleQueueModel.canCleanup(st, true));        // feedback 未同步
        st.put("feedbackUploaded", true);
        assertTrue(SampleQueueModel.canCleanup(st, true));         // 全同步 → 可清理
    }

    /* ================= COS_SAMPLE_TRANSFER_V1：限流与诊断 ================= */

    /** 429 + Retry-After：按服务端指示推迟，绝不进入 failed，数据保留。 */
    @Test
    public void cos_rateLimited_respectsRetryAfter() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, true);
        SampleQueueModel.markCaptureUploaded(st, R2_KEY, R2_SHA);
        SampleQueueModel.markRateLimited(st, "commit HTTP 429", 10_000L, 30_000L);
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT, st.getString("status"));
        assertEquals(40_000L, st.getLong("nextRetryAt"));          // 10000 + 30000
        assertTrue(st.getBoolean("captureUploaded"));              // 进度与数据保留
        assertFalse(st.getBoolean("sampleUploaded"));
        // Retry-After 到期后可被 worker 拾取
        assertTrue(SampleQueueModel.isRetryDue(st, 40_000L));
        assertFalse(SampleQueueModel.isRetryDue(st, 39_999L));
    }

    /** 无 Retry-After 头：回退到默认退避（第一档 5s）。 */
    @Test
    public void cos_rateLimited_withoutHeader_usesDefaultBackoff() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        SampleQueueModel.markRateLimited(st, "init HTTP 429", 1_000L, 0L);
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT, st.getString("status"));
        assertEquals(6_000L, st.getLong("nextRetryAt"));           // 1000 + 5000
    }

    /** Retry-After 异常大：封顶 10 分钟，防止被服务端逼成长时间停摆。 */
    @Test
    public void cos_rateLimited_capsHugeRetryAfter() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        SampleQueueModel.markRateLimited(st, "commit HTTP 429", 0L, 86_400_000L);
        assertEquals(SampleQueueModel.RATE_LIMIT_MAX_WAIT_MS, st.getLong("nextRetryAt"));
    }

    /** 限流多次累积也不会变成 failed（与普通错误不同：429 永远可重试）。 */
    @Test
    public void cos_rateLimited_neverBecomesFailed() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260924_120000_aa11aa", 1000L, false);
        for (int i = 0; i < 10; i++) {
            SampleQueueModel.markRateLimited(st, "HTTP 429", i * 1000L, 1000L);
        }
        assertEquals(SampleQueueModel.STATUS_RETRY_WAIT, st.getString("status"));
        assertTrue(SampleQueueModel.isRetryDue(st, st.getLong("nextRetryAt")));
    }
}
