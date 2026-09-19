/* config.js —— 模拟考试结构配置（数量/分值）。改这里即可，无需动业务代码。
   手机端也可在 首页-模拟考试设置 中临时修改（保存在本机 localStorage）。 */
window.EXAM_CONFIG_DEFAULT = {
  single_count: 40,   /* 单选题数量 */
  multi_count: 15,    /* 多选题数量 */
  judge_count: 30,    /* 判断题数量 */
  single_score: 1,    /* 单选每题分值 */
  multi_score: 2,     /* 多选每题分值 */
  judge_score: 1      /* 判断每题分值 */
};
