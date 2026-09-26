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

    /**
     * PluginCall 数值多态解析（APK_DELIVERY_COS_CDN_VC13_V1，修复 expectedSize
     * 历史陷阱：JSON number 被解码为 Integer 时 PluginCall.getLong 返回 null，
     * 精确 size 比对曾被静默跳过）。
     * 调用方把 getLong/getDouble/getString 三个视图都传入，本方法返回第一个
     * 可靠的整数值；无法可靠解析时返回 null（调用方按「无期望值」处理，
     * 由 SHA256 全文件校验兜底）。边界：负数、非整数 double、2^53 以上、
     * 非纯整数字符串一律 null（宁可无值，不可错值）。
     */
    public static Long flexibleLong(Long longView, Double doubleView, String stringView) {
        if (longView != null) {
            return longView;
        }
        if (doubleView != null && Double.isFinite(doubleView)
                && doubleView >= 1d && doubleView == Math.floor(doubleView)
                && doubleView <= 9.007199254740992E15) {
            return doubleView.longValue();
        }
        if (stringView != null) {
            try {
                return Long.parseLong(stringView.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    /**
     * 版本化下载文件名（REAL_SAMPLE_FEEDBACK 排查引入）：每个 versionCode 独立文件，
     * 杜绝固定 update.apk 的旧包残留被安装路径复用。
     */
    public static String updateFileName(long versionCode) {
        return "update-vc" + versionCode + ".apk";
    }
}
