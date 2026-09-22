/* gen_autocrop_fixture.js —— 生成 Native/JS 共享的自动框定位测试夹具。
 *
 * 用 www/js/core.js 当前的 suggestQuizCrop / pageQuestionNumber 对一组
 * 固定 OCR 行样本求值，写入 android/app/src/test/resources/autocrop_fixture.json。
 * Java 侧 QuizCropSuggester 的 JVM 测试读取同一份 fixture 断言等价输出；
 * test_core.js 也读取该 fixture 校验 JS 侧自身（防止两侧漂移）。
 *
 * 运行：node tools/gen_autocrop_fixture.js
 * 生成后请勿手工编辑 fixture 内容（仅可改本脚本再重新生成）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const MSQ = require(path.join(__dirname, "..", "www", "js", "core.js"));

function line(text, left, top, right, bottom) {
  return { text: text, left: left, top: top, right: right, bottom: bottom };
}

/* 无坐标行（模拟 normalizeOcrLines 的纯文本退化分支：JS 默认 bottom=top+40、right=left+200） */
function bareLine(text, left, top) {
  return { text: text, left: left, top: top };
}

function standardQuestion(n, y, stem) {
  return [
    line(n + ". " + stem, 200, y, 2300, y + 110),
    line("A. 甲", 260, y + 140, 1100, y + 250),
    line("B. 乙", 260, y + 280, 1100, y + 390),
    line("C. 丙", 260, y + 420, 1100, y + 530),
    line("D. 丁", 260, y + 560, 1100, y + 670)
  ];
}

const cases = [
  {
    name: "normal_multi_three_questions",
    width: 2480, height: 3500,
    lines: [].concat(
      [line("第 1 页 共 3 页", 1000, 40, 1480, 110)],
      standardQuestion(5, 200, "下列哪些选项符合营销现场作业安全规定"),
      standardQuestion(6, 950, "低压验电时需要注意的事项"),
      standardQuestion(7, 1700, "工作票签发人的安全职责包括"),
      [line("本页面由考试系统生成", 200, 3200, 1100, 3280)]
    )
  },
  {
    name: "single_question_with_options",
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(12, 400, "在停电的低压装置或设备上工作时应"),
      [line("第 2 页 共 3 页", 1000, 3300, 1480, 3370)]
    )
  },
  {
    name: "no_quiz_structure_plain_text",
    width: 2480, height: 3500,
    lines: [
      line("安全生产重于泰山", 300, 300, 1200, 420),
      line("人人讲安全 个个会应急", 300, 600, 1400, 720)
    ]
  },
  {
    name: "no_lines_empty",
    width: 2480, height: 3500,
    lines: []
  },
  {
    name: "misread_digit_shapes",
    /* OCR 把 31 识成 3l、32 识成 3Z：形近映射后仍是题号且连号成段 */
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(31, 200, "履带式起重设备现场作业的安全要求"),
      [line("3Z. 形近字母映射的下一题题干", 200, 950, 2300, 1060),
         line("A. 甲", 260, 1090, 1100, 1200),
         line("B. 乙", 260, 1230, 1100, 1340),
         line("C. 丙", 260, 1370, 1100, 1480),
         line("D. 丁", 260, 1510, 1100, 1620)]
    )
  },
  {
    name: "fullwidth_punct_and_bracket_numbers",
    width: 2480, height: 3500,
    lines: [].concat(
      [line("（1）填写工作票时应注意", 200, 200, 2200, 310),
         line("A、甲", 260, 340, 1100, 450),
         line("B、乙", 260, 480, 1100, 590),
         line("C、丙", 260, 620, 1100, 730),
         line("D、丁", 260, 760, 1100, 870)],
      [line("（2）工作许可制度的要求", 200, 1000, 2200, 1110),
         line("A、甲", 260, 1140, 1100, 1250),
         line("B、乙", 260, 1280, 1100, 1390),
         line("C、丙", 260, 1420, 1100, 1530),
         line("D、丁", 260, 1560, 1100, 1670)]
    )
  },
  {
    name: "left_nav_short_lines_do_not_widen",
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(9, 200, "倒闸操作应遵守的规定"),
      [line("9", 60, 200, 90, 260),      /* 左侧导航窄行：不得拉宽/拉偏左界 */
       line("10", 60, 500, 100, 560)]
    )
  },
  {
    name: "landscape_page",
    width: 4000, height: 3000,
    lines: [].concat(
      standardQuestion(21, 200, "高处作业的安全要求"),
      standardQuestion(22, 950, "脚手架搭设完成后的验收程序")
    )
  },
  {
    name: "tail_gap_beyond_limit_excluded",
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(3, 200, "第一道题的题干"),
      [line("距离很远页脚说明文字", 200, 3200, 1400, 3300)]  /* 间距远超 3.5 行高，不进主体 */
    )
  },
  {
    name: "distant_new_number_starts_new_run",
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(5, 200, "连续大段的第一题"),
      standardQuestion(6, 950, "连续大段的第二题"),
      standardQuestion(61, 2600, "页脚区域另一大段唯一题号")  /* 61-6>30 → 独立 run，1 项且选项≥4 勿混入 */
    )
  },
  {
    name: "degenerate_thin_structure",
    width: 4000, height: 4000,
    lines: [
      line("1. 窄", 3900, 100, 3960, 160),
      line("A. 甲", 3900, 200, 3960, 260),
      line("B. 乙", 3900, 300, 3960, 360),
      line("C. 丙", 3900, 400, 3960, 460),
      line("D. 丁", 3900, 500, 3960, 560)
    ]
  },
  {
    name: "bare_lines_without_coords",
    width: 2000, height: 3000,
    lines: [
      bareLine("1. 只有文字没有坐标", 100, 100),
      bareLine("A. 甲", 160, 240),
      bareLine("B. 乙", 160, 380),
      bareLine("C. 丙", 160, 520),
      bareLine("D. 丁", 160, 660)
    ]
  },
  {
    name: "ideographic_and_nbsp_spaces",
    width: 2480, height: 3500,
    lines: [].concat(
      standardQuestion(4, 200, "题干含全角空格\u3000的情况"),
      [line("\u00A0A. nbsp 开头的选项", 260, 890, 1100, 1000)]
    )
  }
];

const pageQuestionNumberCases = [
  { line: "31. 根据规定选择正确答案", expect: 31 },
  { line: "31．全角点号", expect: 31 },
  { line: "7、下列说法正确的是", expect: 7 },
  { line: "12) 括号形式", expect: 12 },
  { line: "（25）全角括号题号", expect: 25 },
  { line: "第 108 题 题干", expect: 108 },
  { line: "3l. 形近字母映射", expect: 31 },
  { line: "B. 停电", expect: null },
  { line: "多项选择题", expect: null },
  { line: "", expect: null },
  { line: "1000. 超范围题号", expect: null },
  { line: "0. 零号题", expect: null },
  { line: "5 题干以空格分隔", expect: 5 },
  { line: "\u30004、全角空格前缀", expect: 4 }
];

const fixture = {
  generator: "tools/gen_autocrop_fixture.js",
  note: "由 www/js/core.js 当前实现生成（node tools/gen_autocrop_fixture.js）；" +
    "Java QuizCropSuggester 的 JVM 测试按同一输入断言等价输出，勿手工编辑。",
  cases: cases.map(function (c) {
    var sug = MSQ.suggestQuizCrop(c.lines, c.width, c.height);
    return {
      name: c.name,
      width: c.width,
      height: c.height,
      lines: c.lines,
      expect: {
        crop: sug.crop ? {
          left: sug.crop.x, top: sug.crop.y,
          right: sug.crop.x + sug.crop.w, bottom: sug.crop.y + sug.crop.h
        } : null,
        confidence: sug.confidence,
        reason: sug.reason,
        anchors: sug.anchors
      }
    };
  }),
  pageQuestionNumberCases: pageQuestionNumberCases
};

const out = path.join(__dirname, "..", "android", "app", "src", "test", "resources", "autocrop_fixture.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log("fixture written: " + out);
console.log("cases: " + fixture.cases.length + ", pageQuestionNumberCases: " + pageQuestionNumberCases.length);
