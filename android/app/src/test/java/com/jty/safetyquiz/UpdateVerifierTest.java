package com.jty.safetyquiz;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
}
