package com.jty.safetyquiz;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 自动题目区域定位（suggestQuizCrop 的 Java 等价移植，算法与 www/js/core.js 保持一致）：
 * 锚点 = 行首题号 + 选项行；题号按行序聚成“递增连续段”取最大段；
 * 段内行 + 段尾之后连续的普通文本行算主体；水平范围取锚点行最小 left，
 * 主体行最大 right，四周加 padding。输入 OCR 行（布局图坐标）+ 图像宽高，
 * 输出 0~1 归一化 crop（left/top/right/bottom，相对整张照片）。
 *
 * 等价性由共享 fixture 保证：tools/gen_autocrop_fixture.js 用当前 JS 实现生成
 * 期望输出，本类与 JS 对同一输入必须给出一致结果（androidTest 之外的 JVM 单测）。
 */
public final class QuizCropSuggester {

    private QuizCropSuggester() { }

    /**
     * OCR 行输入（ML Kit Line 的 text + boundingBox）。
     * bottom/right 允许为 null（缺省分支与 JS `l.bottom == null ? … + 40/200` 一致）。
     */
    public static final class OcrLine {
        public final String text;
        public final Double top;
        public final Double bottom;
        public final Double left;
        public final Double right;

        public OcrLine(String text, Double top, Double bottom, Double left, Double right) {
            this.text = text;
            this.top = top;
            this.bottom = bottom;
            this.left = left;
            this.right = right;
        }
    }

    /** 建议结果，字段语义与 JS suggestQuizCrop 返回值一致。 */
    public static final class SuggestResult {
        /** 归一化 left/top/right/bottom；无可靠结构时为 null（调用方保持默认框）。 */
        public final double[] crop;
        public final String confidence;
        public final int questionNumbers;
        public final int optionLines;
        public final String reason;

        SuggestResult(double[] crop, String confidence, int questionNumbers,
                      int optionLines, String reason) {
            this.crop = crop;
            this.confidence = confidence;
            this.questionNumbers = questionNumbers;
            this.optionLines = optionLines;
            this.reason = reason;
        }
    }

    private static final double DEFAULT_LINE_HEIGHT = 40;
    private static final double DEFAULT_LINE_WIDTH = 200;
    private static final double MIN_CROP = 0.05;

    /** JS \s 的精确等价类（Java \s 不含 \u00A0/\u3000 等，必须显式展开）。 */
    private static final String WS =
            "[\\t\\n\\u000B\\f\\r\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
    private static final String NWS = "[^\\t\\n\\u000B\\f\\r\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";

    /** 题号数字位允许的 OCR 形近字母（与 JS PAGE_NUM_CHARS 一致）。 */
    private static final String NUM_CHARS = "0-9OoQlIiSsABZG";

    private static final Pattern[] QNUM_PATTERNS = {
            Pattern.compile("^[（(]" + WS + "*([" + NUM_CHARS + "]{1,3})" + WS + "*[)）]" + WS + "*"),
            Pattern.compile("^第" + WS + "*([" + NUM_CHARS + "]{1,3})" + WS + "*题" + WS + "*[.．、:：]?" + WS + "*"),
            Pattern.compile("^([" + NUM_CHARS + "]{1,3})" + WS + "*[.．、,，:：)）]" + WS + "*(?!\\d)"),
            Pattern.compile("^([" + NUM_CHARS + "]{1,3})" + WS + "+(?=[\\u4e00-\\u9fa5])")
    };

    private static final Pattern OPTION_LINE =
            Pattern.compile("^[（(【\\[]?" + WS + "*[A-Fa-f]" + WS + "*[)）】\\]]?" + WS + "*[.、．:：]" + WS + "*" + NWS);

    private static final Pattern HAS_DIGIT = Pattern.compile("\\d");
    private static final Pattern ALL_DIGITS = Pattern.compile("^\\d+$");

    /** JS 题号形近字母映射（PAGE_NUM_MAP）。 */
    private static String mapNumChar(char c) {
        switch (c) {
            case 'O': case 'o': case 'Q': return "0";
            case 'l': case 'I': case 'i': return "1";
            case 'S': case 's': return "5";
            case 'B': return "8";
            case 'A': return "4";
            case 'Z': return "2";
            case 'G': return "6";
            default: return String.valueOf(c);
        }
    }

    /** JS String.prototype.trim 的精确等价（Java trim 只处理 ≤ U+0020）。 */
    public static String jsTrim(String s) {
        if (s == null) { return ""; }
        int st = 0;
        int len = s.length();
        int end = len;
        while (st < len && isJsWhitespace(s.charAt(st))) { st++; }
        while (end > st && isJsWhitespace(s.charAt(end - 1))) { end--; }
        return st > 0 || end < len ? s.substring(st, end) : s;
    }

    private static boolean isJsWhitespace(char c) {
        switch (c) {
            case '\t': case '\n': case '\u000B': case '\f': case '\r':
            case ' ': case '\u00A0': case '\u1680': case '\u2028': case '\u2029':
            case '\u202F': case '\u205F': case '\u3000': case '\uFEFF':
                return true;
            default:
                return c >= '\u2000' && c <= '\u200A';
        }
    }

    /** 题号值：至少含一个真数字；形近字母映射后必须全为数字；范围 1~999。 */
    public static Integer pageNumberValue(String token) {
        if (!HAS_DIGIT.matcher(token).find()) { return null; }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < token.length(); i++) {
            sb.append(mapNumChar(token.charAt(i)));
        }
        if (!ALL_DIGITS.matcher(sb).matches()) { return null; }
        int n = Integer.parseInt(sb.toString());
        return (n >= 1 && n <= 999) ? n : null;
    }

    /** 行首题号识别：1. / 1．/ 1、/ 1) / （1）/ 第1题 / "31 题干"。返回题号数字或 null。 */
    public static Integer pageQuestionNumber(String line) {
        String s = jsTrim(line == null ? "" : line);
        if (s.isEmpty()) { return null; }
        for (Pattern p : QNUM_PATTERNS) {
            Matcher m = p.matcher(s);
            if (!m.find()) { continue; }
            Integer n = pageNumberValue(m.group(1));
            if (n == null) { continue; }
            return n;
        }
        return null;
    }

    /** 选项行：A. / A、/ （A）/ A．/ A: 开头。 */
    public static boolean isPageOptionLine(String text) {
        return OPTION_LINE.matcher(jsTrim(text == null ? "" : text)).find();
    }

    private static final class Anchor {
        final int index;
        final int number;
        final OcrLine line;

        Anchor(int index, int number, OcrLine line) {
            this.index = index;
            this.number = number;
            this.line = line;
        }
    }

    private static final class Run {
        int lastN;
        final List<Anchor> items = new ArrayList<>();
    }

    /**
     * 与 JS suggestQuizCrop 一致的自动框定位。crop 为 {left, top, right, bottom}
     * 归一化（相对 imageWidth×imageHeight 全图）；找不到可靠结构时 crop = null。
     */
    public static SuggestResult suggestQuizCrop(List<OcrLine> lines, double imageWidth, double imageHeight) {
        double[] cropOut = null;
        String confidence = "none";
        int qnCount = 0;
        int optCount = 0;
        String reason = "no_lines";
        if (imageWidth > 0 && imageHeight > 0 && lines != null && !lines.isEmpty()) {
            List<OcrLine> l = new ArrayList<>();
            for (OcrLine in : lines) {
                String t = jsTrim(in.text == null ? "" : in.text);
                if (t.isEmpty()) { continue; }
                double top = in.top == null ? 0 : in.top;
                double left = in.left == null ? 0 : in.left;
                double bottom = in.bottom == null ? top + DEFAULT_LINE_HEIGHT : in.bottom;
                double right = in.right == null ? left + DEFAULT_LINE_WIDTH : in.right;
                l.add(new OcrLine(t, top, bottom, left, right));
            }
            if (!l.isEmpty()) {
                reason = "no_quiz_structure";
                Collections.sort(l, new Comparator<OcrLine>() {
                    @Override
                    public int compare(OcrLine a, OcrLine b) {
                        return a.top != b.top ? Double.compare(a.top, b.top)
                                : Double.compare(a.left, b.left);
                    }
                });

                List<Double> heights = new ArrayList<>();
                for (OcrLine line : l) {
                    heights.add(Math.max(1, line.bottom - line.top));
                }
                Collections.sort(heights);
                double lineH = heights.isEmpty()
                        ? DEFAULT_LINE_HEIGHT
                        : heights.get((int) Math.floor(heights.size() / 2.0));

                List<Anchor> qAnchors = new ArrayList<>();
                for (int i = 0; i < l.size(); i++) {
                    OcrLine line = l.get(i);
                    Integer qn = pageQuestionNumber(line.text);
                    if (qn != null) { qAnchors.add(new Anchor(i, qn, line)); }
                    if (isPageOptionLine(line.text)) { optCount++; }
                }
                qnCount = qAnchors.size();

                List<Run> runs = new ArrayList<>();
                for (Anchor q : qAnchors) {
                    Run cur = runs.isEmpty() ? null : runs.get(runs.size() - 1);
                    if (cur != null && q.number > cur.lastN && q.number - cur.lastN <= 30) {
                        cur.items.add(q);
                        cur.lastN = q.number;
                    } else {
                        Run r = new Run();
                        r.lastN = q.number;
                        r.items.add(q);
                        runs.add(r);
                    }
                }
                Collections.sort(runs, new Comparator<Run>() {
                    @Override
                    public int compare(Run a, Run b) {
                        if (b.items.size() != a.items.size()) {
                            return Integer.compare(b.items.size(), a.items.size());
                        }
                        long da = (long) b.lastN - b.items.get(0).number;
                        long db = (long) a.lastN - a.items.get(0).number;
                        return Long.compare(db, da);
                    }
                });
                Run best = runs.isEmpty() ? null : runs.get(0);
                boolean enough = (best != null && best.items.size() >= 2)
                        || (qAnchors.size() == 1 && optCount >= 4);
                if (best != null && enough) {
                    int firstIdx = best.items.get(0).index;
                    Anchor lastAnchor = best.items.get(best.items.size() - 1);
                    double bottomPx = lastAnchor.line.bottom;
                    double prevBottom = bottomPx;
                    int endIdx = lastAnchor.index;
                    double gapLimit = lineH * 3.5;
                    for (int i = lastAnchor.index + 1; i < l.size(); i++) {
                        OcrLine line = l.get(i);
                        if (line.top - prevBottom > gapLimit) { break; }
                        if (pageQuestionNumber(line.text) != null) { break; }
                        endIdx = i;
                        bottomPx = Math.max(bottomPx, line.bottom);
                        prevBottom = line.bottom;
                    }
                    double minLeft = imageWidth;
                    double maxRight = 0;
                    for (Anchor q : best.items) {
                        minLeft = Math.min(minLeft, q.line.left);
                        maxRight = Math.max(maxRight, q.line.right);
                    }
                    for (int k = firstIdx; k <= endIdx; k++) {
                        maxRight = Math.max(maxRight, l.get(k).right);
                    }
                    double padY = lineH * 1.5;
                    double padX = lineH * 0.5;
                    double x0 = Math.max(0, minLeft - padX);
                    double x1 = Math.min(imageWidth, maxRight + padX);
                    double y0 = Math.max(0, best.items.get(0).line.top - padY);
                    double y1 = Math.min(imageHeight, bottomPx + padY);
                    double cw = Math.min(Math.max((x1 - x0) / imageWidth, MIN_CROP), 1);
                    double ch = Math.min(Math.max((y1 - y0) / imageHeight, MIN_CROP), 1);
                    double cx = Math.min(Math.max(x0 / imageWidth, 0), 1 - cw);
                    double cy = Math.min(Math.max(y0 / imageHeight, 0), 1 - ch);
                    if (cw <= MIN_CROP || ch <= MIN_CROP) {
                        reason = "degenerate_crop";
                    } else {
                        cropOut = new double[]{cx, cy, cx + cw, cy + ch};
                        confidence = "strong";
                        reason = best.items.size() >= 2 ? "ok" : "ok_single_question";
                    }
                }
            }
        }
        return new SuggestResult(cropOut, confidence, qnCount, optCount, reason);
    }
}
