package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

/**
 * FEEDBACK_PERSISTENCE_REPAIR_V1 回归（FB-P 系列，JVM 可测的状态机面）。
 *
 * 根因回归：
 * - 根因一（搁浅）：样本 commit 成功后 status 停在 capture_uploaded，
 *   旧 pickNextDue 依赖 isRetryDue（只放行 pending/retry_wait）→ 反馈永不补传。
 *   回归锚点 = isFeedbackUploadDue 对该场景必须为 true。
 * - 根因二（协议错配）：worker POST 的 v2 全量文档曾被 server 当操作模型拒绝
 *   400，进而把已同步样本打成 failed。文档侧回归在 test_collector.js（真实 HTTP）；
 *   本类锚定「反馈上传失败绝不降级样本状态」。
 */
public class FeedbackPersistenceTest {

    private static final long T0 = 1_000_000L;

    /** 已 commit 的样本状态（复现搁浅现场：status 停在 capture_uploaded）。 */
    private JSONObject committedSample() throws JSONException {
        JSONObject st = SampleQueueModel.initialState("20260925_120000_aa11aa", T0, false);
        st = SampleQueueModel.markCaptureUploaded(st, "samples/2026-09-25/x/capture.jpg", "c".repeat(64));
        assertEquals(SampleQueueModel.STATUS_CAPTURE_UPLOADED, st.getString("status"));
        return SampleQueueModel.markCommitted(st);
    }

    /** persistFeedback 的 state 语义（与 SampleQueuePlugin.persistFeedback 一致）。 */
    private JSONObject feedbackMarkedPending(JSONObject st) throws JSONException {
        st.put("feedbackUploaded", false);
        st.put("feedbackRevision", st.optInt("feedbackRevision", 0) + 1);
        st.put("feedbackPersistedAt", T0 + 1);
        st.put("feedbackSyncState", "pending");
        st.put("feedbackNextRetryAt", JSONObject.NULL);
        return st;
    }

    /* FB-P1/FB-P2 根因回归：commit 后（status=capture_uploaded）提交的反馈必须被拾取 */
    @Test
    public void fbP1_feedbackAfterCommit_isPickedUp() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        assertTrue("根因一回归：commit 后的反馈必须可补传",
                SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
        // 旧逻辑等价断言：isRetryDue 对该状态为 false（证明旧路径确实拾取不到）
        assertFalse(SampleQueueModel.isRetryDue(st, T0 + 10));
    }

    /* 反馈同步完成后不再拾取 */
    @Test
    public void fbP1_syncedFeedback_notPickedAgain() throws JSONException {
        JSONObject st = SampleQueueModel.markFeedbackSynced(feedbackMarkedPending(committedSample()));
        assertEquals("synced", st.getString("feedbackSyncState"));
        assertTrue(st.getBoolean("feedbackUploaded"));
        assertFalse(SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
    }

    /* FB-P5 重启保留：normalizeStatusOnBoot 只动 status，反馈待传状态原样保留 */
    @Test
    public void fbP5_restartPreservesPendingFeedback() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        String after = SampleQueueModel.normalizeStatusOnBoot(st.getString("status"));
        st.put("status", after);
        assertEquals(SampleQueueModel.STATUS_PENDING, after);
        assertFalse(st.getBoolean("feedbackUploaded"));
        assertTrue("重启后反馈仍待传、仍会被拾取", SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
    }

    /* FB-P6 离线保留 + 不降级样本：反馈上传失败只退避反馈自身 */
    @Test
    public void fbP6_offlineFeedback_backsOffWithoutSampleDowngrade() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        String statusBefore = st.getString("status");
        boolean sampleUploadedBefore = st.getBoolean("sampleUploaded");
        SampleQueueModel.markFeedbackError(st, "feedback HTTP 500", T0 + 10);
        assertEquals("pending", st.getString("feedbackSyncState"));
        assertFalse(st.getBoolean("feedbackUploaded"));
        assertEquals("样本状态不得被反馈失败改动", statusBefore, st.getString("status"));
        assertTrue(st.getBoolean("sampleUploaded"));
        assertTrue(st.optLong("feedbackNextRetryAt", 0L) > T0 + 10);
        assertFalse("退避期内不拾取", SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
        assertTrue("退避到期后重新拾取", SampleQueueModel.isFeedbackUploadDue(st, T0 + 10 + 60_000));
    }

    /* FB-P7 旧 ACK 不覆盖新 revision：guard 语义 = revision 变化就不调 markFeedbackSynced。
       这里锚定状态机面：未调 synced 的状态保持待传 + revision 不被服务端 ACK 回写。 */
    @Test
    public void fbP7_staleAckDoesNotOverwriteNewerLocalRevision() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        int revisionBefore = st.getInt("feedbackRevision");
        // 用户在 POST 期间又改了一次反馈（persistFeedback 语义再跑一遍）
        feedbackMarkedPending(st);
        assertTrue(st.getInt("feedbackRevision") > revisionBefore);
        // 旧请求的 ACK 到达：plugin 的 readRevision 比对不相等 → 不调 markFeedbackSynced
        assertFalse(st.getBoolean("feedbackUploaded"));
        assertEquals("pending", st.getString("feedbackSyncState"));
        assertTrue(SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
        // 反面：revision 未变时 synced 正常落位，且不回退 revision
        SampleQueueModel.markFeedbackSynced(st);
        assertTrue(st.getBoolean("feedbackUploaded"));
        assertEquals("revision 单调，不被 ACK 覆盖", 2, st.getInt("feedbackRevision"));
    }

    /* 同 sample 多次修改反馈：feedbackRevision 单调递增 */
    @Test
    public void fbRevision_monotonicAcrossEdits() throws JSONException {
        JSONObject st = committedSample();
        feedbackMarkedPending(st);
        feedbackMarkedPending(st);
        feedbackMarkedPending(st);
        assertEquals(3, st.getInt("feedbackRevision"));
    }

    /* FB-P4/FB-P8 状态机面：空文档（清除）与共存文档同样走「待传 → 拾取 → 同步」，
       文档内容本身由 collector 真实 HTTP 测试覆盖（test_collector.js）。 */
    @Test
    public void fbP8_clearedFeedback_stillPersistsAndUploads() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        assertTrue(SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
        SampleQueueModel.markFeedbackSynced(st);
        assertFalse(SampleQueueModel.isFeedbackUploadDue(st, T0 + 10));
    }

    /* FB-P10 清理规则：已 sealed 且 sample+feedback 全同步才可清理；
       反馈未同步时即使 sealed 也不可清理（feedback.json 不会丢）。 */
    @Test
    public void fbP10_cleanupRespectsFeedbackSyncState() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        assertFalse(SampleQueueModel.canCleanup(st, true));
        SampleQueueModel.markFeedbackSynced(st);
        assertTrue(SampleQueueModel.canCleanup(st, true));
        // 反馈失败退避中：同样不可清理
        JSONObject st2 = feedbackMarkedPending(committedSample());
        SampleQueueModel.markFeedbackError(st2, "feedback HTTP 503", T0 + 10);
        assertFalse(SampleQueueModel.canCleanup(st2, true));
    }

    /* FB-P9 状态机面：每个 sample 独立 state（新 sample 反馈字段归零，不跨样本残留）。
       plugin 对不存在目录 reject NOT_FOUND（不误写旧样本）由代码路径 + collector
       404 测试覆盖（test_collector.js）。 */
    @Test
    public void fbP9_newSampleStartsWithCleanFeedbackState() throws JSONException {
        JSONObject fresh = SampleQueueModel.initialState("20260925_130000_bb22bb", T0, false);
        assertTrue(fresh.getBoolean("feedbackUploaded"));
        assertEquals(0, fresh.getInt("feedbackRevision"));
        assertFalse("无反馈文档的新样本不触发反馈补传",
                SampleQueueModel.isFeedbackUploadDue(fresh, T0 + 10));
    }

    /* FB-P6 补充：429 限流尊重 Retry-After 且封顶，绝不 failed */
    @Test
    public void fbP6_rateLimitedFeedback_respectsRetryAfter() throws JSONException {
        JSONObject st = feedbackMarkedPending(committedSample());
        SampleQueueModel.markFeedbackRateLimited(st, "feedback HTTP 429", T0 + 10, 120_000L);
        assertEquals("pending", st.getString("feedbackSyncState"));
        assertEquals(T0 + 10 + 120_000L, st.optLong("feedbackNextRetryAt", 0L));
        assertFalse(SampleQueueModel.isFeedbackUploadDue(st, T0 + 11));
        assertTrue(SampleQueueModel.isFeedbackUploadDue(st, T0 + 10 + 120_000L));
        assertEquals("样本本体不受限流影响", SampleQueueModel.STATUS_CAPTURE_UPLOADED,
                st.getString("status"));
        // 无 Retry-After → 默认退避；超长 Retry-After → 封顶 10 分钟
        JSONObject b = feedbackMarkedPending(committedSample());
        SampleQueueModel.markFeedbackRateLimited(b, "429", T0, 0L);
        assertTrue(b.optLong("feedbackNextRetryAt", 0L) > T0);
        JSONObject c = feedbackMarkedPending(committedSample());
        SampleQueueModel.markFeedbackRateLimited(c, "429", T0, 999_999_999L);
        assertTrue(c.optLong("feedbackNextRetryAt", 0L) <= T0 + SampleQueueModel.FEEDBACK_RETRY_MAX_WAIT_MS);
    }
}
