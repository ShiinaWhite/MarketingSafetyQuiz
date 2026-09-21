/* app.js —— 营销安规刷题 Web 版界面与本地存储（完全离线） */
(function () {
  "use strict";

  var MSQ = window.MSQ;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 本地存储（localStorage） ---------------- */
  var Store = {
    KEY: "msq.progress.v1",
    fresh: function () {
      return { version: 1, stats: {}, wrong: [], positions: {}, orders: {}, examCfg: null };
    },
    data: null,
    load: function () {
      var d = this.fresh();
      try {
        var raw = localStorage.getItem(this.KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            for (var k in d) { if (parsed[k] !== undefined) { d[k] = parsed[k]; } }
          }
        }
      } catch (e) { /* 损坏时按全新记录开始 */ }
      this.data = d;
    },
    save: function () {
      try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) { }
    },
    statOf: function (qid) {
      return this.data.stats[String(qid)] || { a: 0, c: 0, w: 0 };
    },
    _apply: function (qid, correct) {
      var k = String(qid);
      var s = this.data.stats[k] || (this.data.stats[k] = { a: 0, c: 0, w: 0 });
      s.a++; if (correct) { s.c++; } else { s.w++; }
      var w = this.data.wrong;
      if (correct) {
        var i = w.indexOf(k);
        if (i >= 0) { w.splice(i, 1); }        // 答对自动移出错题本
      } else if (w.indexOf(k) < 0) {
        w.push(k);
      }
    },
    record: function (qid, correct) { this._apply(qid, correct); this.save(); },
    recordMany: function (pairs) {
      for (var i = 0; i < pairs.length; i++) { this._apply(pairs[i][0], pairs[i][1]); }
      this.save();
    },
    totals: function () {
      var a = 0, c = 0;
      for (var k in this.data.stats) { a += this.data.stats[k].a; c += this.data.stats[k].c; }
      return { a: a, c: c };
    },
    clear: function () { this.data = this.fresh(); this.save(); }
  };

  /* ---------------- 全局状态 ---------------- */
  var bank = null, byType = null;
  var P = null;   // 刷题会话 {mode, list, pos, session:{qid:{sel:Set,submitted,correct}}}
  var E = null;   // 模拟考试 {paper, answers:{qid:Set}, pos, result}
  var curExplain = null;     // 当前题目的解析对象（null = 无解析或未显示）
  var explainOpen = false;   // 解析区展开状态；每切换一题在 renderQuestion 中重置
  var MODE_TITLES = {
    seq: "顺序刷题", rand: "随机刷题", single: "单选专项", multi: "多选专项",
    judge: "判断专项", wrong: "错题重做", recite: "背题模式", exam: "模拟考试"
  };

  function examConfig() {
    var cfg = MSQ.normalizeConfig(Object.assign(
      {}, window.EXAM_CONFIG_DEFAULT || {}, Store.data.examCfg || {}));
    // 上限校验：各题型数量不得超过题库实际容量，保证“显示多少题就生成多少题”
    MSQ.TYPE_ORDER.forEach(function (t) {
      cfg[MSQ.COUNT_KEYS[t]] = Math.min(cfg[MSQ.COUNT_KEYS[t]], byType[t].length);
    });
    return cfg;
  }

  /* 解析数据查找：统一按 String(q.id) 匹配；数据文件缺失或该题无解析时返回 null */
  function getExplanation(qid) {
    var d = window.EXPLANATIONS_DATA;
    return d ? (d[String(qid)] || null) : null;
  }

  function applyExplainState() {
    var open = explainOpen && !!curExplain;
    $("explain-toggle").textContent = open ? "收起解析与记忆技巧 ▴" : "查看解析与记忆技巧 ▾";
    $("explain-body").classList.toggle("hidden", !open);
    if (open) {
      $("explain-reason").textContent = curExplain.reason || "";
      $("explain-memory").textContent = curExplain.memory || "";
    }
  }

  /* ---------------- 视图切换 ---------------- */
  function show(id) {
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle("hidden", views[i].id !== id);
    }
    window.scrollTo(0, 0);
  }

  /* ---------------- 弹窗 ---------------- */
  var Modal = {
    root: null,
    init: function () { this.root = $("modal-root"); },
    isOpen: function () { return !this.root.classList.contains("hidden"); },
    open: function (build) {
      this.root.innerHTML = "";
      var box = document.createElement("div");
      box.className = "modal";
      build(box);
      this.root.appendChild(box);
      this.root.classList.remove("hidden");
    },
    close: function () { this.root.classList.add("hidden"); this.root.innerHTML = ""; },
    alert: function (title, msg, onOk) {
      this.open(function (box) {
        var h = document.createElement("h3"); h.textContent = title || "提示"; box.appendChild(h);
        var m = document.createElement("div"); m.className = "msg"; m.textContent = msg; box.appendChild(m);
        var btns = document.createElement("div"); btns.className = "btns";
        var ok = mkBtn("确定", "barbtn ok", function () { Modal.close(); if (onOk) { onOk(); } });
        btns.appendChild(ok);
        box.appendChild(btns);
      });
    },
    confirm: function (title, msg, onOk, opts) {
      opts = opts || {};
      this.open(function (box) {
        var h = document.createElement("h3"); h.textContent = title; box.appendChild(h);
        var m = document.createElement("div"); m.className = "msg"; m.textContent = msg; box.appendChild(m);
        var btns = document.createElement("div"); btns.className = "btns";
        btns.appendChild(mkBtn("取消", "barbtn cancel", function () { Modal.close(); }));
        btns.appendChild(mkBtn(opts.okText || "确定", "barbtn " + (opts.danger ? "okred" : "ok"), function () {
          Modal.close(); if (onOk) { onOk(); }
        }));
        box.appendChild(btns);
      });
    },
    settings: function () {
      var cfg = examConfig();
      var FIELDS = [
        ["single_count", "单选题数量"], ["multi_count", "多选题数量"], ["judge_count", "判断题数量"],
        ["single_score", "单选每题分值"], ["multi_score", "多选每题分值"], ["judge_score", "判断每题分值"]
      ];
      this.open(function (box) {
        var h = document.createElement("h3"); h.textContent = "模拟考试设置"; box.appendChild(h);
        var caps = {};
        MSQ.TYPE_ORDER.forEach(function (t) { caps[t] = byType[t].length; });
        var inputs = {};
        FIELDS.forEach(function (f) {
          var row = document.createElement("div"); row.className = "field";
          var lb = document.createElement("label");
          lb.textContent = f[1] + (caps[f[0].replace("_count", "")] !== undefined
            ? "（题库上限 " + caps[f[0].replace("_count", "")] + "）" : "");
          var inp = document.createElement("input");
          inp.type = "number"; inp.min = "0"; inp.inputMode = "numeric";
          inp.value = String(cfg[f[0]]);
          inp.addEventListener("input", updateTotal);
          row.appendChild(lb); row.appendChild(inp); box.appendChild(row);
          inputs[f[0]] = inp;
        });
        var total = document.createElement("div"); total.className = "total-line"; box.appendChild(total);
        function readCfg() {
          var c = {};
          for (var k in inputs) {
            var n = parseInt(inputs[k].value, 10);
            if (!isFinite(n) || n < 0) { return null; }
            c[k] = n;
          }
          return c;
        }
        function updateTotal() {
          var c = readCfg();
          if (!c) { total.textContent = "请输入非负整数"; return; }
          var n = 0, s = 0;
          MSQ.TYPE_ORDER.forEach(function (t) {
            n += c[MSQ.COUNT_KEYS[t]]; s += c[MSQ.COUNT_KEYS[t]] * c[MSQ.SCORE_KEYS[t]];
          });
          total.textContent = "共 " + n + " 题，满分 " + s + " 分";
        }
        updateTotal();
        var btns = document.createElement("div"); btns.className = "btns";
        btns.appendChild(mkBtn("恢复默认", "barbtn cancel", function () {
          var d = MSQ.DEFAULT_EXAM_CONFIG;
          FIELDS.forEach(function (f) { inputs[f[0]].value = String(d[f[0]]); });
          updateTotal();
        }));
        btns.appendChild(mkBtn("保存", "barbtn ok", function () {
          var c = readCfg();
          if (!c) { Modal.alert("提示", "数量/分值必须是非负整数。"); return; }
          for (var t in caps) {
            if (c[MSQ.COUNT_KEYS[t]] > caps[t]) {
              Modal.alert("提示", MSQ.TYPE_NAMES[t] + "数量不得超过题库上限 " + caps[t]
                + " 题（当前输入 " + c[MSQ.COUNT_KEYS[t]] + "）。");
              return;
            }
          }
          var n = 0;
          MSQ.TYPE_ORDER.forEach(function (t) { n += c[MSQ.COUNT_KEYS[t]]; });
          if (n === 0) { Modal.alert("提示", "三类题量不能全部为 0。"); return; }
          Store.data.examCfg = c; Store.save();
          Modal.close(); renderMenu();
        }));
        box.appendChild(btns);
        var cancel = document.createElement("div"); cancel.className = "btns";
        cancel.appendChild(mkBtn("取消", "barbtn", function () { Modal.close(); }));
        box.appendChild(cancel);
      });
    }
  };

  function mkBtn(text, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button"; b.className = cls; b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  /* ---------------- 主菜单 ---------------- */
  function renderMenu() {
        var total = bank.questions.length;
    var t = Store.totals();
    var acc = t.a ? (t.c / t.a * 100).toFixed(1) + "%" : "—";
    var cfg = examConfig();
    var n = 0, s = 0;
    MSQ.TYPE_ORDER.forEach(function (k) {
      n += cfg[MSQ.COUNT_KEYS[k]]; s += cfg[MSQ.COUNT_KEYS[k]] * cfg[MSQ.SCORE_KEYS[k]];
    });
    $("menu-bank").textContent = "题库 " + total + " 题 ｜ 单选 " + byType.single.length +
      " · 多选 " + byType.multi.length + " · 判断 " + byType.judge.length;
    $("menu-stats").textContent = "累计作答 " + t.a + " 次 ｜ 正确率 " + acc +
      " ｜ 错题本 " + Store.data.wrong.length + " 题";
    $("menu-exam").textContent = "模拟考试：单选" + cfg.single_count + "×" + cfg.single_score +
      "分 + 多选" + cfg.multi_count + "×" + cfg.multi_score + "分 + 判断" + cfg.judge_count +
      "×" + cfg.judge_score + "分 = " + n + "题/" + s + "分";

    var box = $("menu-buttons");
    box.innerHTML = "";
    // 搜题入口（独立于刷题模式的常驻功能）
    if (!$("btn-search-entry")) {
      var searchWrap = document.createElement("div");
      searchWrap.className = "search-entry-wrap";
      var searchBtn = document.createElement("button");
      searchBtn.type = "button";
      searchBtn.id = "btn-search-entry";
      searchBtn.className = "search-entry";
      searchBtn.textContent = "🔍 搜题";
      searchBtn.addEventListener("click", openSearch);
      searchWrap.appendChild(searchBtn);
      box.parentNode.insertBefore(searchWrap, box);
    }
    MODE_TITLES && Object.keys(MODE_TITLES).forEach(function (key) {
      var b = document.createElement("button");
      b.textContent = MODE_TITLES[key];
      if (key === "exam") { b.classList.add("exam"); }
      b.addEventListener("click", function () {
        if (key === "exam") { startExam(); } else { startPractice(key); }
      });
      box.appendChild(b);
    });
    show("view-menu");
  }

  /* ---------------- 刷题 ---------------- */
  function startPractice(mode) {
    var all = bank.questions;
    var list;
    if (mode === "seq" || mode === "recite") {
      list = all.slice();
    } else if (MSQ.TYPE_NAMES[mode]) {
      list = all.filter(function (q) { return q.type === mode; });
    } else if (mode === "wrong") {
      var idx = {};
      all.forEach(function (q) { idx[q.id] = q; });
      list = Store.data.wrong.map(function (id) { return idx[+id]; }).filter(Boolean);
      if (!list.length) {
        Modal.alert("错题本为空", "先去刷题吧！答错的题会自动进入错题本，答对后自动移出。");
        return;
      }
    } else if (mode === "rand") {
      var ids = Store.data.orders.rand;
      if (ids && ids.length === all.length) {
        var map = {};
        all.forEach(function (q) { map[q.id] = q; });
        list = ids.map(function (i) { return map[i]; }).filter(Boolean);
      }
      if (!list || list.length !== all.length) {
        list = MSQ.shuffled(all, Math.random);
        Store.data.orders.rand = list.map(function (q) { return q.id; });
        Store.save();
      }
    }
    // 做题类模式（顺序/随机/三类专项）：进入会话时一次性生成展示副本，
    // 打乱选项并同步重映射答案；背题、错题重做保持题库原始顺序。
    // 副本存入 P.list，重复渲染/前进后退都复用同一份，保证会话内顺序固定。
    if (mode !== "recite" && mode !== "wrong") {
      list = list.map(function (q) { return MSQ.shuffleQuestionOptions(q, Math.random); });
    }
    P = {
      mode: mode, list: list,
      pos: Math.max(0, Math.min(Store.data.positions[mode] || 0, list.length - 1)),
      session: {}
    };
    $("btn-handin").classList.add("hidden");
    show("view-quiz");
    renderQuestion();
  }

  function currentQ() { return (P ? P.list : E.paper)[pos()]; }
  function pos() { return P ? P.pos : E.pos; }

  function setOptionClass(b, q, i, st, locked) {
    b.classList.toggle("selected", !locked && st.sel && st.sel.has(i));
    if (locked) {
      b.disabled = true;
      if (q.answer.indexOf(i) >= 0) { b.classList.add("correct"); }
      else if (st.sel && st.sel.has(i)) { b.classList.add("wrong"); }
      else { b.classList.add("plain"); }
    }
  }

  function buildOption(q, i, st, locked) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "opt" + (q.type === "judge" ? " judge" : "");
    if (q.type !== "judge") {
      var tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = MSQ.LETTERS[i] + ".";
      b.appendChild(tag);
    }
    b.appendChild(document.createTextNode(q.options[i]));
    setOptionClass(b, q, i, st, locked);
    b.addEventListener("click", function () { onOptionTap(q, i); });
    return b;
  }

  function onOptionTap(q, i) {
    if (P) {
      var st = P.session[q.id] || (P.session[q.id] = { sel: new Set(), submitted: false, correct: false });
      if (st.submitted || P.mode === "recite") { return; }
      if (q.type === "multi") {
        if (st.sel.has(i)) { st.sel.delete(i); } else { st.sel.add(i); }
        renderQuestion();          // 重新刷新“已选”高亮
      } else {
        st.sel = new Set([i]);
        submitPractice();          // 单选/判断：点击即作答
      }
    } else if (E) {
      var sel = E.answers[q.id] || (E.answers[q.id] = new Set());
      if (q.type === "multi") {
        if (sel.has(i)) { sel.delete(i); } else { sel.add(i); }
      } else {
        E.answers[q.id] = new Set([i]);
      }
      renderQuestion();
    }
  }

  function submitPractice() {
    var q = currentQ();
    var st = P.session[q.id];
    if (!st || st.submitted) { return; }
    if (!st.sel.size) { Modal.alert("提示", "请先选择答案。"); return; }
    var ok = MSQ.isCorrect(q, Array.from(st.sel));
    st.submitted = true; st.correct = ok;
    Store.record(q.id, ok);
    savePosition();
    renderQuestion();
  }

  function renderQuestion() {
    var sc = $("quiz-scroll");
    var scrollY = sc.scrollTop;
    var q = currentQ();
    var exam = !!E;
    var recite = !exam && P.mode === "recite";
    var st = exam
      ? { sel: E.answers[q.id] || new Set(), submitted: false, correct: false }
      : (P.session[q.id] || (P.session[q.id] = { sel: new Set(), submitted: false, correct: false }));

    // 顶部标题：只保留模式与进度（模拟考试含已答数）；题型移到题干上方第二行
    if (exam) {
      var answered = 0;
      for (var k in E.answers) { if (E.answers[k].size) { answered++; } }
      $("quiz-title").textContent = "模拟考试 ｜ 第 " + (E.pos + 1) + "/" + E.paper.length + " 题 ｜ 已答 " + answered;
    } else {
      $("quiz-title").textContent = MODE_TITLES[P.mode] + " ｜ 第 " + (P.pos + 1) + "/" + P.list.length + " 题";
    }

    // 题干上方第二行：仅显示题型名称（major/专业 字段保留在数据中，只是 UI 不再展示）
    var typeLine = $("type-line");
    typeLine.textContent = MSQ.TYPE_NAMES[q.type];
    typeLine.classList.remove("hidden");
    $("stem").textContent = q.stem;

    // 选项
    var box = $("options");
    box.innerHTML = "";
    var locked = exam ? false : (st.submitted || recite);
    q.options.forEach(function (_o, i) { box.appendChild(buildOption(q, i, st || { sel: null }, locked)); });

    // 反馈条
    var fb = $("feedback");
    if (exam) {
      fb.classList.add("hidden");
    } else if (recite) {
      fb.className = "feedback ok";
      fb.textContent = "【答案】" + MSQ.answerText(q) + "　" +
        q.answer.map(function (i) { return MSQ.LETTERS[i] + ". " + q.options[i]; }).join("；");
      fb.classList.remove("hidden");
    } else if (st.submitted) {
      var selTxt = Array.from(st.sel).sort(function (a, b) { return a - b; })
        .map(function (i) { return MSQ.LETTERS[i]; }).join("") || "—";
      fb.className = "feedback " + (st.correct ? "ok" : "err");
      fb.textContent = st.correct ? "✔ 回答正确"
        : "✘ 回答错误　你的答案：" + selTxt + "　正确答案：" + MSQ.answerText(q);
      fb.classList.remove("hidden");
    } else {
      var s = Store.statOf(q.id);
      fb.className = "feedback info";
      fb.textContent = s.a ? ("本题历史：已答 " + s.a + " 次，正确 " + s.c + " 次")
        : (q.type === "multi" ? "多选题：请选中全部正确选项后点「提交答案」" : "点击选项直接作答");
      fb.classList.remove("hidden");
    }

    // 解析与记忆技巧：默认折叠，每切换一题重置。
    // 背题：直接显示入口；普通刷题/错题重做：提交答案后才显示；模拟考试答题中：完全不显示。
    // 解析数据按 String(q.id) 查找；该题无解析时整个入口隐藏（安全降级，不出现空白框）。
    curExplain = getExplanation(q.id);
    explainOpen = false;
    var showExplain = !!curExplain && (exam ? false : (recite || st.submitted));
    $("explain-box").classList.toggle("hidden", !showExplain);
    applyExplainState();

    // 底部按钮
    var canSubmit = !exam && !recite && q.type === "multi" && !st.submitted;
    $("btn-submit").classList.toggle("hidden", !canSubmit);
    $("btn-handin").classList.toggle("hidden", !exam);
    $("btn-jump").classList.toggle("hidden", !(P && P.mode === "recite"));
    $("btn-next").classList.toggle("primary", (!exam && st && st.submitted) || recite);
    $("btn-prev").disabled = pos() === 0;
    $("btn-next").textContent = (!exam && P.pos === P.list.length - 1) ? "完成" : "下一题";

    sc.scrollTop = scrollY;
  }

  function savePosition() {
    if (P) { Store.data.positions[P.mode] = P.pos; Store.save(); }
  }

  function goNext() {
    if (P) {
      if (P.pos + 1 < P.list.length) {
        P.pos++; savePosition(); renderQuestion();
      } else {
        finishRound();
      }
    } else if (E) {
      if (E.pos + 1 < E.paper.length) { E.pos++; renderQuestion(); }
    }
  }

  function goPrev() {
    if (P) {
      if (P.pos > 0) { P.pos--; savePosition(); renderQuestion(); }
    } else if (E) {
      if (E.pos > 0) { E.pos--; renderQuestion(); }
    }
  }

  function finishRound() {
    var answered = 0, correct = 0;
    for (var k in P.session) {
      if (P.session[k].submitted) { answered++; if (P.session[k].correct) { correct++; } }
    }
    var msg;
    if (P.mode === "recite") {
      msg = "本轮背题完成，共浏览 " + P.list.length + " 题。";
    } else if (P.mode === "wrong") {
      msg = "错题重做完成：本次作答 " + answered + " 题，答对 " + correct + " 题。\n答对的题已自动移出错题本。";
    } else {
      msg = "本轮共 " + P.list.length + " 题：本次作答 " + answered + " 题，答对 " + correct + " 题。";
    }
    Store.data.positions[P.mode] = 0; Store.save();
    Modal.alert("完成", msg + "\n即将返回主菜单。", function () { P = null; renderMenu(); });
  }

  /* ---------------- 模拟考试 ---------------- */
  function startExam() {
    E = { paper: MSQ.generateExam(byType, examConfig(), Math.random), answers: {}, pos: 0, result: null };
    P = null;
    show("view-quiz");
    renderQuestion();
  }

  function handin() {
    var n = E.paper.length, answered = 0;
    for (var k in E.answers) { if (E.answers[k].size) { answered++; } }
    Modal.confirm("交卷确认",
      "共 " + n + " 题，已答 " + answered + " 题，未答 " + (n - answered) + " 题。\n确定交卷吗？",
      doHandin, { danger: true, okText: "交卷" });
  }

  function doHandin() {
    var answers = {};
    for (var k in E.answers) { answers[k] = Array.from(E.answers[k]); }
    var r = MSQ.scoreExam(E.paper, answers, examConfig());
    var pairs = E.paper.map(function (q) { return [q.id, r.wrong.indexOf(q.id) < 0]; });
    Store.recordMany(pairs);   // 考试作答同样计入统计与错题本
    E.result = r;
    renderResult();
  }

  function renderResult() {
    var r = E.result, cfg = examConfig();
    $("result-body").innerHTML = "";
    var big = document.createElement("div");
    big.className = "score-big";
    big.textContent = r.score + " / " + r.full + " 分";
    $("result-body").appendChild(big);
    var sub = document.createElement("div");
    sub.className = "score-sub";
    sub.textContent = "共 " + E.paper.length + " 题 ｜ 答对 " + (E.paper.length - r.wrong.length) +
      " 题 ｜ 答错 " + r.wrong.length + " 题";
    $("result-body").appendChild(sub);

    MSQ.TYPE_ORDER.forEach(function (t) {
      var ok = r.detail[t][0], tot = r.detail[t][1];
      var pct = tot ? Math.round(ok / tot * 100) : 0;
      var line = document.createElement("div");
      line.className = "result-line";
      line.textContent = MSQ.TYPE_NAMES[t] + "：正确 " + ok + " / " + tot + "（" + pct + "%）" +
        "　得分 " + (ok * cfg[MSQ.SCORE_KEYS[t]]) + " / " + (tot * cfg[MSQ.SCORE_KEYS[t]]);
      $("result-body").appendChild(line);
    });

    var btns = document.createElement("div"); btns.className = "result-btns";
    btns.appendChild(mkBtn("查看本次错题（" + r.wrong.length + "）", "barbtn primary", renderReview));
    btns.appendChild(mkBtn("重新生成一套试卷", "barbtn", startExam));
    btns.appendChild(mkBtn("返回主菜单", "barbtn", function () { E = null; renderMenu(); }));
    $("result-body").appendChild(btns);
    show("view-result");
  }

  function renderReview() {
    var r = E.result;
    $("review-title").textContent = "本次错题（" + r.wrong.length + " 题）";
    var body = $("review-body");
    body.innerHTML = "";
    if (!r.wrong.length) {
      var ok = document.createElement("p");
      ok.style.textAlign = "center"; ok.style.color = "#0a7d32";
      ok.textContent = "本次考试全部答对！";
      body.appendChild(ok);
    }
    var idx = {};
    E.paper.forEach(function (q) { idx[q.id] = q; });
    r.wrong.forEach(function (qid) {
      var q = idx[qid];
      var sel = E.answers[q.id] || new Set();
      var block = document.createElement("div"); block.className = "review-block";
      var meta = document.createElement("div"); meta.className = "review-meta";
      var you = document.createElement("b"); you.className = "you";
      you.textContent = "你的答案：" + (sel.size ? Array.from(sel).sort(function (a, b) { return a - b; })
        .map(function (i) { return MSQ.LETTERS[i]; }).join("") : "—");
      var ans = document.createElement("b"); ans.className = "ans";
      ans.textContent = "　正确答案：" + MSQ.answerText(q);
      meta.appendChild(document.createTextNode("【" + MSQ.TYPE_NAMES[q.type] + " · 序号 " + q.id + "】"));
      meta.appendChild(you); meta.appendChild(ans);
      block.appendChild(meta);
      var stemEl = document.createElement("div"); stemEl.className = "review-stem";
      stemEl.textContent = q.stem; block.appendChild(stemEl);
            q.options.forEach(function (opt, i) {
                var row = document.createElement("div");
                var isAns = q.answer.indexOf(i) >= 0;
                row.className = "review-opt " + (isAns ? "ok" : (sel.has(i) ? "err" : "dim"));
                row.textContent = (isAns ? "✔ " : (sel.has(i) ? "✘ " : "　")) + MSQ.LETTERS[i] + ". " + opt;
                block.appendChild(row);
            });
            // 交卷后错题逐题解析（默认折叠；该题无解析则不显示入口）
            var exp = getExplanation(q.id);
            if (exp) {
              var eb = document.createElement("button");
              eb.type = "button";
              eb.className = "explain-btn";
              eb.textContent = "查看解析与记忆技巧 ▾";
              var ebody = document.createElement("div");
              ebody.className = "explain-body hidden";
              var sec1 = document.createElement("div"); sec1.className = "explain-sec";
              var h1 = document.createElement("div"); h1.className = "explain-h"; h1.textContent = "为什么这么选";
              var t1 = document.createElement("p"); t1.className = "explain-text"; t1.textContent = exp.reason || "";
              sec1.appendChild(h1); sec1.appendChild(t1);
              var sec2 = document.createElement("div"); sec2.className = "explain-sec memory";
              var h2 = document.createElement("div"); h2.className = "explain-h"; h2.textContent = "记忆技巧";
              var t2 = document.createElement("p"); t2.className = "explain-text"; t2.textContent = exp.memory || "";
              sec2.appendChild(h2); sec2.appendChild(t2);
              ebody.appendChild(sec1); ebody.appendChild(sec2);
              eb.addEventListener("click", function () {
                var open = ebody.classList.toggle("hidden") === false;
                eb.textContent = open ? "收起解析与记忆技巧 ▴" : "查看解析与记忆技巧 ▾";
              });
              block.appendChild(eb);
              block.appendChild(ebody);
            }
            body.appendChild(block);
    });
    show("view-review");
  }

  /* ---------------- 背题模式快速跳转 ---------------- */
  function openJump() {
    if (!P || P.mode !== "recite") { return; }
    var total = P.list.length;
    Modal.open(function (box) {
      var h = document.createElement("h3");
      h.textContent = "背题模式跳转";
      box.appendChild(h);
      var m = document.createElement("div");
      m.className = "msg";
      m.textContent = "当前第 " + (P.pos + 1) + " / " + total + " 题";
      box.appendChild(m);
      var row = document.createElement("div");
      row.className = "field";
      var lb = document.createElement("label");
      lb.textContent = "跳转到第";
      var inp = document.createElement("input");
      inp.type = "number"; inp.min = "1"; inp.max = String(total);
      inp.inputMode = "numeric"; inp.placeholder = "1 ~ " + total;
      var suffix = document.createElement("span");
      suffix.textContent = "题";
      suffix.style.cssText = "font-size:16px;margin-left:6px";
      row.appendChild(lb); row.appendChild(inp); row.appendChild(suffix);
      box.appendChild(row);
      var err = document.createElement("div");
      err.className = "total-line";
      err.style.color = "#c62828";
      box.appendChild(err);
      function doJump() {
        var res = MSQ.parseJumpTarget(inp.value, total);
        if (!res.ok) { err.textContent = res.reason; return; }
        Modal.close();
        P.pos = res.index;
        savePosition();          // 保存进度，退出重进可从此位置继续
        renderQuestion();
      }
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { doJump(); }
      });
      var btns = document.createElement("div");
      btns.className = "btns";
      btns.appendChild(mkBtn("取消", "barbtn cancel", function () { Modal.close(); }));
      btns.appendChild(mkBtn("跳转", "barbtn ok", doJump));
      box.appendChild(btns);
      setTimeout(function () { try { inp.focus(); } catch (e) { } }, 0);
    });
  }

  /* ---------------- 本地搜题 ---------------- */
  var searchIndex = null;
  var searchDebounceTimer = null;
  var HISTORY_KEY = "msq.searchHistory.v1";
  var SEARCH_RENDER_LIMIT = 30;
  /* 题型筛选：会话内保持（不写 localStorage），App 冷启动回到 all */
  var searchFilter = "all";
  var searchInputBlurAt = 0;
  var SEARCH_FILTER_DEFS = [
    { key: "all", short: "全部", full: "" },
    { key: "single", short: "单选", full: "单选题" },
    { key: "multi", short: "多选", full: "多选题" },
    { key: "judge", short: "判断", full: "判断题" }
  ];

  function searchFilterLabel(key, full) {
    for (var i = 0; i < SEARCH_FILTER_DEFS.length; i++) {
      if (SEARCH_FILTER_DEFS[i].key === key) {
        return full ? SEARCH_FILTER_DEFS[i].full : SEARCH_FILTER_DEFS[i].short;
      }
    }
    return "";
  }

  function getHistory() {
    try {
      var h = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(h) ? h : [];
    } catch (e) { return []; }
  }

  function pushHistory(raw) {
    var q = String(raw || "").trim();
    if (!q) { return; }
    var h = getHistory().filter(function (x) { return x !== q; });
    h.unshift(q);
    h = h.slice(0, 10);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) { }
    renderHistory();
  }

  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { }
    renderHistory();
  }

  function renderHistory() {
    var box = $("search-history");
    var h = getHistory();
    if (!box) { return; }
    box.innerHTML = "";
    var empty = !$("search-input").value.trim();
    if (!empty || !h.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    var head = document.createElement("div");
    head.className = "hist-head";
    var label = document.createElement("span");
    label.textContent = "最近搜索";
    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "清除搜索历史";
    clearBtn.addEventListener("click", clearHistory);
    head.appendChild(label); head.appendChild(clearBtn);
    box.appendChild(head);
    var chips = document.createElement("div");
    chips.className = "chips";
    h.forEach(function (q) {
      var c = document.createElement("button");
      c.type = "button"; c.className = "chip"; c.textContent = q;
      c.addEventListener("click", function () {
        $("search-input").value = q;
        doSearch(q);
        pushHistory(q);
      });
      chips.appendChild(c);
    });
    box.appendChild(chips);
  }

  /* 原文连续子串高亮：全部用 DOM 文本节点 + <mark>，不拼接用户输入的 innerHTML */
  function renderHighlighted(parent, text, query) {
    var q = String(query || "").trim();
    if (!q) { parent.textContent = text; return; }
    var pos = 0;
    while (true) {
      var at = text.indexOf(q, pos);
      if (at < 0) { break; }
      if (at > pos) { parent.appendChild(document.createTextNode(text.slice(pos, at))); }
      var mark = document.createElement("mark");
      mark.textContent = text.slice(at, at + q.length);
      parent.appendChild(mark);
      pos = at + q.length;
    }
    if (pos < text.length) { parent.appendChild(document.createTextNode(text.slice(pos))); }
  }

  /* 筛选按钮：有搜索词时带真实数量（全部 12 单选 5 …），无搜索词时只有名称 */
  function renderFilterBar(counts, hasQuery) {
    var box = $("search-filters");
    if (!box) { return; }
    var btns = box.getElementsByClassName("filter-btn");
    for (var i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute("data-filter");
      var on = key === searchFilter;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
      var label = searchFilterLabel(key, false);
      btns[i].textContent = hasQuery ? label + " " + (counts[key] || 0) : label;
    }
  }

  function doSearch(raw) {
    var q = String(raw || "").trim();
    var all = MSQ.searchQuestions(searchIndex, q);
    var counts = MSQ.countSearchResultsByType(all);
    renderFilterBar(counts, q !== "");
    /* 一次搜索 + 一次过滤：只从有序结果里摘取，不重搜、不重排 */
    var results = MSQ.filterSearchResults(all, searchFilter);
    var box = $("search-results");
    var countEl = $("search-count");
    var hist = $("search-history");
    box.innerHTML = "";
    if (!all.length) {
      var hasQuery = q !== "";
      countEl.classList.toggle("hidden", !hasQuery);
      if (hasQuery) {
        countEl.textContent = "未找到相关题目";
        countEl.classList.remove("hidden");
      }
      renderHistory();
      return;
    }
    /* 关键词本身有结果，只是当前题型没有：说清是筛选无结果，不是搜不到 */
    if (!results.length) {
      countEl.classList.remove("hidden");
      countEl.textContent = "当前关键词没有匹配的" + searchFilterLabel(searchFilter, true);
      if (hist && !hist.classList.contains("hidden")) { hist.classList.add("hidden"); }
      return;
    }
    countEl.classList.remove("hidden");
    countEl.textContent = "找到 " + results.length + " " +
      (searchFilter === "all" ? "道题" : "道" + searchFilterLabel(searchFilter, true)) +
      (results.length > SEARCH_RENDER_LIMIT ? "，显示前 " + SEARCH_RENDER_LIMIT + " 道" : "");
    if (hist && !hist.classList.contains("hidden")) { hist.classList.add("hidden"); }
    results.slice(0, SEARCH_RENDER_LIMIT).forEach(function (r) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "search-item";
      var typeEl = document.createElement("div");
      typeEl.className = "s-type";
      typeEl.textContent = r.type_name;
      item.appendChild(typeEl);
      var stemEl = document.createElement("div");
      stemEl.className = "s-stem";
      renderHighlighted(stemEl, r.stem, q);
      item.appendChild(stemEl);
      if (r.hitOption) {
        var optEl = document.createElement("div");
        optEl.className = "s-opt";
        optEl.textContent = "命中选项：" + r.hitOption;
        item.appendChild(optEl);
      }
      item.addEventListener("click", function () {
        pushHistory(raw);
        openSearchDetail(r.id);
      });
      box.appendChild(item);
    });
  }

  /* 切换题型：立即用当前关键词重渲染（不重新输入、不按搜索键），搜索词与焦点保持不变 */
  function applyFilter(key) {
    if (!key || key === searchFilter) { return; }
    searchFilter = key;
    doSearch($("search-input").value);
    var sc = $("search-scroll");
    if (sc) { sc.scrollTop = 0; }
    // 触摸端按住按钮会让搜索框失焦（软键盘收起）：刚刚还在输入就把焦点还回去
    var input = $("search-input");
    if (input && Date.now() - searchInputBlurAt < 800) {
      try { input.focus({ preventScroll: true }); }
      catch (e) { try { input.focus(); } catch (e2) { } }
    }
  }

  function initSearchFilters() {
    var box = $("search-filters");
    if (!box) { return; }
    /* 桌面端按下按钮不夺走搜索框焦点 */
    box.addEventListener("mousedown", function (e) { e.preventDefault(); });
    box.addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== box && !el.classList.contains("filter-btn")) { el = el.parentNode; }
      if (!el || el === box) { return; }
      applyFilter(el.getAttribute("data-filter"));
    });
  }

  function openSearch() {
    show("view-search");
    renderHistory();
    setTimeout(function () {
      try { $("search-input").focus(); } catch (e) { }
    }, 60);
  }

  /* 搜题详情：只显示 题型/原始题干/原始选项（原序）/正确答案，不含解析与记忆技巧 */
  function openSearchDetail(id) {
    var q = null;
    bank.questions.forEach(function (x) { if (x.id === id) { q = x; } });
    if (!q) { return; }
    var body = $("search-detail-body");
    body.innerHTML = "";
    var meta = document.createElement("p");
    meta.className = "type-line";
    meta.textContent = MSQ.TYPE_NAMES[q.type] + " ｜ 序号 " + q.id;
    body.appendChild(meta);
    var stemCard = document.createElement("div");
    stemCard.className = "stem";
    stemCard.textContent = q.stem;
    body.appendChild(stemCard);
    q.options.forEach(function (opt, i) {
      var row = document.createElement("div");
      row.className = "opt" + (q.answer.indexOf(i) >= 0 ? " correct" : " plain");
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = MSQ.LETTERS[i] + ".";
      row.appendChild(tag);
      row.appendChild(document.createTextNode(opt));
      body.appendChild(row);
    });
    var ans = document.createElement("div");
    ans.className = "feedback ok";
    ans.textContent = "【答案】" + MSQ.answerText(q);
    body.appendChild(ans);
    show("view-search-detail");
  }

  /* ---------------- 返回逻辑（页面返回按钮与 Android 系统 Back 共用） ---------------- */

  function getAppPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) || null;
  }

  function exitApp() {
    var App = getAppPlugin();
    if (App && typeof App.exitApp === "function") { App.exitApp(); }
    /* 浏览器环境无 App 插件：忽略，不循环 */
  }

  function currentViewId() {
    var v = document.querySelector(".view:not(.hidden)");
    return v ? v.id : "view-menu";
  }

  /* 模拟考试答题中返回：确认退出（确认后回首页，放弃答卷） */
  function confirmExitExam() {
    Modal.confirm("退出考试", "退出将放弃本次答卷，确定吗？", function () { E = null; renderMenu(); });
  }

  /* 刷题/背题/考试答题页返回（保留现有学习进度保存） */
  function handleQuizBack() {
    if (E) {
      confirmExitExam();
      return;
    }
    savePosition();
    P = null;
    renderMenu();
  }

  /* 错题回顾返回 → 成绩页 */
  function handleReviewBack() {
    if (E && E.result) {
      renderResult();
      return;
    }
    E = null;
    renderMenu();
  }

  /* 搜题列表返回 → 首页（关键词/结果在 DOM 中自然保留，下次进入仍在） */
  function handleSearchBack() {
        renderMenu();
  }

  /* 拍照搜题返回 → 搜题列表 */
  function handlePhotoBack() {
        show("view-search");
  }

  /* 搜题详情返回 → 搜题列表（不重建页面，关键词/结果/滚动位置保留） */
  function handleSearchDetailBack() {
    show("view-search");
  }

  /* 统一返回入口：系统 Back 与各页返回按钮共用同一套分层。
     Modal 打开时优先关闭弹窗（只取消/关闭，绝不触发确定/删除/交卷）。
     首页无更上一层：交给 Android 常规行为退出。 */
  function handleBack() {
    if (Modal.isOpen()) { Modal.close(); return; }
    switch (currentViewId()) {
      case "view-search-detail": handleSearchDetailBack(); return;
      case "view-batch-results": handleBatchResultsBack(); return;
      case "view-batch-photo": handleBatchBack(); return;
      case "view-photo": handlePhotoBack(); return;
      case "view-search": handleSearchBack(); return;
      case "view-review": handleReviewBack(); return;
      case "view-result": E = null; renderMenu(); return;
      case "view-quiz": handleQuizBack(); return;
      default: exitApp();
    }
  }
  window.handleBack = handleBack; /* 设备端调试/自动化入口 */

  /* 注册 Android 系统 Back（Capacitor App 插件 backButton）。
     注意：注册后默认返回行为被接管，首页分支必须显式 exitApp。
     输入法弹出时，第一次 Back 由 Android 系统消费（仅收起键盘），不会进入本回调。 */
  function registerSystemBack() {
    var App = getAppPlugin();
    if (App && typeof App.addListener === "function") {
      App.addListener("backButton", function () { handleBack(); });
    }
  }

  /* ---------------- 拍照搜题（本地相机 + 本地 OCR + 本地匹配，零上传） ---------------- */
  var photoIndex = null;

  function getPlugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  }

  /* 插件缺失诊断：区分哪一层未加载，附带桥接状态，便于真机定位 */
  function photoPluginMissingMessage(Camera, Ocr) {
    var msg;
    if (!Camera && !Ocr) { msg = "相机和OCR插件均未加载"; }
    else if (!Camera) { msg = "相机插件未加载"; }
    else { msg = "OCR插件未加载"; }
    var bridge = !!window.Capacitor;
    return msg + "（Camera=" + !!Camera + " Ocr=" + !!Ocr + " 桥=" + bridge + "）";
  }

  function setPhotoStatus(text) {
    var el = $("photo-status");
    if (el) { el.textContent = text; el.classList.remove("hidden"); }
  }

  function openPhotoSearch() {
    show("view-photo");
    var st = $("photo-status");
    if (st) {
      st.textContent = "尽量只拍一道题，并保证题干清晰完整";
      st.classList.remove("hidden");
    }
    $("photo-preview").classList.add("hidden");
    $("photo-results").innerHTML = "";
  }

  function renderPhotoResults(ocrText, matches, timing) {
    var box = $("photo-results");
    box.innerHTML = "";
    var conf = MSQ.ocrConfidence(matches);
    var head = document.createElement("div");
    head.className = "search-count";
    if (conf.level === "confident") {
      head.textContent = "最佳匹配：第" + matches[0].id + " 题" +
        (timing ? "（识别 " + timing.ocrMs + "ms · 匹配 " + timing.matchMs + "ms）" : "");
    } else if (conf.level === "candidates") {
      head.textContent = "可能是以下题目（识别 " + (timing ? timing.ocrMs + "ms" : "—") +
        " · 匹配 " + (timing ? timing.matchMs + "ms" : "—") + "）";
    } else {
      head.textContent = "没有找到可靠匹配，请重拍或手动输入关键词";
    }
    box.appendChild(head);
    // OCR 识别文字预览（默认折叠，区分"识别错"与"匹配错"）
    var pv = document.createElement("button");
    pv.type = "button";
    pv.className = "explain-btn";
    pv.textContent = "查看识别文字 ▾";
    var pvBody = document.createElement("div");
    pvBody.className = "explain-body hidden";
    var pvSec = document.createElement("div");
    pvSec.className = "explain-sec";
    var pvText = document.createElement("p");
    pvText.className = "explain-text";
    pvText.textContent = ocrText || "（无）";
    pvSec.appendChild(pvText);
    pvBody.appendChild(pvSec);
    pv.addEventListener("click", function () {
      var open = pvBody.classList.toggle("hidden") === false;
      pv.textContent = open ? "收起识别文字 ▴" : "查看识别文字 ▾";
    });
    box.appendChild(pv);
    box.appendChild(pvBody);
    // 结果卡片：非常确定只给 1 条；否则 Top 3~5
    var limit = conf.level === "confident" ? 1 : Math.min(5, matches.length);
    matches.slice(0, limit).forEach(function (m, idx) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "search-item";
      var typeEl = document.createElement("div");
      typeEl.className = "s-type";
      typeEl.textContent = (conf.level === "confident" ? "最佳匹配" : "候选 " + (idx + 1)) +
        " ｜ " + m.type_name + " ｜ 序号 " + m.id;
      item.appendChild(typeEl);
      var stemEl = document.createElement("div");
      stemEl.className = "s-stem";
      stemEl.textContent = m.stem;
      item.appendChild(stemEl);
      item.addEventListener("click", function () { openSearchDetail(m.id); });
      box.appendChild(item);
    });
  }

  async function startPhotoSearch() {
    var Camera = getPlugin("Camera");
    var Ocr = getPlugin("Ocr");
    if (!Camera || !Ocr) {
      setPhotoStatus(photoPluginMissingMessage(Camera, Ocr));
      return;
    }
    setPhotoStatus("正在打开相机…");
    var photo;
    try {
      photo = await Camera.getPhoto({
        quality: 70,
        width: 1600,
        resultType: "dataUrl",
        source: "CAMERA",
        saveToGallery: false,
        allowEditing: false
      });
    } catch (e) {
      var msg = String((e && e.message) || e);
      setPhotoStatus(/permission|denied/i.test(msg)
        ? "无法使用相机，请授予相机权限后重试"
        : "未拍摄照片（" + msg.slice(0, 40) + "）");
      return;
    }
    setPhotoStatus("正在识别文字…");
    var totalStart = performance.now();
    var ocrMs = 0;
    var text = "";
    try {
      var b64 = String(photo.dataUrl || "").split(",")[1] || "";
      var res = await Ocr.recognizeText({ base64: b64 });
      text = (res && res.text) || "";
      ocrMs = (res && res.ms) || 0;
    } catch (e) {
      setPhotoStatus("识别失败，请重新拍摄（" + String((e && e.message) || e).slice(0, 40) + "）");
      return;
    }
    if (!text.trim()) {
      setPhotoStatus("未识别到清晰文字，请重新拍摄");
      return;
    }
    var m0 = performance.now();
    var matches = MSQ.searchQuestionsByOcr(photoIndex, text);
    var matchMs = Math.round(performance.now() - m0);
    if (!matches.length) {
      setPhotoStatus("没有找到可靠匹配，请重拍或手动输入关键词");
      var pv = $("photo-preview");
      if (pv) {
        pv.innerHTML = "";
        var btn = document.createElement("button");
        btn.type = "button"; btn.className = "explain-btn"; btn.textContent = "查看识别文字 ▾";
        var bd = document.createElement("div"); bd.className = "explain-body hidden";
        var sc = document.createElement("div"); sc.className = "explain-sec";
        var tx = document.createElement("p"); tx.className = "explain-text"; tx.textContent = text;
        sc.appendChild(tx); bd.appendChild(sc); pv.appendChild(btn); pv.appendChild(bd);
        btn.addEventListener("click", function () {
          var open = bd.classList.toggle("hidden") === false;
          btn.textContent = open ? "收起识别文字 ▴" : "查看识别文字 ▾";
        });
        pv.classList.remove("hidden");
      }
      return;
    }
    setPhotoStatus("识别完成（全程本地，图片不保存不上传）");
    renderPhotoResults(text, matches, { ocrMs: ocrMs, matchMs: matchMs,
      totalMs: Math.round(performance.now() - totalStart) });
  }

  /* ---------------- 整页拍照搜题（分题 + 题型强约束批量匹配） ----------------
     与单题拍照完全独立：单题路径 searchQuestionsByOcr 保持原样，这里走
     searchPageQuestionsByOcr（先分题，再只在所选题型的子集里匹配）。 */
  var batchIndex = null;
  var batchPageType = "single";   /* 会话内保持，不写 localStorage；冷启动回到单选 */
  var lastBatch = null;

  function setBatchStatus(text) {
    var el = $("batch-status");
    if (el) { el.textContent = text; el.classList.remove("hidden"); }
  }

  function renderBatchTypes() {
    var box = $("batch-type-row");
    if (!box) { return; }
    var btns = box.getElementsByClassName("batch-type-btn");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-type") === batchPageType;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function initBatchTypes() {
    var box = $("batch-type-row");
    if (!box) { return; }
    box.addEventListener("mousedown", function (e) { e.preventDefault(); });
    box.addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== box && !el.classList.contains("batch-type-btn")) { el = el.parentNode; }
      if (!el || el === box) { return; }
      batchPageType = el.getAttribute("data-type") || "single";
      renderBatchTypes();
    });
  }

  function openBatchPhoto() {
    show("view-batch-photo");
    renderBatchTypes();
    setBatchStatus("选好当前大题题型后拍整页：一页可以只拍一次，页内换大块会自动切换题型");
  }

  /* OCR 返回：优先用带坐标的 lines；旧版本插件只返回 text 时按行退化，仍可分题。 */
  function normalizeOcrLines(res) {
    var lines = res && res.lines;
    if (lines && lines.length) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i] && lines[i].text;
        if (t && String(t).trim()) { out.push(lines[i]); }
      }
      if (out.length) { return out; }
    }
    var text = (res && res.text) || "";
    return text.split(/\r?\n/).map(function (t) { return { text: t }; });
  }

  function batchAnswerDisplay(b) {
    /* 低置信度不强行给确定答案：显示 ? 并在详情里给 Top3 候选 */
    if (!b || b.confidence === "low" || b.confidence === "none" || b.answer === "?") { return "?"; }
    return b.answer;
  }

  var BATCH_TYPE_NAMES = { single: "单选题", multi: "多选题", judge: "判断题" };

  function batchDetail(b) {
    var d = document.createElement("div");
    d.className = "batch-detail hidden";
    var add = function (label, value) {
      var p = document.createElement("div");
      var k = document.createElement("span"); k.className = "k"; k.textContent = label + "：";
      var v = document.createElement("span"); v.className = "v"; v.textContent = value;
      p.appendChild(k); p.appendChild(v); d.appendChild(p);
    };
    add("OCR识别到的题干", b.stemText || "（无）");
    add("题库题号", b.bankId === null ? "未匹配到" : ("第 " + b.bankId + " 题 ｜ " + (BATCH_TYPE_NAMES[b.type] || b.type)));
    add("正确答案", b.answerItem ? b.answer : "—");
    add("置信度", { high: "高", medium: "中", low: "低", none: "无匹配" }[b.confidence] || b.confidence);
    if (b.matches && b.matches.assistedByOptions) { add("匹配方式", "题干 + 选项辅助"); }
    if (b.matches && b.matches.length) {
      var t1 = b.matches[0];
      add("完整题干", t1.stem);
      if (t1.options && t1.options.length) {
        add("题库选项", t1.options.map(function (o, i) { return MSQ.LETTERS[i] + ". " + o; }).join("　"));
      }
    }
    var cands = (b.matches || []).slice(0, 3);
    if (cands.length > 1 || b.confidence === "low" || b.confidence === "none") {
      var head = document.createElement("div");
      head.className = "k";
      head.textContent = cands.length ? "Top" + cands.length + " 候选（点开看原题）" : "没有找到候选";
      d.appendChild(head);
      cands.forEach(function (m, i) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "batch-cand";
        btn.textContent = (i + 1) + ". 第" + m.id + "题 ｜ " + m.type_name + " ｜ 得分 " + m.score + "：" +
          m.stem.slice(0, 40);
        btn.addEventListener("click", function () { openSearchDetail(m.id); });
        d.appendChild(btn);
      });
    }
    return d;
  }

  function batchRow(b) {
    var wrap = document.createElement("div");
    var row = document.createElement("button");
    row.type = "button";
    row.className = "batch-row";
    var no = document.createElement("span");
    no.className = "batch-no";
    no.textContent = b.label;
    var ans = document.createElement("span");
    var shown = batchAnswerDisplay(b);
    ans.className = "batch-ans" + (shown === "?" ? " low" : (b.confidence === "medium" ? " mid" : ""));
    ans.textContent = shown;
    row.appendChild(no);
    row.appendChild(ans);
    if (b.type !== batchPageType) {
      var tag = document.createElement("span");
      tag.className = "batch-type-tag";
      tag.textContent = BATCH_TYPE_NAMES[b.type] || b.type;
      row.appendChild(tag);
    }
    var flag = document.createElement("span");
    flag.className = "batch-flag";
    flag.textContent = b.confidence === "medium" ? "◐" : (b.confidence === "low" || b.confidence === "none" ? "!" : "");
    row.appendChild(flag);
    var detail = batchDetail(b);
    row.addEventListener("click", function () {
      var open = detail.classList.toggle("hidden") === false;
      row.classList.toggle("open", open);
    });
    wrap.appendChild(row);
    wrap.appendChild(detail);
    return wrap;
  }

  /* 折叠区：整页 OCR 原文 + 行坐标 / 分题结果（默认折叠，只用于排查） */
  function batchCollapsible(parent, title, buildBody) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "explain-btn";
    btn.textContent = title + " ▾";
    var body = document.createElement("div");
    body.className = "explain-body hidden";
    buildBody(body);
    btn.addEventListener("click", function () {
      var open = body.classList.toggle("hidden") === false;
      btn.textContent = title + (open ? " ▴" : " ▾");
    });
    parent.appendChild(btn);
    parent.appendChild(body);
    return body;
  }

  function appendBatchTools(state) {
    var tools = $("batch-tools");
    tools.innerHTML = "";
    var again = document.createElement("button");
    again.type = "button";
    again.className = "barbtn primary";
    again.textContent = "重新拍摄";
    again.style.marginBottom = "12px";
    again.addEventListener("click", function () { startBatchPageSearch(); });
    tools.appendChild(again);

    batchCollapsible(tools, "查看整页 OCR 文字", function (body) {
      var sec = document.createElement("div");
      sec.className = "explain-sec";
      var head = document.createElement("p");
      head.className = "explain-text";
      head.textContent = "共 " + state.lines.length + " 行（含坐标）";
      sec.appendChild(head);
      state.lines.slice(0, 200).forEach(function (l) {
        var p = document.createElement("p");
        p.className = "batch-ocr-line";
        var coord = (l.top === undefined || l.top === null)
          ? ""
          : ("  [" + Math.round(l.left) + "," + Math.round(l.top) + "→" + Math.round(l.right) + "," + Math.round(l.bottom) + "]");
        p.textContent = l.text + coord;
        sec.appendChild(p);
      });
      var full = document.createElement("p");
      full.className = "explain-text";
      full.textContent = "—— 全文 ——\n" + (state.text || "（无）");
      sec.appendChild(full);
      body.appendChild(sec);
    });

    batchCollapsible(tools, "查看分题结果", function (body) {
      var sec = document.createElement("div");
      sec.className = "explain-sec";
      var srcName = { ocr: "ocr", repaired: "repaired（序列校正）", inferred: "inferred", unknown: "unknown（无题号）" };
      state.out.blocks.forEach(function (b, i) {
        var p = document.createElement("p");
        p.className = "explain-text";
        p.textContent = "block#" + (i + 1) +
          "\nOCR题号：" + (b.rawScreenNumber != null ? b.rawScreenNumber : "（无）") +
          "\n最终题号：" + (b.screenNumber != null ? b.screenNumber : b.label) +
          "\n题号来源：" + (srcName[b.numberSource] || b.numberSource || "ocr") +
          "\n" + (BATCH_TYPE_NAMES[b.type] || b.type) + " ｜ y=" + Math.round(b.top || 0) + "~" + Math.round(b.bottom || 0) +
          " ｜ " + b.confidence + (b.rawScreenNumber != null && b.screenNumber != null &&
            String(b.rawScreenNumber) !== String(b.screenNumber) ? "（原识别 " + b.rawScreenNumber + " → 已校正）" : "") +
          "\n" + (b.rawText || "");
        sec.appendChild(p);
      });
      body.appendChild(sec);
    });
  }

  function renderBatchResults(state) {
    show("view-batch-results");
    lastBatch = state;
    var summary = $("batch-summary");
    var list = $("batch-list");
    var tools = $("batch-tools");
    summary.className = "batch-summary";
    summary.innerHTML = ""; list.innerHTML = ""; tools.innerHTML = "";
    var blocks = state.out.blocks;
    var textLen = MSQ.normalizeOcrText(state.text || "").length;
    /* 识别出一大堆文字却几乎没有可靠题号：不硬塞成一道题，也不给答案 */
    if (!blocks.length || (blocks.length === 1 && textLen >= 80)) {
      summary.className = "batch-summary warn";
      summary.textContent = "未能可靠识别本页题目边界，请重新拍摄";
      var tip = document.createElement("div");
      tip.className = "dim";
      tip.textContent = "（识别到 " + state.lines.length + " 行文字，" + blocks.length +
        " 个题号。可展开下方 OCR 原文与行坐标排查）";
      summary.appendChild(tip);
      appendBatchTools(state);
      return;
    }
    var conf = { high: 0, medium: 0, low: 0, none: 0 };
    blocks.forEach(function (b) { conf[b.confidence] = (conf[b.confidence] || 0) + 1; });
    summary.textContent = "本页识别 " + blocks.length + " 道题";
    var sub = document.createElement("div");
    sub.className = "dim";
    var parts = [];
    if (conf.high) { parts.push("高 " + conf.high); }
    if (conf.medium) { parts.push("中 " + conf.medium); }
    if (conf.low) { parts.push("低 " + conf.low); }
    if (conf.none) { parts.push("无匹配 " + conf.none); }
    sub.textContent = "（置信度：" + parts.join(" · ") + " ｜ 识别 " + state.ocrMs + "ms · 分题 " +
      state.splitMs + "ms · 匹配 " + state.matchMs + "ms · 合计 " + state.totalMs + "ms）";
    summary.appendChild(sub);
    blocks.forEach(function (b) { list.appendChild(batchRow(b)); });
    appendBatchTools(state);
  }

  async function startBatchPageSearch() {
    var Camera = getPlugin("Camera");
    var Ocr = getPlugin("Ocr");
    if (!Camera || !Ocr) {
      show("view-batch-photo");
      setBatchStatus(photoPluginMissingMessage(Camera, Ocr));
      return;
    }
    setBatchStatus("正在打开相机…");
    var photo;
    try {
      photo = await Camera.getPhoto({
        quality: 85,
        width: 2000,
        resultType: "dataUrl",
        source: "CAMERA",
        saveToGallery: false,
        allowEditing: false
      });
    } catch (e) {
      var msg = String((e && e.message) || e);
      setBatchStatus(/permission|denied/i.test(msg)
        ? "无法使用相机，请授予相机权限后重试"
        : "未拍摄照片（" + msg.slice(0, 40) + "）");
      return;
    }
    setBatchStatus("正在识别整页文字…");
    var totalStart = performance.now();
    var ocrMs = 0, text = "", lines = [];
    try {
      var b64 = String(photo.dataUrl || "").split(",")[1] || "";
      var res = await Ocr.recognizeText({ base64: b64 });
      text = (res && res.text) || "";
      ocrMs = (res && res.ms) || 0;
      lines = normalizeOcrLines(res);
    } catch (e) {
      setBatchStatus("识别失败，请重新拍摄（" + String((e && e.message) || e).slice(0, 40) + "）");
      return;
    }
    if (!lines.length) {
      setBatchStatus("未识别到清晰文字，请重新拍摄（尽量拍全、拍正、光线均匀）");
      return;
    }
    var tSplit = performance.now();
    MSQ.splitPageOcrLines(lines, batchPageType);
    var splitMs = Math.round(performance.now() - tSplit);
    var tMatch = performance.now();
    var out = MSQ.searchPageQuestionsByOcr(batchIndex, lines, batchPageType, { limit: 3 });
    var matchMs = Math.round(performance.now() - tMatch);
    setBatchStatus("识别完成（全程本地，图片不保存不上传）");
    renderBatchResults({
      lines: lines, text: text, ocrMs: ocrMs, splitMs: splitMs, matchMs: matchMs,
      totalMs: Math.round(performance.now() - totalStart), out: out, pageType: batchPageType
    });
  }

  /* 整页结果 → 整页拍照 → 搜题 → 首页 */
  function handleBatchResultsBack() {
    show("view-batch-photo");
    renderBatchTypes();
  }

  function handleBatchBack() {
    show("view-search");
  }

  /* ---------------- 清除记录 ---------------- */
  function clearRecords() {
    Modal.confirm("清除学习记录",
      "将删除全部作答统计、错题本和刷题进度，且不可恢复。\n确定清除吗？",
      function () {
        Modal.confirm("再次确认", "真的要清除所有学习记录吗？此操作无法撤销！",
          function () {
            Store.clear(); renderMenu();
            Modal.alert("完成", "学习记录已清除。");
          }, { danger: true, okText: "确认清除" });
      }, { danger: true, okText: "继续" });
  }

  /* ---------------- 滑动换题（横向 + 纵向，不影响正常上下滚动） ---------------- */
  function bindSwipe() {
    var ts = null;
    var area = $("view-quiz");
    area.addEventListener("touchstart", function (e) {
      var t = e.changedTouches[0];
      var sc = $("quiz-scroll");
      ts = { x: t.clientX, y: t.clientY, t: Date.now(), top: sc ? sc.scrollTop : 0 };
    }, { passive: true });
    area.addEventListener("touchend", function (e) {
      if (!ts) { return; }
      var t = e.changedTouches[0];
      var sc = $("quiz-scroll");
      var dx = t.clientX - ts.x, dy = t.clientY - ts.y, dt = Date.now() - ts.t;
      var scrolled = Math.abs((sc ? sc.scrollTop : 0) - ts.top);
      ts = null;
      if (Modal.isOpen()) { return; }
      // 判定在 core.resolveSwipe：横向保持原规则；纵向要求快速明显滑动
      // 且手势期间页面未发生明显滚动（>=32px 优先视为滚动），避免与长题干滚动冲突
      var dir = MSQ.resolveSwipe(dx, dy, dt, scrolled);
      if (dir === "next") { goNext(); }
      else if (dir === "prev") { goPrev(); }
    }, { passive: true });
  }

  /* ---------------- 键盘（桌面浏览器辅助） ---------------- */
  function bindKeys() {
    document.addEventListener("keydown", function (e) {
      if (Modal.isOpen() || !$("view-quiz") || $("view-quiz").classList.contains("hidden")) { return; }
      var q = null;
      try { q = currentQ(); } catch (err) { return; }
      if (!q) { return; }
      if (e.key >= "1" && e.key <= "6") {
        onOptionTap(q, parseInt(e.key, 10) - 1);
      } else if (e.key === "ArrowLeft") { goPrev(); }
      else if (e.key === "ArrowRight") { goNext(); }
      else if (e.key === "Enter") {
        if (P && q.type === "multi" && !(P.session[q.id] || {}).submitted) { submitPractice(); }
        else { goNext(); }
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function loadBank() {
    if (window.QUESTIONS_DATA && Array.isArray(window.QUESTIONS_DATA.questions)) {
      return Promise.resolve(window.QUESTIONS_DATA);   // 内联加载（file:// 也可用）
    }
    return fetch("data/questions.json").then(function (r) { return r.json(); });
  }

  function registerSW() {
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () { });
      });
    }
  }

  function bindEvents() {
    $("btn-back").addEventListener("click", handleQuizBack);
    $("btn-prev").addEventListener("click", goPrev);
    $("btn-next").addEventListener("click", goNext);
    $("btn-submit").addEventListener("click", submitPractice);
    $("btn-jump").addEventListener("click", openJump);
    $("btn-handin").addEventListener("click", handin);
    $("btn-review-back").addEventListener("click", handleReviewBack);
    $("btn-settings").addEventListener("click", function () { Modal.settings(); });
    $("btn-clear").addEventListener("click", clearRecords);
    $("explain-toggle").addEventListener("click", function () {
      if (!curExplain) { return; }
      explainOpen = !explainOpen;
      applyExplainState();
    });
    // 搜题
    $("btn-search-back").addEventListener("click", handleSearchBack);
    $("btn-detail-back").addEventListener("click", handleSearchDetailBack);
    $("btn-photo-search").addEventListener("click", function () {
      var Camera = getPlugin("Camera");
      var Ocr = getPlugin("Ocr");
      if (!Camera || !Ocr) {
        show("view-photo");
        setPhotoStatus(photoPluginMissingMessage(Camera, Ocr));
        return;
      }
      startPhotoSearch();
    });
    $("btn-take-photo").addEventListener("click", startPhotoSearch);
    $("btn-photo-back").addEventListener("click", handlePhotoBack);
    $("btn-batch-photo").addEventListener("click", function () {
      var Camera = getPlugin("Camera");
      var Ocr = getPlugin("Ocr");
      openBatchPhoto();
      if (!Camera || !Ocr) { setBatchStatus(photoPluginMissingMessage(Camera, Ocr)); }
    });
    $("btn-batch-back").addEventListener("click", handleBatchBack);
    $("btn-batch-results-back").addEventListener("click", handleBatchResultsBack);
    $("btn-take-page").addEventListener("click", startBatchPageSearch);
    initBatchTypes();
    var searchInput = $("search-input");
    searchInput.addEventListener("input", function () {
      clearTimeout(searchDebounceTimer);
      var v = searchInput.value;
      searchDebounceTimer = setTimeout(function () { doSearch(v); }, 60);
      if (!v.trim()) { renderHistory(); }
    });
    searchInput.addEventListener("blur", function () { searchInputBlurAt = Date.now(); });
    initSearchFilters();
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(searchDebounceTimer);
        doSearch(searchInput.value);
        pushHistory(searchInput.value);
      }
    });
    bindSwipe();
    bindKeys();
  }

  Store.load();
  Modal.init();
  loadBank().then(function (data) {
    bank = data;
    byType = MSQ.indexByType(bank.questions);
    searchIndex = MSQ.buildSearchIndex(bank.questions);
    photoIndex = MSQ.buildOcrIndex(bank.questions);
    batchIndex = MSQ.buildBatchOcrIndex(bank.questions);
    bindEvents();
    renderMenu();
    registerSW();
    registerSystemBack();
  }).catch(function (err) {
    document.body.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "padding:48px 24px;text-align:center;font-size:16px;line-height:1.8";
    box.innerHTML = "";
    var h = document.createElement("p");
    h.style.fontWeight = "700";
    h.textContent = "尚未找到题库数据";
    var p = document.createElement("p");
    p.textContent = "本仓库不附带题库。请先运行：python -X utf8 tools/import_xlsx.py <你的题库.xlsx> 生成 www/data/questions.json 后刷新本页。" +
      (err && err.message ? "（" + err.message + "）" : "");
    box.appendChild(h);
    box.appendChild(p);
    document.body.appendChild(box);
  });
})();
