package com.jty.safetyquiz;

/**
 * 流式 Base64 编码纯逻辑（PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1）。
 * 用于把 capture.jpg 以固定小块流式编码进 HTTP body，避免 50MB 级整包
 * base64 一次性占用内存；分块长度必须是 3 的倍数（除最后一块）。
 * 自带实现保证全 API 级别可用且 JVM 可测。
 */
public final class SampleBase64 {

    private static final char[] ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private SampleBase64() {
    }

    /** rawLen 字节编码后的字符数（含 padding）。 */
    public static int encodedLength(long rawLen) {
        return (int) (((rawLen + 2) / 3) * 4);
    }

    /**
     * 编码 src 的 [offset, offset+len)。
     * isFinal=false 时 len 必须是 3 的倍数且输出不带 padding；
     * isFinal=true 时按余数补 '='。
     */
    public static byte[] encodeBlock(byte[] src, int offset, int len, boolean isFinal) {
        int groups = len / 3;
        int rem = len - groups * 3;
        int outLen = groups * 4 + (isFinal ? (rem == 0 ? 0 : (rem == 1 ? 4 : 4)) : 0);
        // 非 final 块 rem 恒为 0（调用方保证 3 的倍数）
        byte[] out = new byte[outLen];
        int o = 0;
        int i = offset;
        final int end = offset + groups * 3;
        for (; i < end; i += 3) {
            int v = ((src[i] & 0xFF) << 16) | ((src[i + 1] & 0xFF) << 8) | (src[i + 2] & 0xFF);
            out[o++] = (byte) ALPHABET[(v >> 18) & 0x3F];
            out[o++] = (byte) ALPHABET[(v >> 12) & 0x3F];
            out[o++] = (byte) ALPHABET[(v >> 6) & 0x3F];
            out[o++] = (byte) ALPHABET[v & 0x3F];
        }
        if (isFinal && rem > 0) {
            int b0 = src[i++] & 0xFF;
            int b1 = rem > 1 ? (src[i++] & 0xFF) : 0;
            int v = (b0 << 16) | (b1 << 8);
            out[o++] = (byte) ALPHABET[(v >> 18) & 0x3F];
            out[o++] = (byte) ALPHABET[(v >> 12) & 0x3F];
            out[o++] = (byte) (rem > 1 ? ALPHABET[(v >> 6) & 0x3F] : '=');
            out[o++] = '=';
        }
        return out;
    }
}
