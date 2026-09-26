/* startup-update.js —— STARTUP_UPDATE_CHECK_V1：冷启动自动检查更新的最小可测纯逻辑。
   不实现第二套 updater：manifest 获取/校验/版本比较/更新弹窗/下载/校验/安装全部复用
   updater.js 纯函数 + app.js 既有手动"检查更新"状态机 + 原生 UpdatePlugin。
   本模块只回答两个问题：
     1) 本次 session 是否还允许自动检查（每个 process/WebView 生命周期一次）；
     2) fresh discovery 结果是否弹提示 —— DEFERRED_PROMPT_V1 起恒为「不弹」：
        fresh available 只写 validated cache（由 prefetch 完成），提示延迟到
        下次冷启动由 cache 快路径给出；页面位置与 fresh 路径完全解耦。
   Node 自检可 require。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.MSQStartupUpdate = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 纯决策矩阵（SUC-2~6/9 的判定核心）。
     check  = { ok:true, state } （state = MSQUpdater.checkUpdateState 结果：
              "available"|"latest"|"downgrade"）或 { ok:false }（fetch/校验失败）
     flags  = { dismissed: 本次 session 用户已关闭过自动提示 }（保留兼容）
     STARTUP_UPDATE_DEFERRED_PROMPT_V1：fresh discovery 一律不在本 session 弹提示——
     available 只代表「发现完成」，validated cache 已由 prefetch 写入，提示延迟到
     下次冷启动由 cache 快路径给出（cache newer → immediate prompt）。
     canShowNow/页面位置不再参与 fresh 路径决策。
     返回 { prompt, reason }；reason 仅供非敏感 debug 日志，绝不进 UI。 */
  function decideStartupPrompt(check, flags) {
    if (!check || !check.ok) { return { prompt: false, reason: "check-failed" }; }
    if (check.state !== "available") { return { prompt: false, reason: "not-newer:" + check.state }; }
    return { prompt: false, reason: "fresh-discovery-deferred-next-cold-start" };
  }

  /* 编排器：io 由 app.js 注入（全部复用手动检查的同一条路径）。
     io.getAppInfo() -> Promise<{id, versionName, versionCode}|null>   （Capacitor App.getInfo 同款）
     io.channelFor(applicationId) -> "dev"|"stable"|null               （MSQUpdater.updateChannelFor）
     io.fetchLatest(channel) -> Promise<manifest>                       （MSQSample.getJSON 同一 endpoint，失败即 reject）
     io.validate(manifest, expected) -> {ok,error}                      （MSQUpdater.validateManifest）
     io.compare(currentVersionCode, manifest) -> state                  （MSQUpdater.checkUpdateState）
     io.debug(msg) -> void                                              （非敏感 debug 日志出口）
     DEFERRED_PROMPT_V1：io 不再有 canShowNow/showPrompt —— fresh 结果只用于
     discovery 记录，提示统一由 cache 快路径在下次冷启动给出。 */
  function createController(io) {
    var started = false;    /* 每个 App process / WebView 生命周期只自动检查一次（纯内存） */
    var dismissed = false;  /* 用户关闭启动提示后，本次 session 不再自动弹 */
    /* DEFERRED_PROMPT_V1：fresh 结果不触发任何 UI（discovery 静默完成）。
       decideStartupPrompt 现恒返回 prompt:false；本函数只记录非敏感 debug。 */
    function tryShow(info, manifest) {
      var decision = decideStartupPrompt({ ok: true, state: "available" }, { dismissed: dismissed });
      io.debug("startup update check skipped: " + decision.reason);
      return false;
    }

    function trigger() {
      if (started) {
        io.debug("startup update check skipped: already ran this session");
        return { ran: false, reason: "already-started" };
      }
      started = true; /* 先占位再异步：检查期间二次触发/前后台切换一律不再触发 */
      io.getAppInfo().then(function (info) {
        if (!info || typeof info.versionCode !== "number") {
          io.debug("startup update check skipped: no app info");
          return;
        }
        var channel = io.channelFor(info.id);
        if (!channel) {
          io.debug("startup update check skipped: channel unsupported");
          return;
        }
        io.fetchLatest(channel).then(function (manifest) {
          var v = io.validate(manifest, { channel: channel, packageName: info.id });
          var state = v.ok ? io.compare(info.versionCode, manifest) : null;
          if (v.ok && state === "available") {
            tryShow(info, manifest);
            return;
          }
          /* offline/DNS/超时/5xx/解析失败/无新版：完全静默，仅 debug log */
          io.debug("startup update check skipped/failed: " +
            (!v.ok ? "check-failed" : "not-newer:" + state));
        }, function () {
          io.debug("startup update check failed: network/transport");
        });
      }, function () {
        io.debug("startup update check skipped: app info unavailable");
      });
      return { ran: true };
    }

    return {
      trigger: trigger,
      markDismissed: function () { dismissed = true; },
      /* 兼容保留：cache 快路径就绪时机由 app.js 的 modalUiReady 直接管理；
         fresh discovery 已与 UI 门完全解耦（DEFERRED_PROMPT_V1）。 */
      markUiReady: function () { },
      flags: function () {
        return { started: started, dismissed: dismissed };
      }
    };
  }

  return {
    decideStartupPrompt: decideStartupPrompt,
    createController: createController
  };
});
