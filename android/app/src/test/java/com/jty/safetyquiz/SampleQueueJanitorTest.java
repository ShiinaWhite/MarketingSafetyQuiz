package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Set;

/** SampleQueueModel janitor 纯逻辑 JVM 单测（SIMPLIFY_CAPTURE_FLOW_V1，CAP-S12~16）。 */
public class SampleQueueJanitorTest {

    private static final long HOUR = 3600_000L;
    private static final long DAY = 24 * HOUR;

    /* ---------- CAP-S12：failed / auth_required 超 7 天删除 ---------- */

    @Test
    public void capS12_failedRetention() {
        assertEquals("retention-failed", SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_FAILED, false, true, true, 7 * DAY));
        assertEquals("retention-failed", SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_AUTH_FAILED, false, true, false, 7 * DAY + 1));
        // 未满 7 天：保留
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_FAILED, false, true, true, 7 * DAY - 1));
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_AUTH_FAILED, false, true, false, 6 * DAY));
    }

    /* ---------- CAP-S13：pending / retry_wait 超 14 天删除 ---------- */

    @Test
    public void capS13_pendingRetention() {
        assertEquals("retention-pending", SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_PENDING, false, true, true, 14 * DAY));
        assertEquals("retention-pending", SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_RETRY_WAIT, false, true, false, 14 * DAY + 1));
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_PENDING, false, true, true, 14 * DAY - 1));
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_RETRY_WAIT, false, true, false, 13 * DAY));
    }

    /* ---------- CAP-S15：active / uploading / committing / 当前结果页样本受保护 ---------- */

    @Test
    public void capS15_protectedStatesNeverDeleted() {
        // 三个进行中状态：无论多老都不删
        String[] active = {
                SampleQueueModel.STATUS_UPLOADING,
                SampleQueueModel.STATUS_UPLOADING_CAPTURE,
                SampleQueueModel.STATUS_CAPTURE_UPLOADED
        };
        for (String st : active) {
            assertNull("必须保护 " + st, SampleQueueModel.janitorDeleteReason(
                    st, false, true, false, 365 * DAY));
            assertEquals(-1, SampleQueueModel.janitorHardLimitRank(st, 365 * DAY));
        }
        // 未 sealed 的已同步新样本 = 当前结果页关联样本（<24h）：不删
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_PENDING, true, true, false, 2 * HOUR));
        // 未 sealed 但已过 24h 的已同步样本：兜底删除
        assertEquals("synced", SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_PENDING, true, true, false, 25 * HOUR));
        // 刚产生的新样本：retention 与硬限都不碰
        assertNull(SampleQueueModel.janitorDeleteReason(
                SampleQueueModel.STATUS_FAILED, false, true, false, HOUR));
        assertEquals(-1, SampleQueueModel.janitorHardLimitRank(
                SampleQueueModel.STATUS_FAILED, HOUR));
        assertEquals(-1, SampleQueueModel.janitorHardLimitRank(
                SampleQueueModel.STATUS_PENDING, 23 * HOUR));
    }

    /* ---------- CAP-S14：256MiB 硬限 ---------- */

    private JSONArray candidate(String id, int rank, long bytes) throws JSONException {
        JSONObject c = new JSONObject();
        c.put("sampleId", id);
        c.put("rank", rank);
        c.put("bytes", bytes);
        return new JSONArray().put(c);
    }

    @Test
    public void capS14_hardLimitPlan() throws JSONException {
        long limit = SampleQueueModel.QUEUE_HARD_LIMIT_BYTES;
        long sample = 16L * 1024 * 1024; // 16 MiB 样本

        // 未超限：不删任何样本
        JSONArray ok = new JSONArray();
        ok.put(new JSONObject().put("sampleId", "20260901_000000_aa0001").put("rank", 0).put("bytes", sample));
        assertTrue(SampleQueueModel.janitorHardLimitPlan(ok, limit - 1, limit).isEmpty());

        // 超限 32 MiB：先删最老 failed（rank 0），删到 ≤ 上限为止（两个 rank0 都要删）
        JSONArray over = new JSONArray();
        over.put(new JSONObject().put("sampleId", "20260901_000000_aa0001").put("rank", 0).put("bytes", sample));
        over.put(new JSONObject().put("sampleId", "20260901_000000_aa0002").put("rank", 0).put("bytes", sample));
        over.put(new JSONObject().put("sampleId", "20260902_000000_aa0003").put("rank", 1).put("bytes", sample));
        Set<String> plan = SampleQueueModel.janitorHardLimitPlan(
                over, limit + 2 * sample, limit);
        assertEquals(2, plan.size());
        assertTrue(plan.contains("20260901_000000_aa0001"));
        assertTrue(plan.contains("20260901_000000_aa0002"));
        assertFalse(plan.contains("20260902_000000_aa0003"));

        // 超限 16 MiB：删一个最老 rank0 就够，rank1 不动
        JSONArray slight = new JSONArray();
        slight.put(new JSONObject().put("sampleId", "20260901_000000_aa0001").put("rank", 0).put("bytes", sample));
        slight.put(new JSONObject().put("sampleId", "20260901_000000_aa0002").put("rank", 0).put("bytes", sample));
        Set<String> plan0 = SampleQueueModel.janitorHardLimitPlan(
                slight, limit + sample, limit);
        assertEquals(1, plan0.size());
        assertTrue(plan0.contains("20260901_000000_aa0001"));

        // 全部 rank0 不够 → 才动 rank1（长期滞留 pending）
        JSONArray needRank1 = new JSONArray();
        needRank1.put(new JSONObject().put("sampleId", "20260901_000000_aa0001").put("rank", 0).put("bytes", sample));
        needRank1.put(new JSONObject().put("sampleId", "20260901_000000_aa0002").put("rank", 1).put("bytes", sample));
        Set<String> plan2 = SampleQueueModel.janitorHardLimitPlan(
                needRank1, limit + 2 * sample, limit);
        assertEquals(2, plan2.size());
        assertTrue(plan2.contains("20260901_000000_aa0001"));
        assertTrue(plan2.contains("20260901_000000_aa0002"));

        // 受保护样本（rank -1，如 active/新样本）绝不被硬限选中
        JSONArray onlyProtected = new JSONArray();
        onlyProtected.put(new JSONObject().put("sampleId", "20260925_000000_aa0009").put("rank", -1).put("bytes", sample));
        Set<String> plan3 = SampleQueueModel.janitorHardLimitPlan(
                onlyProtected, limit + sample, limit);
        assertTrue(plan3.isEmpty());
    }

    /* ---------- CAP-S16：24h 节流 ---------- */

    @Test
    public void capS16_janitorThrottle() {
        long now = 1_000_000_000L;
        // 从未跑过：立即执行
        assertTrue(SampleQueueModel.janitorDue(0L, now));
        assertTrue(SampleQueueModel.janitorDue(-5L, now));
        // 恰满 24h：执行；差 1ms：不执行
        assertTrue(SampleQueueModel.janitorDue(now - SampleQueueModel.JANITOR_MIN_INTERVAL_MS, now));
        assertFalse(SampleQueueModel.janitorDue(
                now - SampleQueueModel.JANITOR_MIN_INTERVAL_MS + 1, now));
    }
}
