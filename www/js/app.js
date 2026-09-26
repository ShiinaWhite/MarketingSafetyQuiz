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
    var toggle = $("explain-toggle");
    toggle.innerHTML = (open ? "收起解析与记忆技巧" : "查看解析与记忆技巧") +
      (typeof MSQIcons !== "undefined" ? MSQIcons.svg("chevronDown") : "");
    toggle.classList.toggle("open", open);
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
    onClose: null,   /* 当前弹窗关闭回调（VC16：启动更新 Modal 用 Back 关闭 = 稍后） */
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
    close: function () {
      this.root.classList.add("hidden");
      this.root.innerHTML = "";
      if (this.onClose) {
        var cb = this.onClose;
        this.onClose = null;
        cb();
      }
    },
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

  /* ---------------- 主菜单（UI_DESIGN_V1：品牌区 + 搜题主入口 + 降级统计 + 练习模式） ---------------- */
  function homeStat(value, label) {
    var d = document.createElement("div");
    d.className = "home-stat";
    var b = document.createElement("b");
    b.textContent = String(value);
    var s = document.createElement("span");
    s.textContent = label;
    d.appendChild(b); d.appendChild(s);
    return d;
  }

  function renderMenu() {
    var total = bank.questions.length;
    var t = Store.totals();

    var box = $("menu-buttons");
    box.innerHTML = "";
    // 搜题入口（VC16_UI_POLISH_V1：首页只保留搜题；拍摄走搜题页搜索框右侧相机钮，
    // 仍然直拍 → OCR → AUTO → 结果，无中转页。UI_DESIGN_V1：入口为图标 + 文字卡片）
    if (!$("btn-search-entry")) {
      var searchWrap = document.createElement("div");
      searchWrap.className = "search-entry-wrap";
      var searchBtn = document.createElement("button");
      searchBtn.type = "button";
      searchBtn.id = "btn-search-entry";
      searchBtn.className = "search-entry";
      searchBtn.innerHTML = (typeof MSQIcons !== "undefined" ? MSQIcons.svg("search") : "") +
        "<span>搜题</span>";
      searchBtn.addEventListener("click", openSearch);
      searchWrap.appendChild(searchBtn);
      var entryWrap = $("search-entry-wrap") || box.parentNode;
      entryWrap.appendChild(searchWrap);
    }
    /* 统计行：视觉降级为展示性数据，不抢主入口 */
    var stats = $("menu-stats");
    if (stats) {
      stats.innerHTML = "";
      stats.appendChild(homeStat(total, "题库题数"));
      stats.appendChild(homeStat(t.a, "累计作答"));
      stats.appendChild(homeStat(Store.data.wrong.length, "错题本"));
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
              var paintExplainBtn = function (open) {
                eb.innerHTML = (open ? "收起解析与记忆技巧" : "查看解析与记忆技巧") +
                  (typeof MSQIcons !== "undefined" ? MSQIcons.svg("chevronDown") : "");
                eb.classList.toggle("open", open);
              };
              paintExplainBtn(false);
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
                paintExplainBtn(open);
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
    /* 空状态：无关键词时展示引导（有历史时历史卡片同时可见） */
    var emptyEl = $("search-empty");
    if (emptyEl) { emptyEl.classList.toggle("hidden", q !== ""); }
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
      /* UI_DESIGN_V1：题型 badge + 题库号 badge + 题干（mark）+ 命中选项 */
      var meta = document.createElement("div");
      meta.className = "search-meta";
      var typeBadge = document.createElement("span");
      typeBadge.className = "u-badge primary";
      typeBadge.textContent = r.type_name;
      meta.appendChild(typeBadge);
      var idBadge = document.createElement("span");
      idBadge.className = "u-badge";
      idBadge.textContent = "第 " + r.id + " 题";
      meta.appendChild(idBadge);
      item.appendChild(meta);
      var stemEl = document.createElement("div");
      stemEl.className = "s-stem";
      renderHighlighted(stemEl, r.stem, q);
      item.appendChild(stemEl);
      if (r.hitOption) {
        var optEl = document.createElement("div");
        optEl.className = "s-opt";
        if (typeof MSQIcons !== "undefined") {
          optEl.appendChild(MSQIcons.el("check", "s-opt-icon"));
        }
        var optText = document.createElement("span");
        optText.textContent = "命中选项：" + r.hitOption;
        optEl.appendChild(optText);
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
  /* 详情来源上下文：详情页被复用于多个父页面（文字搜题 / 整页答案 Top3 候选），
     返回时据此回到正确的父页面，不再写死 detail → search。
     batchScrollTop/batchWindowY：进入详情前整页答案的滚动位置。实际滚动通道随
     CSS 而定（.view 为 min-height:100vh 时 window 滚动；若容器限高则容器滚动），
     两个通道都保存、都恢复。display:none 往返会丢失 scrollTop，必须显式恢复。 */
  var detailReturnContext = { source: "search", batchScrollTop: 0, batchWindowY: 0 };

  function openSearchDetail(id, source) {
    var q = null;
    bank.questions.forEach(function (x) { if (x.id === id) { q = x; } });
    if (!q) { return; }
    var body = $("search-detail-body");
    body.innerHTML = "";
    /* UI_DESIGN_V1：题型 badge + 题库号 → 题干卡 → 选项卡（正确项 success）→ 答案条 */
    var meta = document.createElement("div");
    meta.className = "detail-type";
    var typeBadge = document.createElement("span");
    typeBadge.className = "u-badge primary";
    typeBadge.textContent = MSQ.TYPE_NAMES[q.type];
    meta.appendChild(typeBadge);
    var idSpan = document.createElement("span");
    idSpan.className = "detail-id";
    idSpan.textContent = "第 " + q.id + " 题 · 题库原题";
    meta.appendChild(idSpan);
    body.appendChild(meta);
    var stemCard = document.createElement("div");
    stemCard.className = "stem";
    stemCard.textContent = q.stem;
    body.appendChild(stemCard);
    var optList = document.createElement("div");
    optList.className = "opt-list";
    q.options.forEach(function (opt, i) {
      var isAns = q.answer.indexOf(i) >= 0;
      var row = document.createElement("div");
      row.className = "opt-row" + (isAns ? " correct" : "");
      var tag = document.createElement("span");
      tag.className = "letter";
      tag.textContent = MSQ.LETTERS[i] + ".";
      row.appendChild(tag);
      var text = document.createElement("span");
      text.className = "opt-text";
      text.textContent = opt;
      row.appendChild(text);
      if (isAns && typeof MSQIcons !== "undefined") {
        row.appendChild(MSQIcons.el("check", "opt-check"));
      }
      optList.appendChild(row);
    });
    body.appendChild(optList);
    var ans = document.createElement("div");
    ans.className = "answer-strip";
    if (typeof MSQIcons !== "undefined") { ans.appendChild(MSQIcons.el("check")); }
    var ansLabel = document.createElement("span");
    ansLabel.textContent = "正确答案";
    ans.appendChild(ansLabel);
    var ansVal = document.createElement("span");
    ansVal.className = "ans";
    ansVal.textContent = MSQ.answerText(q);
    ans.appendChild(ansVal);
    body.appendChild(ans);
    detailReturnContext.source = (source === "batch-results") ? "batch-results" : "search";
    if (detailReturnContext.source === "batch-results") {
      var batchScroll = $("batch-scroll");
      detailReturnContext.batchScrollTop = batchScroll ? batchScroll.scrollTop : 0;
      detailReturnContext.batchWindowY = window.pageYOffset || 0;
    }
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

  /* 搜题详情返回：按来源回父页面。整页答案场景下 batch results DOM 从未销毁
     （show 只切换 hidden class），不重渲染、不重算，只恢复导航与滚动位置。
     左上角返回按钮与 Android 系统 Back（handleBack）共用本函数。 */
  function handleSearchDetailBack() {
    if (detailReturnContext.source === "batch-results") {
      show("view-batch-results");
      var y = detailReturnContext.batchScrollTop || 0;
      var wy = detailReturnContext.batchWindowY || 0;
      var el = $("batch-scroll");
      if (el) { el.scrollTop = y; }
      window.scrollTo(0, wy);
      requestAnimationFrame(function () {
        /* 下一帧复核一次：防显示切换当帧布局未稳定导致恢复值被截断 */
        if (el && Math.abs(el.scrollTop - y) > 2) { el.scrollTop = y; }
        if (Math.abs((window.pageYOffset || 0) - wy) > 2) { window.scrollTo(0, wy); }
      });
      return;
    }
    detailReturnContext.source = "search";
    show("view-search");
  }

  /* 统一返回入口：系统 Back 与各页返回按钮共用同一套分层。
     Modal 打开时优先关闭弹窗（只取消/关闭，绝不触发确定/删除/交卷）。
     首页无更上一层：交给 Android 常规行为退出。 */
  function handleBack() {
    if (Modal.isOpen()) { Modal.close(); return; }
    switch (currentViewId()) {
      case "view-search-detail": handleSearchDetailBack(); return;
      case "view-update": handleUpdateBack(); return;
      case "view-devdiag": openUpdateView(); return;
      case "view-batch-results": handleBatchResultsBack(); return;
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

  /* ---------------- 整页拍照搜题（SIMPLIFY_CAPTURE_FLOW_V1 收口后的唯一相机主链） ----------------
     首页相机按钮 / 搜题页 📷 → Camera.getPhoto → OCR → AUTO_PAGE_TYPE →
     splitter / matcher → 结果页。无中转页、无拍摄前题型选择（固定 AUTO，
     判错后可在结果页人工切换重算）。与单题路径 searchQuestionsByOcr 仍完全独立。 */
  var batchIndex = null;
  var batchIndexById = null;      /* 采集诊断用：id -> batchIndex 项（只读） */
  var lastBatch = null;
  var lastResolvedPageType = null; /* 会话内弱先验：上一页最终采用的题型（不跨重启） */
  var lastSampleUpload = null;    /* 反馈上下文：结果页打开期间绑定当次 sampleId */
  var captureOriginView = "view-menu"; /* 相机取消时返回的入口页（menu 或 search） */

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
    /* 置信度只通过颜色表达：low 有候选答案就显示原答案（红色），
       仅 none / 真无候选时显示 ?。展示层决策见 core.pageAnswerDisplay。 */
    return MSQ.pageAnswerDisplay(b ? b.confidence : "none", b ? b.answer : "?");
  }

  var BATCH_TYPE_NAMES = { auto: "自动", single: "单选题", multi: "多选题", judge: "判断题" };
  var CONF_LABELS = { high: "高置信", medium: "中置信", low: "低置信", none: "未匹配" };
  var CONF_BADGE_CLS = { high: "success", medium: "warning", low: "danger", none: "" };

  function batchDetail(b) {
    var d = document.createElement("div");
    d.className = "batch-detail hidden";
    var add = function (label, value, valueCls) {
      var p = document.createElement("div");
      p.className = "kv";
      var k = document.createElement("span"); k.className = "k"; k.textContent = label + "：";
      var v = document.createElement("span"); v.className = "v" + (valueCls ? " " + valueCls : "");
      v.textContent = value;
      p.appendChild(k); p.appendChild(v); d.appendChild(p);
    };
    add("OCR 识别题干", b.stemText || "（无）");
    add("题库匹配", b.bankId === null ? "未匹配到" : ("第 " + b.bankId + " 题 ｜ " + (BATCH_TYPE_NAMES[b.type] || b.type)));
    if (b.answerItem) { add("参考答案", b.answer, "answer-inline"); }
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
      head.className = "cand-head";
      head.textContent = cands.length ? "Top" + cands.length + " 候选（点开看原题）" : "没有找到候选";
      d.appendChild(head);
      var list = document.createElement("div");
      list.className = "cand-list";
      cands.forEach(function (m, i) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "batch-cand";
        var rank = document.createElement("span");
        rank.className = "cand-rank";
        rank.textContent = String(i + 1);
        var stem = document.createElement("span");
        stem.className = "cand-stem";
        stem.textContent = "第" + m.id + "题 ｜ " + m.type_name + " ｜ " + m.stem.slice(0, 40);
        var score = document.createElement("span");
        score.className = "cand-score mono";
        score.textContent = String(m.score);
        btn.appendChild(rank); btn.appendChild(stem); btn.appendChild(score);
        btn.addEventListener("click", function () { openSearchDetail(m.id, "batch-results"); });
        list.appendChild(btn);
      });
      d.appendChild(list);
    }
    return d;
  }

  /* 长按标错（REAL_SAMPLE_FEEDBACK_V2）：短按仍展开/收起详情，长按只反馈。
     移动超过阈值取消计时器（滚动页面不误触）；长按后阻止合成 click。 */
  var FEEDBACK_LONG_PRESS_MS = 600;
  var FEEDBACK_MOVE_CANCEL_PX = 12;

  function bindLongPress(el, onLongPress) {
    var timer = null;
    var startX = 0;
    var startY = 0;
    /* 长按后短时间内的合成 click 抑制窗（自动过期，不吞用户下一次真实 tap） */
    var suppressClickUntil = 0;
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    el.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) {
        if (timer) { clearTimeout(timer); timer = null; }
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      timer = setTimeout(function () {
        timer = null;
        suppressClickUntil = Date.now() + 600;
        onLongPress();
      }, FEEDBACK_LONG_PRESS_MS);
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      if (!timer) { return; }
      var dx = e.touches[0].clientX - startX;
      var dy = e.touches[0].clientY - startY;
      if (dx * dx + dy * dy > FEEDBACK_MOVE_CANCEL_PX * FEEDBACK_MOVE_CANCEL_PX) {
        clearTimeout(timer);
        timer = null;
      }
    }, { passive: true });
    el.addEventListener("touchend", function (e) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();   /* 阻止长按后的合成 click */
      }
    }, { passive: false });
    el.addEventListener("touchcancel", function () {
      if (timer) { clearTimeout(timer); timer = null; }
    });
  }

  function updateRowWrongMark(rowEl, marked) {
    if (!rowEl) { return; }
    var mark = rowEl.querySelector(".batch-wrongmark");
    if (marked && !mark) {
      mark = document.createElement("span");
      mark.className = "batch-wrongmark";
      mark.textContent = "已标错";
      var host = rowEl.querySelector(".batch-row-tags") || rowEl;
      host.appendChild(mark);
    } else if (!marked && mark) {
      mark.parentNode.removeChild(mark);
    }
  }

  function showFeedbackToast(msg) {
    var toast = document.createElement("div");
    toast.className = "fb-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) { toast.parentNode.removeChild(toast); }
    }, 1600);
  }

  function batchRow(b, blockIndex) {
    var wrap = document.createElement("div");
    wrap.className = "batch-card";
    var row = document.createElement("button");
    row.type = "button";
    row.className = "batch-row";
    /* 顶行：题号 + 置信 badge +（已标错 badge）+ chevron */
    var top = document.createElement("div");
    top.className = "batch-row-top";
    var no = document.createElement("span");
    no.className = "batch-no";
    no.textContent = b.label;
    top.appendChild(no);
    var tags = document.createElement("div");
    tags.className = "batch-row-tags";
    var confBadge = document.createElement("span");
    confBadge.className = "u-badge conf-chip" + (CONF_BADGE_CLS[b.confidence] ? " " + CONF_BADGE_CLS[b.confidence] : "");
    var dot = document.createElement("span");
    dot.className = "dot";
    confBadge.appendChild(dot);
    confBadge.appendChild(document.createTextNode(CONF_LABELS[b.confidence] || b.confidence));
    tags.appendChild(confBadge);
    top.appendChild(tags);
    if (typeof MSQIcons !== "undefined") {
      top.appendChild(MSQIcons.el("chevronDown", "batch-chevron"));
    }
    row.appendChild(top);
    /* 答案行：大字答案（置信色只作用于答案）+ OCR 题干两行预览 */
    var ansRow = document.createElement("div");
    ansRow.className = "batch-answer-row";
    var ans = document.createElement("span");
    var disp = batchAnswerDisplay(b);
    ans.className = "batch-ans" + (disp.cls === "high" ? "" : " " + disp.cls);
    ans.textContent = disp.text;
    ansRow.appendChild(ans);
    var preview = document.createElement("span");
    preview.className = "batch-ocr-preview";
    preview.textContent = b.stemText || "";
    ansRow.appendChild(preview);
    row.appendChild(ansRow);
    var detail = batchDetail(b);
    var suppressClickUntil = 0;
    row.addEventListener("click", function () {
      if (Date.now() < suppressClickUntil) { return; }   /* 长按抑制窗内的合成 click */
      var open = detail.classList.toggle("hidden") === false;
      row.classList.toggle("open", open);
    });
    bindLongPress(row, function () {
      toggleBlockFeedback(blockIndex, b, row);
    });
    wrap.appendChild(row);
    wrap.appendChild(detail);
    return wrap;
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
    /* OCR 原文 / 分题明细等调试数据不再占正式结果页 UI，
       但仍完整保存在 run.json（ocr.text/ocr.lines/blocks/Top3/scores）。 */
  }

  /* 结果页题型人工纠错（保留能力，CAP-S5）：只用已保存的 OCR lines 重跑 split +
     match，绝不重新拍照、绝不调用 Ocr.recognizeText（TYPE_SWITCH_OCR_CALLS = 0，
     test_core 有静态守卫）。mode 可为 "auto"（重新三题型试跑）或具体题型；
     拍摄本身永远固定 AUTO（CAP-S4），这里是拍后用户的有意识纠正。 */
  function switchBatchPageType(mode) {
    if (!lastBatch || !lastBatch.lines) { return; }
    var lines = lastBatch.lines;
    var tSplit = performance.now();
    MSQ.splitPageOcrLines(lines, mode === "auto" ? "single" : mode);
    var splitMs = Math.round(performance.now() - tSplit);
    var tMatch = performance.now();
    var r = MSQ.recomputePageFromLines(batchIndex, lines, mode,
      { limit: 3, previousType: lastResolvedPageType });
    var matchMs = Math.round(performance.now() - tMatch);
    lastResolvedPageType = r.resolved.type;
    /* 切题型产生新的重新计算结果：使用新 sampleId 重新采集（run.json 记录最终
       展示结果），反馈状态随新 sample 重置；旧 sample 已保存的反馈不受影响，
       也不把旧 blockIndex 映射到重新分块后的新 block。 */
    var switchState = {
      lines: lines, text: lastBatch.text, ocrMs: lastBatch.ocrMs,
      splitMs: splitMs, matchMs: matchMs, totalMs: lastBatch.ocrMs + splitMs + matchMs,
      out: r.out, pageType: r.resolved.type, pageTypeMode: mode, resolved: r.resolved,
      suggestion: null, dataUrl: lastBatch.dataUrl,
      ocrWidth: lastBatch.ocrWidth, ocrHeight: lastBatch.ocrHeight,
      sampleId: (typeof MSQSample !== "undefined" && MSQSample) ? MSQSample.makeSampleId(new Date()) : null
    };
    renderBatchResults(switchState);
    collectAndUploadSample(switchState);
  }

  /* 结果页顶部题型行：自动识别：X题 [修改] / 题型：X（手动）[切换]。
     AUTO 不确定时轻量提示并展开按钮行；手动异常时显示"更像X题"建议。 */
  function buildBatchTypeLine(state) {
    var wrap = document.createElement("div");
    wrap.className = "batch-type-line";
    var resolved = state.resolved || { type: state.pageType, method: "manual", confidence: null };
    var isAuto = state.pageTypeMode === "auto";
    var name = BATCH_TYPE_NAMES[resolved.type] || resolved.type;
    var label = document.createElement("span");
    label.className = "batch-type-label";
    label.appendChild(document.createTextNode(isAuto ? "自动识别为 " : "题型："));
    var nameB = document.createElement("b");
    nameB.textContent = name;
    label.appendChild(nameB);
    if (isAuto && resolved.confidence === "ambiguous") {
      label.appendChild(document.createTextNode("（不确定）"));
    }
    if (!isAuto) { label.appendChild(document.createTextNode("（手动）")); }
    wrap.appendChild(label);
    var row = document.createElement("div");
    row.className = "batch-type-switch hidden";
    ["auto", "single", "multi", "judge"].forEach(function (mode) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "batch-type-btn" + (state.pageTypeMode === mode ? " active" : "");
      b.textContent = BATCH_TYPE_NAMES[mode];
      b.addEventListener("click", function () { switchBatchPageType(mode); });
      row.appendChild(b);
    });
    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "linkbtn";
    editBtn.textContent = isAuto ? "修改" : "切换";
    editBtn.addEventListener("click", function () { row.classList.toggle("hidden"); });
    wrap.appendChild(editBtn);
    wrap.appendChild(row);
    if (isAuto && resolved.confidence === "ambiguous") {
      var hint = document.createElement("p");
      hint.className = "batch-hint";
      hint.textContent = "题型判断不确定，可在上方切换题型重新计算";
      wrap.appendChild(hint);
      row.classList.remove("hidden");   /* 不确定时直接展开，一键重算 */
    }
    if (state.suggestion && state.suggestion.type) {
      var sug = document.createElement("p");
      sug.className = "batch-hint";
      sug.textContent = "本页更像" + BATCH_TYPE_NAMES[state.suggestion.type] + "，";
      var apply = document.createElement("button");
      apply.type = "button";
      apply.className = "linkbtn";
      apply.textContent = "按" + BATCH_TYPE_NAMES[state.suggestion.type] + "重新计算";
      apply.addEventListener("click", function () { switchBatchPageType(state.suggestion.type); });
      sug.appendChild(apply);
      wrap.appendChild(sug);
    }
    return wrap;
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
      summary.textContent = "未能可靠识别本页题目边界，可尝试切换题型重算";
      summary.appendChild(buildBatchTypeLine(state));
      appendBatchTools(state);
      return;
    }
    var conf = { high: 0, medium: 0, low: 0, none: 0 };
    blocks.forEach(function (b) { conf[b.confidence] = (conf[b.confidence] || 0) + 1; });
    /* UI_DESIGN_V1：标题 =「N 道题已识别」+ 非零置信统计 badge。
       耗时数据不再进入普通 UI（仍完整保存在 run.json / 采集诊断）。 */
    var countN = document.createElement("span");
    countN.className = "batch-count-n";
    countN.textContent = String(blocks.length);
    var countU = document.createElement("span");
    countU.className = "batch-count-u";
    countU.textContent = " 道题已识别";
    summary.appendChild(countN);
    summary.appendChild(countU);
    var statRow = document.createElement("div");
    statRow.className = "batch-stat-row";
    [{ key: "high", cls: "success" }, { key: "medium", cls: "warning" },
     { key: "low", cls: "danger" }, { key: "none", cls: "" }].forEach(function (def) {
      if (!conf[def.key]) { return; }
      var badge = document.createElement("span");
      badge.className = "u-badge" + (def.cls ? " " + def.cls : "");
      var dot = document.createElement("span");
      dot.className = "dot";
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(CONF_LABELS[def.key] + " " + conf[def.key]));
      statRow.appendChild(badge);
    });
    summary.appendChild(statRow);
    summary.appendChild(buildBatchTypeLine(state));
    blocks.forEach(function (b, i) { list.appendChild(batchRow(b, i)); });
    appendBatchTools(state);
  }

  async function startBatchPageSearch() {
    var Camera = getPlugin("Camera");
    var Ocr = getPlugin("Ocr");
    if (!Camera || !Ocr) {
      Modal.alert("无法拍照", photoPluginMissingMessage(Camera, Ocr));
      return;
    }
    /* 相机取消时回到拍摄入口页（menu 入口 → 首页；搜题页 📷 → 搜题页） */
    captureOriginView = (currentViewId() === "view-search") ? "view-search" : "view-menu";
    var photo;
    try {
      photo = await Camera.getPhoto({
        quality: 85,
        width: 3000,   /* 分辨率扫描实测：3000px 题干字符覆盖 97%（2000px 为 88%），Top1 97.5% vs 87.5% */
        resultType: "dataUrl",
        source: "CAMERA",
        saveToGallery: false,
        allowEditing: false
      });
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (/permission|denied/i.test(msg)) {
        Modal.alert("无法使用相机", "请授予相机权限后重试");
      }
      /* 用户取消：静默回到入口页，绝不进入任何中间页 */
      show(captureOriginView);
      return;
    }
    var totalStart = performance.now();
    var ocrMs = 0, text = "", lines = [];
    var ocrWidth = 0, ocrHeight = 0;
    var dataUrl = String(photo.dataUrl || "");
    try {
      var b64 = dataUrl.split(",")[1] || "";
      var res = await Ocr.recognizeText({ base64: b64 });
      text = (res && res.text) || "";
      ocrMs = (res && res.ms) || 0;
      ocrWidth = (res && res.width) || 0;
      ocrHeight = (res && res.height) || 0;
      lines = normalizeOcrLines(res);
    } catch (e) {
      Modal.alert("识别失败", "请重新拍摄（" + String((e && e.message) || e).slice(0, 40) + "）");
      return;
    }
    if (!lines.length) {
      Modal.alert("未识别到清晰文字", "请重新拍摄（尽量拍全、拍正、光线均匀）");
      return;
    }
    var tSplit = performance.now();
    /* 独立 split 只用于计时展示；AUTO 以 single 作为计时占位默认值，正式分题在 recompute 内按判定题型进行 */
    MSQ.splitPageOcrLines(lines, "single");
    var splitMs = Math.round(performance.now() - tSplit);
    var tMatch = performance.now();
    /* AUTO_PAGE_TYPE 固定生效（CAP-S4）：拍摄前没有任何题型选择，auto 在内存中
       三题型试跑后择优；OCR 只发生一次（上方），此处纯计算 */
    var r = MSQ.recomputePageFromLines(batchIndex, lines, "auto",
      { limit: 3, previousType: lastResolvedPageType });
    var matchMs = Math.round(performance.now() - tMatch);
    var out = r.out;
    var resolved = r.resolved;
    lastResolvedPageType = resolved.type;   /* 会话内弱先验：AUTO 结论作为下一页信号 */
    var state = {
      lines: lines, text: text, ocrMs: ocrMs, splitMs: splitMs, matchMs: matchMs,
      totalMs: Math.round(performance.now() - totalStart), out: out,
      pageType: resolved.type, pageTypeMode: "auto", resolved: resolved,
      suggestion: null, dataUrl: dataUrl, ocrWidth: ocrWidth, ocrHeight: ocrHeight,
      sampleId: (typeof MSQSample !== "undefined" && MSQSample) ? MSQSample.makeSampleId(new Date()) : null
    };
    renderBatchResults(state);
    collectAndUploadSample(state);
  }

  /* 整页结果 Back → 首页（SIMPLIFY_CAPTURE_FLOW_V1：旧整页拍照中转页已删除，
     不得再回到已不存在的页面，也不留空 history entry） */
  function handleBatchResultsBack() {
    renderMenu();
  }

  /* ---------------- 样本采集旁路（SIMPLIFY_CAPTURE_FLOW_V1：纯后台 best-effort） ----------------
     普通用户不可见、不可配置、不可关闭（AUTO_SAMPLE_UPLOAD 恒 ON，无 opt-out）。
     persist → persistent queue → COS PUT → commit → PC mirror 全部在原生后台进行；
     本函数任何失败只写非敏感 console 诊断，绝不 toast/modal/banner/status，
     绝不影响 OCR、splitter、matcher、答案展示（CAP-S8/9/10）。 */
  function sampleQueuePlugin() { return getPlugin("SampleQueue"); }

  function sampleDebug(msg) { console.log("[sample] " + msg); }

  function initSampleResultTools() {
    var flag = $("btn-sample-flag");
    if (flag) { flag.addEventListener("click", toggleFeedbackPanel); }
  }

  /* 结果页只保留用户主动反馈入口；队列状态/失败计数一律不上 UI */
  function renderSampleFeedbackVisibility() {
    var flag = $("btn-sample-flag");
    if (flag) { flag.classList.toggle("hidden", !lastSampleUpload); }
    renderFeedbackButton();
  }

  function initSampleQueue() {
    var Queue = sampleQueuePlugin();
    if (!Queue) { return; }
    if (typeof Queue.setServer === "function") {
      Queue.setServer({ serverUrl: MSQSample.PUBLIC_BASE_URL });
    }
    if (typeof Queue.init === "function") {
      Queue.init({ serverUrl: MSQSample.PUBLIC_BASE_URL });
    }
    if (typeof Queue.addListener === "function") {
      Queue.addListener("sampleQueueChanged", function (stats) {
        /* 仅存内存供 DEV 隐藏诊断读取；不驱动任何普通 UI */
        window.__lastQueueStats = stats;
      });
    }
  }

  function currentFeedback() {
    return lastSampleUpload ? lastSampleUpload.feedback : null;
  }

  /* 反馈持久化：写本地队列（filesDir/sample_queue/<sampleId>/feedback.json），
     由原生 worker 在 sample 上传成功后自动补传；不做网络直传。
     SIMPLIFY_CAPTURE_FLOW_V1：用户提交动作照常表现为已记录（上方 toast），
     其后台持久化/上传失败完全静默（仅 console 诊断），不再显示保存失败。 */
  function persistFeedbackNow() {
    if (!lastSampleUpload || typeof MSQSample === "undefined" || !MSQSample) { return; }
    var sid = lastSampleUpload.sampleId;
    if (!sid) { return; }
    var Queue = sampleQueuePlugin();
    if (!(Queue && typeof Queue.persistFeedback === "function")) {
      sampleDebug("feedback persist skipped: queue unavailable");
      return;
    }
    Queue.persistFeedback({
      sampleId: sid,
      feedbackJson: JSON.stringify(
        MSQSample.buildFeedbackJson(sid, lastSampleUpload.feedback, lastSampleUpload.blockRefs))
    }).then(null, function (e) {
      sampleDebug("feedback persist failed (silent): " +
        String((e && e.code) || "error"));
    });
  }

  function renderFeedbackButton() {
    var flag = $("btn-sample-flag");
    if (!flag) { return; }
    var fb = currentFeedback();
    var done = !!(fb && (fb.pageTypes.length > 0 || Object.keys(fb.blocks).length > 0));
    flag.textContent = done ? "本页已反馈" : "反馈本页问题";
  }

  function toggleFeedbackPanel() {
    var panel = $("sample-feedback-panel");
    if (!panel || !lastSampleUpload) { return; }
    if (panel.classList.toggle("hidden") === false) {
      buildFeedbackPanel(panel);
    }
  }

  function panelHint(panel, msg) {
    var el = panel.querySelector(".fb-panel-hint");
    if (el) { el.textContent = msg || ""; }
  }

  function buildFeedbackPanel(panel) {
    var fb = currentFeedback() || { pageTypes: [] };
    panel.innerHTML = "";
    var title = document.createElement("p");
    title.className = "sample-note fb-panel-hint";
    title.textContent = "本页存在哪些问题？（可多选）";
    panel.appendChild(title);
    var selected = {};
    fb.pageTypes.forEach(function (t) { selected[t] = true; });
    MSQSample.FEEDBACK_PAGE_ISSUES.forEach(function (issue) {
      var b = document.createElement("button");
      b.type = "button";
      var paint = function (on) {
        b.className = "feedback-chip" + (on ? " active" : "");
        b.innerHTML = "";
        if (on && typeof MSQIcons !== "undefined") {
          b.appendChild(MSQIcons.el("check", "chip-check"));
        }
        b.appendChild(document.createTextNode(issue.label));
      };
      var active = !!selected[issue.type];
      paint(active);
      b.addEventListener("click", function () {
        selected[issue.type] = !selected[issue.type];
        paint(!!selected[issue.type]);
      });
      panel.appendChild(b);
    });
    panel.appendChild(document.createElement("br"));

    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "barbtn primary feedback-btn";
    submit.textContent = "提交反馈";
    submit.addEventListener("click", function () {
      var types = Object.keys(selected).filter(function (t) { return selected[t]; });
      if (!types.length || !lastSampleUpload) { panelHint(panel, "请至少选择一项"); return; }
      lastSampleUpload.feedback.pageTypes = types;
      renderFeedbackButton();
      persistFeedbackNow();
      showFeedbackToast("已记录本页问题");
      panel.classList.add("hidden");
    });
    panel.appendChild(submit);

    var clear = document.createElement("button");
    clear.type = "button";
    clear.className = "barbtn feedback-btn";
    clear.textContent = "清除本页反馈";
    clear.addEventListener("click", function () {
      if (!lastSampleUpload) { return; }
      lastSampleUpload.feedback.pageTypes = [];
      renderFeedbackButton();
      persistFeedbackNow();
      showFeedbackToast("已清除本页反馈");
      panel.classList.add("hidden");
    });
    panel.appendChild(clear);

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "linkbtn feedback-btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", function () { panel.classList.add("hidden"); });
    panel.appendChild(cancel);
  }

  function toggleBlockFeedback(blockIndex, block, rowEl) {
    if (!lastSampleUpload || !lastSampleUpload.feedback) { return; }
    var fb = lastSampleUpload.feedback;
    var key = blockIndex + ":wrong_answer";
    var nowMarked = !fb.blocks[key];
    if (nowMarked) { fb.blocks[key] = true; } else { delete fb.blocks[key]; }
    updateRowWrongMark(rowEl, nowMarked);
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* 无震动能力 */ } }
    renderFeedbackButton();
    if (nowMarked && lastSampleUpload.blockRefs) {
      lastSampleUpload.blockRefs[key] = block;   // 供 feedback.json 构建定位字段
    }
    persistFeedbackNow();
    showFeedbackToast(nowMarked ? "已标记该答案有误" : "已取消标错");
  }

  function setSampleUploadStatus(text) {
    /* SIMPLIFY_CAPTURE_FLOW_V1：样本状态对普通用户彻底不可见（占位保留防误用），
       诊断只走 sampleDebug console 通道 */
    sampleDebug("status: " + String(text || "").slice(0, 60));
  }

  /* 落盘优先（PERSISTENT_SAMPLE_UPLOAD_QUEUE_V1）：样本先持久化到
     filesDir/sample_queue/，持久化成功即 SAFE；后台上传由原生 worker 完成，
     拍题主链绝不 await 网络。AUTO_SAMPLE_UPLOAD 恒 ON：没有 opt-out 分支。 */
  function collectAndUploadSample(state) {
    renderSampleFeedbackVisibility();
    try {
      if (typeof MSQSample === "undefined" || !MSQSample || !state.sampleId) { return; }
      /* 反馈上下文先就位：即使落盘失败，用户仍可对结果页提交反馈（提交本身照常工作） */
      lastSampleUpload = {
        sampleId: state.sampleId,
        feedback: MSQSample.feedbackInitialState(),
        blockRefs: {}
      };
      var panel = $("sample-feedback-panel");
      if (panel) { panel.classList.add("hidden"); }   /* 新 sample：反馈面板收起并重置 */
      renderSampleFeedbackVisibility();
      var Queue = sampleQueuePlugin();
      if (!(Queue && typeof Queue.persistSample === "function")) {
        sampleDebug("persist skipped: queue unavailable");
        return;
      }
      var runJson;
      try {
        runJson = JSON.stringify(MSQSample.buildRunManifest({
          sampleId: state.sampleId,
          capturedAt: new Date().toISOString(),
          pageType: state.pageType,
          pageTypeMode: state.pageTypeMode,
          resolvedPageType: state.resolved ? state.resolved.type : state.pageType,
          pageTypeResolutionMethod: state.resolved ? state.resolved.method : "manual",
          autoTypeConfidence: (state.resolved && state.resolved.method !== "manual")
            ? state.resolved.confidence : undefined,
          text: state.text,
          lines: state.lines,
          out: state.out,
          ocrWidth: state.ocrWidth,
          ocrHeight: state.ocrHeight,
          timing: {
            ocrMs: state.ocrMs, splitMs: state.splitMs,
            matchMs: state.matchMs, totalMs: state.totalMs
          },
          bankById: batchIndexById
        }));
      } catch (e) {
        sampleDebug("run.json build failed (silent): " + String((e && e.name) || "error"));
        return;
      }
      Queue.persistSample({
        sampleId: state.sampleId,
        photoDataUrl: state.dataUrl,
        runJson: runJson
      }).then(null, function (e) {
        sampleDebug("persist failed (silent): " + String((e && e.code) || "error"));
      });
    } catch (e) {
      sampleDebug("collect skipped (silent): " + String((e && e.name) || "error"));
    }
  }

  /* ---------------- DEV 隐藏诊断（VC16_UI_POLISH_V1） ----------------
     入口 = 检查更新页的「当前版本：…」整行，3 秒内 7 连击；仅 DEV 构建绑定手势。
     MAIN：不绑定、不响应、不暴露（openUpdateView 内 diagnosticsChannel 早退）。
     只展示非敏感队列诊断（计数/字节/janitor 记录），绝不显示任何凭据、
     签名下载地址或服务器域名（test_core 有内容守卫）。 */
  var devDiagTaps = { count: 0, firstAt: 0 };

  /* 整行 7 连击绑定：el 是块级 <p>，整行都是点击区（DIAG-2） */
  function bindDevDiagTap(el) {
    if (!el) { return; }
    el.addEventListener("click", function () {
      var now = Date.now();
      if (now - devDiagTaps.firstAt > 3000) { devDiagTaps.count = 0; }
      if (devDiagTaps.count === 0) { devDiagTaps.firstAt = now; }
      devDiagTaps.count += 1;
      if (devDiagTaps.count >= 7) {
        devDiagTaps.count = 0;
        openDevDiagnostics();
      }
    });
  }

  function openDevDiagnostics() {
    var Queue = sampleQueuePlugin();
    if (!(Queue && typeof Queue.stats === "function")) { return; }
    renderDevDiagnostics();
    show("view-devdiag");
  }

  function renderDevDiagnostics() {
    var box = $("devdiag-body");
    var Queue = sampleQueuePlugin();
    if (!box || !(Queue && typeof Queue.stats === "function")) { return; }
    /* UI_DESIGN_V1：五组诊断卡片（样本队列/最近上传/自动清理/反馈状态/APK 下载）。
       显示层全中文（VC17：底层 enum/value/schema 不变），不含凭据/地址/域名。 */
    var fmtBytes = function (n) {
      return (typeof MSQUpdater !== "undefined" && MSQUpdater && MSQUpdater.formatBytes)
        ? MSQUpdater.formatBytes(n) : String(n) + " 字节";
    };
    var fmtAge = function (ms) {
      if (ms == null || ms < 0) { return "暂无样本"; }
      var min = Math.round(ms / 60000);
      if (min < 1) { return "不足 1 分钟"; }
      if (min < 60) { return min + " 分钟"; }
      return (Math.round(min / 6) / 10) + " 小时";
    };
    var fmtSpeed = function (bytesPerSec) {
      return bytesPerSec > 0 ? Math.round(bytesPerSec / 1024) + " KB/s" : "暂无记录";
    };
    var fmtTime = function (ts) {
      var d = new Date(ts);
      var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
      return p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
        p2(d.getHours()) + ":" + p2(d.getMinutes());
    };
    Queue.stats().then(function (st) {
      var diagPromise = (typeof Queue.getDiagnostics === "function")
        ? Queue.getDiagnostics() : Promise.resolve(null);
      return diagPromise.then(function (d) {
        var groups = [
          { title: "样本队列", rows: [] },
          { title: "最近上传", rows: [] },
          { title: "自动清理", rows: [] },
          { title: "反馈状态", rows: [] },
          { title: "APK 下载", rows: [] }
        ];
        if (st) {
          groups[0].rows.push(["待上传样本", st.pending || 0]);
          groups[0].rows.push(["等待重试", st.retryWait || 0]);
          groups[0].rows.push(["上传失败", st.failed || 0]);
          groups[0].rows.push(["需要重新绑定", st.authFailed || 0]);
          groups[0].rows.push(["队列占用空间", fmtBytes(st.pendingBytes || 0)]);
        }
        if (d) {
          groups[1].rows.push(["最近上传速度", fmtSpeed(d.lastUploadBytesPerSec)]);
          groups[1].rows.push(["最老样本等待时间", fmtAge(d.oldestSampleAgeMs)]);
          groups[2].rows.push(["上次自动清理", d.lastJanitorAt > 0 ? fmtTime(d.lastJanitorAt) : "尚未运行"]);
          groups[2].rows.push(["上次清理样本数", d.deletedSamples || 0]);
          groups[2].rows.push(["上次释放空间", fmtBytes(d.deletedBytes || 0)]);
          groups[3].rows.push(["最近反馈同步状态", MSQSample.feedbackSyncLabel(d.feedbackPendingCount),
            String(MSQSample.feedbackSyncLabel(d.feedbackPendingCount)) === "已同步" ? "ok" : "warn"]);
          groups[3].rows.push(["待同步反馈", d.feedbackPendingCount || 0]);
        } else {
          groups[1].rows.push(["诊断数据", "需升级安装包"]);
        }
        /* 最近一次更新下载链路（非敏感，仅 DEV 诊断） */
        var dl = (typeof MSQDownloadDiag !== "undefined" && MSQDownloadDiag)
          ? MSQDownloadDiag.load(typeof localStorage !== "undefined" ? localStorage : null) : null;
        if (dl) {
          groups[4].rows.push(["最近下载来源", dl.apkDownloadTransport === "cdn" ? "CDN"
            : (dl.apkDownloadTransport === "legacy" ? "Legacy 备用通道" : "未知")]);
          groups[4].rows.push(["是否发生回退", dl.apkFallbackUsed ? "是（CDN → 备用通道）" : "否"]);
          groups[4].rows.push(["回退原因", dl.apkFallbackReason || "—"]);
          groups[4].rows.push(["HTTP 状态", dl.apkHttpStatus || "—"]);
          groups[4].rows.push(["下载字节数", dl.apkDownloadBytes ? fmtBytes(dl.apkDownloadBytes) : "—"]);
          groups[4].rows.push(["下载耗时", dl.apkDownloadMs ? (Math.round(dl.apkDownloadMs / 100) / 10) + " s" : "—"]);
          groups[4].rows.push(["平均下载速度", dl.apkBytesPerSec ? Math.round(dl.apkBytesPerSec / 1024) + " KB/s" : "—"]);
          groups[4].rows.push(["CDN 缓存", dl.apkCacheStatus === "hit" ? "命中"
            : (dl.apkCacheStatus === "miss" ? "未命中" : "未知")]);
          groups[4].rows.push(["下载结果", dl.downloadOk ? "成功（已通过校验）" : "失败",
            dl.downloadOk ? "ok" : "err"]);
        }
        box.innerHTML = "";
        var banner = document.createElement("div");
        banner.className = "diag-banner";
        var devBadge = document.createElement("span");
        devBadge.className = "u-badge mono";
        devBadge.textContent = "仅开发版";
        banner.appendChild(devBadge);
        var bannerNote = document.createElement("span");
        bannerNote.className = "diag-note";
        bannerNote.textContent = "样本队列与更新链路内部诊断";
        banner.appendChild(bannerNote);
        box.appendChild(banner);
        groups.forEach(function (g) {
          if (!g.rows.length) { return; }
          var card = document.createElement("div");
          card.className = "diag-card";
          var title = document.createElement("div");
          title.className = "diag-title";
          title.textContent = g.title;
          card.appendChild(title);
          g.rows.forEach(function (r) {
            var rowEl = document.createElement("div");
            rowEl.className = "diag-kv";
            var k = document.createElement("span");
            k.className = "k";
            k.textContent = r[0];
            var v = document.createElement("span");
            v.className = "v mono" + (r[2] ? " " + r[2] : "");
            v.textContent = String(r[1]);
            rowEl.appendChild(k);
            rowEl.appendChild(v);
            card.appendChild(rowEl);
          });
          box.appendChild(card);
        });
        var actions = document.createElement("div");
        actions.className = "diag-actions";
        var bj = document.createElement("button");
        bj.type = "button";
        bj.className = "barbtn";
        bj.textContent = "立即清理";
        bj.addEventListener("click", function () {
          if (typeof Queue.runJanitorNow === "function") {
            Queue.runJanitorNow().then(renderDevDiagnostics, function () { });
          }
        });
        actions.appendChild(bj);
        var br = document.createElement("button");
        br.type = "button";
        br.className = "barbtn";
        br.textContent = "立即重试";
        br.addEventListener("click", function () {
          Queue.retryFailed().then(renderDevDiagnostics, function () { });
        });
        actions.appendChild(br);
        box.appendChild(actions);
      });
    }, function () {
      box.innerHTML = "";
      var p = document.createElement("p");
      p.className = "sample-note";
      p.textContent = "队列状态不可用";
      box.appendChild(p);
    });
  }

  /* ---------------- 应用内自更新（SELF_UPDATE_V1，仅手动"检查更新"） ----------------
     逻辑在 updater.js（纯函数），下载/校验/安装在原生 UpdatePlugin。
     级联取更新服务器：更新设置 > Sample Collector 设置 > 内置默认（当前为空）。 */
  var updateInfo = null;       /* {id, versionName, versionCode}，来自 App.getInfo() */
  var updateManifest = null;   /* 通过校验的服务器 latest.json */
  var updatePhase = "idle";    /* idle|checking|available|latest|downgrade|invalid|downloading|downloaded|needPermission|installing */
  var updateProgressBound = false;

  function updateSetError(msg) {
    var el = $("update-error");
    if (!el) { return; }
    if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
    else { el.classList.add("hidden"); }
  }

  function updateButton(label, id, handler, primary) {
    var b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "barbtn" + (primary ? " primary" : "");
    b.textContent = label;
    b.addEventListener("click", handler);
    return b;
  }

  function updateActions() {
    var wrap = document.createElement("div");
    wrap.className = "update-actions";
    return wrap;
  }

  function updateStatusLine(text) {
    var status = document.createElement("p");
    status.className = "dim";
    status.textContent = text || "";
    return status;
  }

  function updateHero(latestName, currentName) {
    var hero = document.createElement("div");
    hero.className = "update-hero";
    var icon = document.createElement("div");
    icon.className = "hero-icon";
    icon.innerHTML = (typeof MSQIcons !== "undefined") ? MSQIcons.svg("download") : "";
    hero.appendChild(icon);
    var t = document.createElement("p");
    t.className = "t";
    t.textContent = "发现新版本";
    hero.appendChild(t);
    var v = document.createElement("p");
    v.className = "v";
    v.appendChild(document.createTextNode("当前 " + currentName + " · 最新 "));
    var b = document.createElement("b");
    b.textContent = latestName;
    v.appendChild(b);
    hero.appendChild(v);
    return hero;
  }

  function updateKvRow(k, v, opts) {
    var row = document.createElement("div");
    row.className = "kv-row";
    var kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    var vEl = document.createElement("span");
    vEl.className = "v" + (opts && opts.mono ? " mono" : "") + (opts && opts.strong ? " strong" : "");
    vEl.textContent = v;
    row.appendChild(kEl);
    row.appendChild(vEl);
    return row;
  }

  function renderUpdateView(statusText) {
    var body = $("update-body");
    if (!body) { return; }
    body.innerHTML = "";
    /* 有新版：Hero + 版本 KV 卡 + 更新说明 + 下载安装 */
    if (updatePhase === "available" && updateManifest && updateInfo) {
      body.appendChild(updateHero(updateManifest.versionName, updateInfo.versionName));
      var card = document.createElement("div");
      card.className = "card kv-card";
      card.appendChild(updateKvRow("当前版本", updateInfo.versionName));
      var latestRow = updateKvRow("最新版本", updateManifest.versionName, { strong: true });
      var tag = document.createElement("span");
      tag.className = "u-badge primary ver-tag";
      tag.textContent = "可更新";
      latestRow.querySelector(".v").appendChild(tag);
      card.appendChild(latestRow);
      card.appendChild(updateKvRow("更新包大小",
        (typeof MSQUpdater !== "undefined") ? MSQUpdater.formatBytes(updateManifest.size)
          : String(updateManifest.size), { mono: true }));
      body.appendChild(card);
      if (updateManifest.notes) {
        var notesCard = document.createElement("div");
        notesCard.className = "card notes-card";
        var notesH = document.createElement("div");
        notesH.className = "notes-h";
        notesH.textContent = "更新内容";
        notesCard.appendChild(notesH);
        var notesBody = document.createElement("div");
        notesBody.className = "notes-body";
        notesBody.textContent = updateManifest.notes;
        notesCard.appendChild(notesBody);
        body.appendChild(notesCard);
      }
      var actions = updateActions();
      actions.appendChild(updateButton("下载安装", "btn-update-download",
        function () { startUpdateDownload(); }, true));
      body.appendChild(actions);
      return;
    }
    /* 下载中：线性进度 + 状态行 */
    if (updatePhase === "downloading") {
      var wrap = document.createElement("div");
      wrap.className = "update-progress";
      var track = document.createElement("div");
      track.className = "progress-track";
      var fill = document.createElement("div");
      fill.className = "progress-fill";
      var m = /(\d+)%/.exec(statusText || "");
      fill.style.width = (m ? parseInt(m[1], 10) : 0) + "%";
      track.appendChild(fill);
      wrap.appendChild(track);
      wrap.appendChild(updateStatusLine(statusText));
      body.appendChild(wrap);
      return;
    }
    /* 通用状态行 */
    if (statusText === "已经是最新版") {
      var ok = document.createElement("div");
      ok.className = "ok-line";
      if (typeof MSQIcons !== "undefined") { ok.appendChild(MSQIcons.el("check")); }
      ok.appendChild(document.createTextNode("已经是最新版"));
      body.appendChild(ok);
    } else if (statusText) {
      body.appendChild(updateStatusLine(statusText));
    }
    if (updatePhase === "needPermission") {
      var permActions = updateActions();
      permActions.appendChild(updateButton("打开安装权限设置", "btn-update-perm",
        function () { openInstallPermissionSettings(); }, true));
      permActions.appendChild(updateButton("继续安装", "btn-update-install",
        function () { installUpdate(); }));
      body.appendChild(permActions);
      return;
    }
    if (updatePhase === "downloaded") {
      var dlActions = updateActions();
      dlActions.appendChild(updateButton("安装更新", "btn-update-install",
        function () { installUpdate(); }, true));
      body.appendChild(dlActions);
      return;
    }
    if (updateInfo && updatePhase !== "checking" && updatePhase !== "installing") {
      var idleActions = updateActions();
      idleActions.appendChild(updateButton("检查更新", "btn-update-check",
        function () { checkForUpdate(); }, true));
      body.appendChild(idleActions);
    }
  }

  /* autostart=true：VC16 启动 Modal 的「立即更新」入口 —— 打开页面后自动跑一次
     既有 checkForUpdate()，直接落到 available/下载安装状态（同一套下载安装链） */
  function openUpdateView(autostart) {
    show("view-update");
    updateSetError("");
    updatePhase = "idle";
    renderUpdateView("正在读取应用信息…");
    var App = getPlugin("App");
    if (!(App && typeof App.getInfo === "function")) {
      renderUpdateView("当前环境不支持应用内更新（无 Capacitor App 插件，浏览器调试模式）");
      return;
    }
    App.getInfo().then(function (info) {
      updateInfo = {
        id: info.id,
        versionName: info.version,
        versionCode: parseInt(info.build, 10) || 0
      };
      renderUpdateView("当前版本：" + updateInfo.versionName +
        "（versionCode " + updateInfo.versionCode + "）");
      /* VC16：DEV 隐藏诊断入口 = 「当前版本」整行 7 连击（仅 DEV 构建绑定）。
         整行 <p> 是块级元素，全宽可点（DIAG-2）；MAIN 直接跳过，不绑不响应。 */
      if (typeof MSQSample !== "undefined" && MSQSample &&
          MSQSample.diagnosticsChannel(updateInfo.id) === "dev") {
        var statusEl = $("update-body").querySelector("p.dim");
        bindDevDiagTap(statusEl);
      }
      if (autostart === true) { checkForUpdate(); }
    }, function () {
      renderUpdateView("无法读取应用信息");
    });
  }

  function updateResolvedServer() {
    if (typeof MSQUpdater === "undefined" || !MSQUpdater) { return null; }
    return MSQUpdater.resolveUpdateServer(MSQUpdater.loadSettings(), MSQUpdater.PUBLIC_BASE_URL);
  }

  function checkForUpdate() {
    if (!updateInfo || typeof MSQUpdater === "undefined") { return; }
    updatePhase = "checking";
    updateSetError("");
    renderUpdateView("正在检查更新…");
    var channel = MSQUpdater.updateChannelFor(updateInfo.id);
    if (!channel) {
      updatePhase = "invalid";
      updateSetError("当前应用渠道不支持应用内更新");
      renderUpdateView("");
      return;
    }
    var server = updateResolvedServer();
    var fetchJson = (typeof MSQSample !== "undefined" && MSQSample && MSQSample.getJSON)
      ? MSQSample.getJSON(server + "/api/update/" + channel + "/latest", 10000)
      : Promise.reject(new Error("无传输层"));
    fetchJson.then(function (manifest) {
      var v = MSQUpdater.validateManifest(manifest, {
        channel: channel,
        packageName: updateInfo.id
      });
      if (!v.ok) {
        updatePhase = "invalid";
        updateSetError(v.error);
        renderUpdateView("");
        return;
      }
      updateManifest = manifest;
      var state = MSQUpdater.checkUpdateState(updateInfo.versionCode, manifest);
      if (state === "available") {
        updatePhase = "available";
        renderUpdateView("");
      } else if (state === "latest") {
        updatePhase = "latest";
        renderUpdateView("已经是最新版");
      } else {
        updatePhase = "downgrade";
        updateSetError("服务器上的版本不高于当前版本，暂不更新");
        renderUpdateView("");
      }
    }, function () {
      updatePhase = "invalid";
      updateSetError("无法连接更新服务器，请确认电脑和手机在同一局域网且接收器已启动");
      renderUpdateView("");
    });
  }

  function updateFriendlyError(e) {
    var code = e && e.code ? String(e.code) : "";
    var msg = String((e && e.message) || e || "未知错误");
    if (code === "SHA_MISMATCH") { return "更新包校验失败（SHA256 不一致），已删除下载文件"; }
    if (code === "SIGNER_MISMATCH") { return "更新包签名不一致，已拒绝安装"; }
    if (code === "PACKAGE_MISMATCH") { return "更新包与应用不匹配，已拒绝安装"; }
    if (code === "VERSION_MISMATCH") { return "更新包版本与发布信息不一致"; }
    if (code === "TOO_LARGE") { return "更新包超过大小上限"; }
    if (code === "NO_UPDATE") { return "没有已下载的更新包，请重新下载"; }
    return "下载失败（" + msg.slice(0, 60) + "）";
  }

  function startUpdateDownload() {
    var Update = getPlugin("UpdatePlugin");
    if (!Update || !updateManifest || !updateInfo) { return; }
    var url = MSQUpdater.resolveApkUrl(updateResolvedServer(), updateManifest.apkUrl);
    if (!url) { updateSetError("下载地址无效"); return; }
    updatePhase = "downloading";
    updateSetError("");
    renderUpdateView("正在下载 0%");
    /* APK_CDN_STABILITY_DIAG_V1：非敏感下载诊断（只进 DEV 诊断页） */
    var diagStore = (typeof localStorage !== "undefined") ? localStorage : null;
    var diag = (typeof MSQDownloadDiag !== "undefined") ? MSQDownloadDiag : null;
    var firstFailureReason = null;
    if (typeof Update.addListener === "function" && !updateProgressBound) {
      updateProgressBound = true;
      Update.addListener("updateDownloadProgress", function (p) {
        if (updatePhase !== "downloading") { return; }
        var pct = (p && p.percent) ? p.percent : 0;
        var txt = "正在下载 " + pct + "%";
        if (p && p.totalBytes) {
          txt += "（" + MSQUpdater.formatBytes(p.downloadedBytes) + " / " +
            MSQUpdater.formatBytes(p.totalBytes) + "）";
        }
        renderUpdateView(txt);
      });
    }
    var attemptDownload = function (currentUrl, isFallback) {
      var transport = isFallback ? "legacy" : "cdn";
      Update.downloadUpdate({
        url: currentUrl,
        sha256: updateManifest.sha256,
        expectedPackageName: updateInfo.id,
        expectedVersionCode: updateManifest.versionCode,
        expectedSize: updateManifest.size
      }).then(function (res) {
        if (diag) {
          diag.save(diagStore, diag.buildSuccessRecord({
            transport: transport,
            fallbackUsed: isFallback,
            fallbackReason: firstFailureReason,
            result: res || {}
          }));
        }
        afterDownloadVerified();
      }, function (e) {
        if (diag) {
          diag.save(diagStore, diag.buildFailureRecord({
            transport: transport,
            fallbackUsed: isFallback,
            error: e
          }));
          if (!firstFailureReason) {
            firstFailureReason = diag.fallbackReasonOf(e);
          }
        }
        /* APK_DELIVERY_COS_CDN_VC13_V1：仅明确传输层失败才回退 legacy 通道一次；
           安全校验失败（SHA/size/package/version/signer/解析）= HARD FAIL，
           绝不“换通道再试” */
        var fallbackUrl = (!isFallback && updateManifest.fallbackApkUrl &&
                           MSQUpdater.shouldTryFallback(e))
          ? MSQUpdater.fallbackApkUrlFor(updateManifest, updateResolvedServer()) : null;
        if (fallbackUrl && fallbackUrl !== currentUrl) {
          renderUpdateView("CDN 通道失败，改用备用通道…");
          attemptDownload(fallbackUrl, true);
          return;
        }
        updatePhase = "available";
        updateSetError(updateFriendlyError(e));
        renderUpdateView("下载未完成，可重新下载安装");
      });
    };
    attemptDownload(url, false);
  }

  function afterDownloadVerified() {
    var Update = getPlugin("UpdatePlugin");
    updatePhase = "downloaded";
    if (!(Update && typeof Update.canInstallUpdates === "function")) {
      renderUpdateView("下载校验通过");
      return;
    }
    Update.canInstallUpdates().then(function (r) {
      if (r && r.canInstall) {
        renderUpdateView("下载校验通过，可安装");
      } else {
        updatePhase = "needPermission";
        renderUpdateView("需要允许本应用安装更新包（系统安全机制，仅此一次授权）");
      }
    }, function () {
      renderUpdateView("下载校验通过");
    });
  }

  function openInstallPermissionSettings() {
    var Update = getPlugin("UpdatePlugin");
    if (!(Update && typeof Update.openInstallPermissionSettings === "function")) { return; }
    Update.openInstallPermissionSettings().then(function () { }, function () { });
  }

  function installUpdate() {
    var Update = getPlugin("UpdatePlugin");
    if (!(Update && typeof Update.installDownloadedUpdate === "function")) { return; }
    if (!updateManifest || !updateInfo) { return; }
    updatePhase = "installing";
    /* 安装前原生侧会对最终文件做第二次全量校验（SHA256/包名/versionCode/签名） */
    Update.installDownloadedUpdate({
      sha256: updateManifest.sha256,
      expectedPackageName: updateInfo.id,
      expectedVersionCode: updateManifest.versionCode
    }).then(function (r) {
      renderUpdateView("已调起系统安装器（" + (r && r.versionName || updateManifest.versionName) +
        "），请在系统界面确认更新；安装完成后重新打开应用");
    }, function (e) {
      updatePhase = "downloaded";
      updateSetError(updateFriendlyError(e));
      renderUpdateView("");
    });
  }

  /* ---------------- 启动自动检查更新（STARTUP_UPDATE_CHECK_V1 + VC17 提前并行） ----------------
     编排与决策在 startup-update.js（可测纯逻辑）；manifest 获取/校验/版本比较/
     更新提示 UI/下载/校验/安装全部复用手动"检查更新"的同一条路径，无第二套 updater。
     每个 App process / WebView 生命周期只自动检查一次；任何失败完全静默。
     VC17：trigger 在 bootstrap 期立即执行（与 loadBank 并行）；startupUiReady 在
     主菜单渲染完成后置位，此前检查结果暂存在 controller 内，就绪后立即展示。 */
  var startupUiReady = false;
  var startupUpdateCtrl = (typeof MSQStartupUpdate !== "undefined" && MSQStartupUpdate)
    ? MSQStartupUpdate.createController({
        getAppInfo: function () {
          var App = getPlugin("App");
          if (!(App && typeof App.getInfo === "function")) { return Promise.resolve(null); }
          return App.getInfo().then(function (info) {
            return {
              id: info.id,
              versionName: info.version,
              versionCode: parseInt(info.build, 10) || 0
            };
          }, function () { return null; });
        },
        channelFor: function (id) {
          return MSQUpdater.updateChannelFor(id);
        },
        /* 与手动 checkForUpdate() 完全相同的服务器解析、endpoint 与超时 */
        fetchLatest: function (channel) {
          var server = updateResolvedServer();
          return (typeof MSQSample !== "undefined" && MSQSample && MSQSample.getJSON)
            ? MSQSample.getJSON(server + "/api/update/" + channel + "/latest", 10000)
            : Promise.reject(new Error("无传输层"));
        },
        validate: function (manifest, expected) {
          return MSQUpdater.validateManifest(manifest, expected);
        },
        compare: function (currentVersionCode, manifest) {
          return MSQUpdater.checkUpdateState(currentVersionCode, manifest);
        },
        /* 只在主菜单就绪、用户仍停在首屏且无弹窗时提示，绝不抢正在进行的操作 */
        canShowNow: function () {
          return startupUiReady && currentViewId() === "view-menu" && !Modal.isOpen();
        },
        /* VC16：不再自动跳转更新页，改为首页上的轻量 Modal。
           稍后/立即更新/系统 Back 都经 Modal.close → onClose 标记 dismissed，
           本次 session 不再自动弹；真正 cold start 才会重新提醒。 */
        showPrompt: function (info, manifest) {
          showStartupUpdateModal(info, manifest);
        },
        debug: function (msg) { console.log("[startup-update] " + msg); }
      })
    : null;

  /* VC17_STARTUP_SPEED_AND_DIAG_ZH_V1：bootstrap 一开始就发起检查（与 loadBank/
     UI 初始化/队列恢复并行，绝不 await），网络耗时与初始化耗时重叠而非串行相加。
     主菜单渲染完成后 markUiReady 才允许展示 Modal（见 boot 段 startupUiReady）。 */
  if (startupUpdateCtrl) { startupUpdateCtrl.trigger(); }

  /* 启动更新提示 Modal（VC16_UI_POLISH_V1 + UI_DESIGN_V1）：复用现有 Modal 组件壳，
     不是系统 AlertDialog，也不新增 native plugin。
     内容只有版本名与简短更新说明 —— 绝不含任何下载地址/校验值/体积/渠道字段。
     立即更新 → openUpdateView(true) 进入既有检查/下载/安装页（同一套安全校验链）。 */
  function showStartupUpdateModal(info, manifest) {
    if (!info || !manifest) { return; }
    var notes = (typeof manifest.notes === "string") ? manifest.notes.trim() : "";
    if (notes.length > 60) { notes = notes.slice(0, 60) + "…"; }   /* 防弹窗过高 */
    Modal.open(function (box) {
      box.className = "modal modal-update";
      var icon = document.createElement("div");
      icon.className = "modal-icon";
      icon.innerHTML = (typeof MSQIcons !== "undefined") ? MSQIcons.svg("download") : "";
      box.appendChild(icon);
      var h = document.createElement("h3");
      h.textContent = "发现新版本";
      box.appendChild(h);
      var vers = document.createElement("div");
      vers.className = "modal-vers";
      var cur = document.createElement("p");
      cur.className = "modal-ver";
      cur.textContent = "当前版本：" + info.versionName;
      vers.appendChild(cur);
      var next = document.createElement("p");
      next.className = "modal-ver new";
      next.textContent = "最新版本：" + manifest.versionName;
      vers.appendChild(next);
      box.appendChild(vers);
      if (notes) {
        var notesBox = document.createElement("div");
        notesBox.className = "modal-notes";
        notesBox.textContent = notes;
        box.appendChild(notesBox);
      }
      var btns = document.createElement("div");
      btns.className = "btns";
      btns.appendChild(mkBtn("稍后", "barbtn cancel", function () { Modal.close(); }));
      btns.appendChild(mkBtn("立即更新", "barbtn ok", function () {
        Modal.close();
        openUpdateView(true);
      }));
      box.appendChild(btns);
    });
    /* 任何关闭路径（稍后 / Back / 立即更新）都算"本次 session 已处理"。
       遮罩点击本就不关闭（Modal 无遮罩点击处理器），避免误触。 */
    Modal.onClose = function () {
      if (startupUpdateCtrl) { startupUpdateCtrl.markDismissed(); }
    };
  }

  /* 更新页返回 = 关闭更新提示：本次 session 不再自动弹（仅影响启动自动检查，
     手动"检查更新"不受任何影响）。系统 Back 与页内返回按钮共用。 */
  function handleUpdateBack() {
    if (startupUpdateCtrl) { startupUpdateCtrl.markDismissed(); }
    renderMenu();
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
    $("btn-take-photo").addEventListener("click", startPhotoSearch);
    $("btn-photo-back").addEventListener("click", handlePhotoBack);
    $("btn-batch-photo").addEventListener("click", startBatchPageSearch);
    $("btn-batch-results-back").addEventListener("click", handleBatchResultsBack);
    $("btn-devdiag-back").addEventListener("click", function () { openUpdateView(); });
    initSampleResultTools();
    initSampleQueue();
    $("btn-update").addEventListener("click", function () { openUpdateView(); });
    $("btn-update-back").addEventListener("click", handleUpdateBack);
    /* btn-update-check 由 renderUpdateView 动态创建并绑定，不做静态绑定 */
    var searchInput = $("search-input");
    var searchClear = $("btn-search-clear");
    if (searchClear) {
      searchClear.addEventListener("click", function () {
        searchInput.value = "";
        doSearch("");
        renderHistory();
        try { searchInput.focus({ preventScroll: true }); }
        catch (e) { try { searchInput.focus(); } catch (e2) { } }
      });
    }
    searchInput.addEventListener("input", function () {
      clearTimeout(searchDebounceTimer);
      var v = searchInput.value;
      if (searchClear) { searchClear.classList.toggle("hidden", !v.trim()); }
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
    batchIndexById = {};
    batchIndex.forEach(function (it) { batchIndexById[it.id] = it; });
    bindEvents();
    renderMenu();
    registerSW();
    registerSystemBack();
    /* VC17：主界面就绪 —— 启动检查早已在跑，此刻起才允许展示 Modal；
       若检查已先完成并发现新版，markUiReady 会立即弹（不等待、不再串行）。 */
    startupUiReady = true;
    if (startupUpdateCtrl) { startupUpdateCtrl.markUiReady(); }
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
