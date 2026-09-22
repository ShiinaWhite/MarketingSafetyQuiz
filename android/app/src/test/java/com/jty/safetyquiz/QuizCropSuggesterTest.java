package com.jty.safetyquiz;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * suggestQuizCrop 的 Java 等价移植（QuizCropSuggester）与 JS 侧的共享 fixture 校验。
 * fixture 由 tools/gen_autocrop_fixture.js 用 www/js/core.js 当前实现生成；
 * 本测试断言：同一输入下 Java 输出与 fixture 期望完全一致（1e-9），
 * 从而保证原生自动框与既有 JS 算法行为等价（fixture 同时被 test_core.js 反向校验）。
 */
public class QuizCropSuggesterTest {

    private static final double DELTA = 1e-9;

    private static String readResource(String name) throws IOException {
        InputStream in = QuizCropSuggesterTest.class.getResourceAsStream("/" + name);
        assertNotNull("测试资源缺失: " + name, in);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String ln;
            while ((ln = reader.readLine()) != null) {
                sb.append(ln).append('\n');
            }
        }
        return sb.toString();
    }

    private static List<QuizCropSuggester.OcrLine> parseLines(JSONArray lines) throws JSONException {
        List<QuizCropSuggester.OcrLine> out = new ArrayList<>();
        for (int i = 0; i < lines.length(); i++) {
            JSONObject l = lines.getJSONObject(i);
            out.add(new QuizCropSuggester.OcrLine(
                    l.getString("text"),
                    l.has("top") && !l.isNull("top") ? l.getDouble("top") : null,
                    l.has("bottom") && !l.isNull("bottom") ? l.getDouble("bottom") : null,
                    l.has("left") && !l.isNull("left") ? l.getDouble("left") : null,
                    l.has("right") && !l.isNull("right") ? l.getDouble("right") : null));
        }
        return out;
    }

    @Test
    public void fixture_suggestQuizCrop_javaMatchesJsExpectations() throws IOException, JSONException {
        JSONObject fixture = new JSONObject(readResource("autocrop_fixture.json"));
        JSONArray cases = fixture.getJSONArray("cases");
        assertTrue("fixture 应包含用例", cases.length() >= 10);
        int tested = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            String name = c.getString("name");
            double width = c.getDouble("width");
            double height = c.getDouble("height");
            List<QuizCropSuggester.OcrLine> lines = parseLines(c.getJSONArray("lines"));

            QuizCropSuggester.SuggestResult r =
                    QuizCropSuggester.suggestQuizCrop(lines, width, height);

            JSONObject expect = c.getJSONObject("expect");
            if (expect.isNull("crop")) {
                assertNull(name + ": crop 应为 null（reason=" + r.reason + "）", r.crop);
            } else {
                assertNotNull(name + ": crop 不应为 null", r.crop);
                JSONObject crop = expect.getJSONObject("crop");
                assertEquals(name + ".left", crop.getDouble("left"), r.crop[0], DELTA);
                assertEquals(name + ".top", crop.getDouble("top"), r.crop[1], DELTA);
                assertEquals(name + ".right", crop.getDouble("right"), r.crop[2], DELTA);
                assertEquals(name + ".bottom", crop.getDouble("bottom"), r.crop[3], DELTA);
            }
            assertEquals(name + ".confidence", expect.getString("confidence"), r.confidence);
            assertEquals(name + ".reason", expect.getString("reason"), r.reason);
            assertEquals(name + ".questionNumbers",
                    expect.getJSONObject("anchors").getInt("questionNumbers"), r.questionNumbers);
            assertEquals(name + ".optionLines",
                    expect.getJSONObject("anchors").getInt("optionLines"), r.optionLines);
            tested++;
        }
        assertEquals("应覆盖 13 个 suggest 用例", 13, tested);
    }

    @Test
    public void fixture_pageQuestionNumber_javaMatchesJs() throws IOException, JSONException {
        JSONObject fixture = new JSONObject(readResource("autocrop_fixture.json"));
        JSONArray cases = fixture.getJSONArray("pageQuestionNumberCases");
        int tested = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            String line = c.getString("line");
            Integer expected = c.isNull("expect") ? null : c.getInt("expect");
            Integer got = QuizCropSuggester.pageQuestionNumber(line);
            if (expected == null) {
                assertNull("qnum[" + line + "] 应为 null", got);
            } else {
                assertNotNull("qnum[" + line + "] 不应为 null", got);
                assertEquals("qnum[" + line + "]", expected.intValue(), got.intValue());
            }
            tested++;
        }
        assertEquals("应覆盖 14 个题号用例", 14, tested);
    }

    @Test
    public void jsTrim_semantics_matchJsWhitespace() {
        assertEquals("4、题", QuizCropSuggester.jsTrim("\u30004、题\u00A0"));
        assertEquals("", QuizCropSuggester.jsTrim("\u2002\u2002"));
        assertEquals("A. 甲", QuizCropSuggester.jsTrim(" A. 甲\u2028"));
    }

    @Test
    public void isPageOptionLine_variants() {
        assertTrue(QuizCropSuggester.isPageOptionLine("A. 甲"));
        assertTrue(QuizCropSuggester.isPageOptionLine("B、乙"));
        assertTrue(QuizCropSuggester.isPageOptionLine("（C）. 丙"));
        assertTrue(QuizCropSuggester.isPageOptionLine("\u00A0D. nbsp 前缀"));
        assertFalse(QuizCropSuggester.isPageOptionLine("12. 题号不是选项"));
        assertFalse(QuizCropSuggester.isPageOptionLine("A这是一个没有标点的行"));
        // 与 JS 一致：括号后无点号分隔不算选项行
        assertFalse(QuizCropSuggester.isPageOptionLine("（C）丙"));
    }
}
