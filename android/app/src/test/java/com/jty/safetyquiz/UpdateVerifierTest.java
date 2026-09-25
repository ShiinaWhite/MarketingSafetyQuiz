package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;

import org.junit.Test;

/** UpdateVerifier 纯逻辑 JVM 单测（SELF_UPDATE_V1）。 */
public class UpdateVerifierTest {

    private static final String SHA_A =
            "c5f8965a5c6a3f86bde2ee50d71ebc22b2bade0650e1174bbc3572a11d959abb";
    private static final String SHA_B =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    public void sha256Matches_acceptsCaseInsensitiveEqualHex() {
        assertTrue(UpdateVerifier.sha256Matches(SHA_A, SHA_A.toUpperCase()));
    }

    @Test
    public void sha256Matches_rejectsDifferent() {
        assertFalse(UpdateVerifier.sha256Matches(SHA_A, SHA_B));
    }

    @Test
    public void sha256Matches_rejectsMalformed() {
        assertFalse(UpdateVerifier.sha256Matches(null, SHA_A));
        assertFalse(UpdateVerifier.sha256Matches(SHA_A, null));
        assertFalse(UpdateVerifier.sha256Matches("xyz", SHA_A));
        assertFalse(UpdateVerifier.sha256Matches(SHA_A.substring(1), SHA_A));
        assertFalse(UpdateVerifier.sha256Matches(SHA_A + "!", SHA_A));
    }

    @Test
    public void isSha256Hex_validatesLengthAndCharset() {
        assertTrue(UpdateVerifier.isSha256Hex(SHA_A));
        assertFalse(UpdateVerifier.isSha256Hex(""));
        assertFalse(UpdateVerifier.isSha256Hex(SHA_A.substring(0, 63)));
        assertFalse(UpdateVerifier.isSha256Hex(SHA_A.replace('a', 'g')));
    }

    @Test
    public void contentLengthAcceptable_unknownPasses_knownCapped() {
        assertTrue(UpdateVerifier.contentLengthAcceptable(null, UpdateVerifier.MAX_APK_BYTES));
        assertTrue(UpdateVerifier.contentLengthAcceptable(-1L, UpdateVerifier.MAX_APK_BYTES));
        assertTrue(UpdateVerifier.contentLengthAcceptable(UpdateVerifier.MAX_APK_BYTES,
                UpdateVerifier.MAX_APK_BYTES));
        assertFalse(UpdateVerifier.contentLengthAcceptable(UpdateVerifier.MAX_APK_BYTES + 1,
                UpdateVerifier.MAX_APK_BYTES));
    }

    @Test
    public void packageMatches_exactOnly() {
        assertTrue(UpdateVerifier.packageMatches("com.jty.safetyquiz.dev", "com.jty.safetyquiz.dev"));
        assertFalse(UpdateVerifier.packageMatches("com.jty.safetyquiz.dev", "com.jty.safetyquiz"));
        assertFalse(UpdateVerifier.packageMatches("com.jty.safetyquiz.dev", null));
        assertFalse(UpdateVerifier.packageMatches(null, "com.jty.safetyquiz.dev"));
    }

    @Test
    public void updateVersionCode_equalManifestAndStrictlyNewer() {
        assertTrue(UpdateVerifier.updateVersionCodeAcceptable(3, 3, 2));
        assertFalse(UpdateVerifier.updateVersionCodeAcceptable(3, 2, 2));   // manifest 与 APK 不符
        assertFalse(UpdateVerifier.updateVersionCodeAcceptable(3, 3, 3));   // 同版本不允许重装
        assertFalse(UpdateVerifier.updateVersionCodeAcceptable(2, 2, 3));   // 降级拒绝
        assertFalse(UpdateVerifier.updateVersionCodeAcceptable(3, 4, 2));   // APK 版本超出 manifest
    }

    @Test
    public void sameSignerSha256_intersectNonEmpty() {
        Set<String> current = new HashSet<String>();
        current.add(SHA_A);
        Set<String> archive = new HashSet<String>();
        archive.add(SHA_A.toUpperCase());   // 大小写不敏感
        assertTrue(UpdateVerifier.sameSignerSha256(current, archive));

        Set<String> other = new HashSet<String>();
        other.add(SHA_B);
        assertFalse(UpdateVerifier.sameSignerSha256(current, other));
        assertFalse(UpdateVerifier.sameSignerSha256(current, new HashSet<String>()));
        assertFalse(UpdateVerifier.sameSignerSha256(new HashSet<String>(), archive));
        assertFalse(UpdateVerifier.sameSignerSha256(null, archive));
    }

    @Test
    public void sha256Hex_encoding() {
        assertEquals("ab", UpdateVerifier.sha256Hex(new byte[]{(byte) 0xab}));
        assertEquals("00ff10", UpdateVerifier.sha256Hex(new byte[]{0, (byte) 0xff, 0x10}));
    }

    @Test
    public void updateFileName_versionedPerVersionCode() {
        assertEquals("update-vc4.apk", UpdateVerifier.updateFileName(4));
        assertEquals("update-vc5.apk", UpdateVerifier.updateFileName(5));
        // 不同 versionCode → 不同文件名：旧包残留不可能被新版本的安装路径复用
        assertFalse(UpdateVerifier.updateFileName(4).equals(UpdateVerifier.updateFileName(5)));
    }

    /* ================= APK_DELIVERY_COS_CDN_VC13_V1：expectedSize 多态解析 ================= */

    @Test
    public void flexibleLong_integerTrapCovered() {
        /* #11 Integer：getLong 对 JSON Integer 返回 null（历史陷阱），
           doubleView（getDouble）必须可靠兜住 */
        assertNull(UpdateVerifier.flexibleLong(null, null, null));
        assertEquals(Long.valueOf(17221414L),
                UpdateVerifier.flexibleLong(null, Double.valueOf(17221414d), null));
        assertEquals(Long.valueOf(1L),
                UpdateVerifier.flexibleLong(null, Double.valueOf(1d), null));
        /* #12 Long / 大数值：Long.MAX 内合法；超过 2^53 的 double 拒绝（宁可无值） */
        assertEquals(Long.valueOf(150L * 1024 * 1024),
                UpdateVerifier.flexibleLong(150L * 1024 * 1024, null, null));
        assertEquals(Long.valueOf(9007199254740992L),
                UpdateVerifier.flexibleLong(null, Double.valueOf(9007199254740992d), null));
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(9.1e18), null));
        /* #13 边界与畸形：0/负数/非整数 double/非整数字符串 → null（宁可无值，不可错值） */
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(0d), null));
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(-5d), null));
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(17.5d), null));
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(Double.NaN), null));
        assertNull(UpdateVerifier.flexibleLong(null, Double.valueOf(Double.POSITIVE_INFINITY), null));
        assertEquals(Long.valueOf(42L), UpdateVerifier.flexibleLong(null, null, " 42 "));
        assertNull(UpdateVerifier.flexibleLong(null, null, "17.5"));
        assertNull(UpdateVerifier.flexibleLong(null, null, "abc"));
        assertNull(UpdateVerifier.flexibleLong(null, null, ""));
        /* longView 优先：视图间不一致时以 getLong 为准（不猜） */
        assertEquals(Long.valueOf(7L), UpdateVerifier.flexibleLong(7L, Double.valueOf(9d), "11"));
    }
}
