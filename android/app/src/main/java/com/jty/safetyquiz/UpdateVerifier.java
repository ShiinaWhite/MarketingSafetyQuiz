package com.jty.safetyquiz;

import java.util.Locale;
import java.util.Set;

/**
 * SELF_UPDATE_V1 校验纯逻辑（无 Android 依赖，JVM 单测直接覆盖）。
 * 只做"给定期望值与实际值是否一致"的判定，不做任何 IO。
 */
public final class UpdateVerifier {

    /** 更新包体积上限：超过即拒绝（防异常服务器打爆存储）。 */
    public static final long MAX_APK_BYTES = 150L * 1024 * 1024;

    private UpdateVerifier() {
    }

    /** 字节 → 小写 hex。 */
    public static String sha256Hex(byte[] digest) {
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format(Locale.US, "%02x", b));
        }
        return sb.toString();
    }

    /** 期望/实际 SHA-256 比对：两侧都必须是 64 位 hex 且忽略大小写相等。 */
    public static boolean sha256Matches(String expectedHex, String actualHex) {
        return isSha256Hex(expectedHex) && isSha256Hex(actualHex)
                && expectedHex.toLowerCase(Locale.US).equals(actualHex.toLowerCase(Locale.US));
    }

    public static boolean isSha256Hex(String s) {
        if (s == null || s.length() != 64) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /** Content-Length 未知（null/-1）时放行，由流式上限兜底；已知则不得超过上限。 */
    public static boolean contentLengthAcceptable(Long contentLength, long maxBytes) {
        if (contentLength == null || contentLength < 0) {
            return true;
        }
        return contentLength <= maxBytes;
    }

    public static boolean packageMatches(String expectedPackageName, String archivePackageName) {
        return expectedPackageName != null && expectedPackageName.equals(archivePackageName);
    }

    /**
     * 更新 versionCode 判定：APK 内实际 versionCode 必须等于 manifest 声明值，
     * 且严格大于当前已安装值（禁止降级与错版安装）。
     */
    public static boolean updateVersionCodeAcceptable(long manifestVersionCode,
                                                      long archiveVersionCode,
                                                      long installedVersionCode) {
        return archiveVersionCode == manifestVersionCode && archiveVersionCode > installedVersionCode;
    }

    /** 签名证书 digest 集合交集非空即认为同签名（单签名场景两侧各恰一个元素）。 */
    public static boolean sameSignerSha256(Set<String> currentDigests, Set<String> archiveDigests) {
        if (currentDigests == null || archiveDigests == null
                || currentDigests.isEmpty() || archiveDigests.isEmpty()) {
            return false;
        }
        for (String d : archiveDigests) {
            if (d != null && currentDigests.contains(d.toLowerCase(Locale.US))) {
                return true;
            }
        }
        return false;
    }
}
