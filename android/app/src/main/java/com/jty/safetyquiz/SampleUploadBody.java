package com.jty.safetyquiz;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;

/**
 * /api/sample JSON body 的流式构造（PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1）。
 * body 形如：
 * {"sampleId":"...","photoDataUrl":"data:image/jpeg;base64,<流式 base64>","manifest":{...}}
 * capture.jpg 以 3 字节对齐小块流式编码，内存占用恒定（不整包 base64）。
 * 纯 Java（无 Android 依赖），JVM 可测。
 */
public final class SampleUploadBody {

    private static final int CHUNK = 96 * 1024; // 3 的倍数

    private SampleUploadBody() {
    }

    public static byte[] prefix(String sampleId) {
        try {
            return ("{\"sampleId\":\"" + jsonEscape(sampleId)
                    + "\",\"photoDataUrl\":\"data:image/jpeg;base64,").getBytes("UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] suffix(String manifestJson) {
        try {
            // 闭合 photoDataUrl 的 JSON 字符串引号，再接 manifest（缺引号会导致非法 JSON）
            return ("\",\"manifest\":" + manifestJson + "}").getBytes("UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    public static long contentLength(long jpgLen, byte[] prefix, byte[] suffix) {
        return prefix.length + SampleBase64.encodedLength(jpgLen) + suffix.length;
    }

    /** 把完整 body 写入 out（调用方用 setFixedLengthStreamingMode(contentLength)）。 */
    public static void write(OutputStream out, String sampleId, byte[] jpg, String manifestJson)
            throws IOException {
        byte[] prefix = prefix(sampleId);
        byte[] suffix = suffix(manifestJson);
        out.write(prefix);
        int off = 0;
        while (off < jpg.length) {
            int len = Math.min(CHUNK, jpg.length - off);
            boolean isFinal = (off + len) >= jpg.length;
            out.write(SampleBase64.encodeBlock(jpg, off, len, isFinal));
            off += len;
        }
        out.write(suffix);
    }

    /** 构造完整 body（测试/小文件用；生产走流式 write）。 */
    public static byte[] build(String sampleId, byte[] jpg, String manifestJson) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(
                (int) Math.min(Integer.MAX_VALUE - 8, contentLength(jpg.length, prefix(sampleId), suffix(manifestJson))));
        write(bos, sampleId, jpg, manifestJson);
        return bos.toByteArray();
    }

    static String jsonEscape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }
}
