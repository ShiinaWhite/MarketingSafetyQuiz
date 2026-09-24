package com.jty.safetyquiz;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** 流式上传 body 构造与分块 base64 纯逻辑 JVM 单测。 */
public class SampleUploadBodyTest {

    @Test
    public void base64_knownVectors() {
        assertArrayEquals("+/+/" .getBytes(StandardCharsets.US_ASCII),
                SampleBase64.encodeBlock(new byte[]{(byte) 0xFB, (byte) 0xFF, (byte) 0xBF}, 0, 3, true));
        assertArrayEquals("AA==".getBytes(StandardCharsets.US_ASCII),
                SampleBase64.encodeBlock(new byte[]{0}, 0, 1, true));
        assertArrayEquals("AAA=".getBytes(StandardCharsets.US_ASCII),
                SampleBase64.encodeBlock(new byte[]{0, 0}, 0, 2, true));
        assertArrayEquals("AAAA".getBytes(StandardCharsets.US_ASCII),
                SampleBase64.encodeBlock(new byte[]{0, 0, 0}, 0, 3, true));
    }

    @Test
    public void base64_blockBoundaries_matchStreamChunking() {
        // 分块（96KB=3 的倍数）与一次性编码结果必须一致：块间无 padding 混入
        byte[] jpg = new byte[96 * 1024 * 2 + 5];   // 2 个完整块 + 余 5 字节
        for (int i = 0; i < jpg.length; i++) { jpg[i] = (byte) (i * 7); }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int off = 0;
        while (off < jpg.length) {
            int len = Math.min(96 * 1024, jpg.length - off);
            boolean isFinal = (off + len) >= jpg.length;
            bos.writeBytes(SampleBase64.encodeBlock(jpg, off, len, isFinal));
            off += len;
        }
        byte[] whole = SampleBase64.encodeBlock(jpg, 0, jpg.length, true);
        assertArrayEquals(whole, bos.toByteArray());
        assertEquals(SampleBase64.encodedLength(jpg.length), whole.length);
    }

    @Test
    public void uploadBody_validJsonAndExactPayload() throws Exception {
        byte[] jpg = new byte[]{1, 2, 3, 4, 5};
        String manifest = "{\"schemaVersion\":1,\"sampleId\":\"X\",\"notes\":\"引\\\"号\"}";
        byte[] body = SampleUploadBody.build("20260924_130000_ca11ca", jpg, manifest);

        JSONObject parsed = new JSONObject(new String(body, StandardCharsets.UTF_8));
        assertEquals("20260924_130000_ca11ca", parsed.getString("sampleId"));
        assertEquals(true, parsed.getString("photoDataUrl").startsWith("data:image/jpeg;base64,"));
        assertEquals(1, parsed.getJSONObject("manifest").getInt("schemaVersion"));
        assertEquals("X", parsed.getJSONObject("manifest").getString("sampleId"));
        assertEquals("引\"号", parsed.getJSONObject("manifest").getString("notes"));

        String b64 = parsed.getString("photoDataUrl").substring("data:image/jpeg;base64,".length());
        // 解回必须等于原始字节（解码用 JDK 标准实现交叉验证编码器）
        byte[] decoded = java.util.Base64.getDecoder().decode(b64);
        assertArrayEquals(jpg, decoded);
    }

    @Test
    public void uploadBody_contentLengthMatchesWritten() throws Exception {
        byte[] jpg = new byte[5000];
        byte[] body = SampleUploadBody.build("20260924_130000_cb22cb", jpg, "{}");
        assertEquals(body.length, SampleUploadBody.contentLength(jpg.length,
                SampleUploadBody.prefix("20260924_130000_cb22cb"), SampleUploadBody.suffix("{}")));
        assertTrue(SampleUploadBody.contentLength(jpg.length,
                SampleUploadBody.prefix("x"), SampleUploadBody.suffix("{}")) > jpg.length);
    }
}
