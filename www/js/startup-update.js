/* startup-update.js —— STARTUP_UPDATE_CHECK_V1：冷启动自动检查更新的最小可测纯逻辑。
   不实现第二套 updater：manifest 获取/校验/版本比较/更新弹窗/下载/校验/安装全部复用
   updater.js 纯函数 + app.js 既有手动"检查更新"状态机 + 原生 UpdatePlugin。
   本模块只回答两个问题：
     1) 本次 session 是否还允许自动检查（每个 process/WebView 生命周期一次）；
     2) 检查结果出来后是否弹提示（仅 available 弹，其余一律静默）。
   Node 自检可 require。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.MSQStartupUpdate = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 纯决策矩阵（SUC-2~6/9 的判定核心）。
     check  = { ok:true, state } （state = MSQUpdater.checkUpdateState 结果：
              "available"|"latest"|"downgrade"）或 { ok:false }（fetch/校验失败）
     flags  = { dismissed: 本次 session 用户已关闭过自动提示,
                canShowNow: 当前在主菜单且无弹窗（不抢用户正在进行的操作） }
     返回 { prompt, reason }；reason 仅供非敏感 debug 日志，绝不进 UI。 */
  function decideStartupPrompt(check, flags) {
    var f = flags || {};
    if (!check || !check.ok) { return { prompt: false, reason: "check-failed" }; }
    if (check.state !== "available") { return { prompt: false, reason: "not-newer:" + check.state }; }
    if (f.dismissed) { return { prompt: false, reason: "dismissed-this-session" }; }
    if (!f.canShowNow) { return { prompt: false, reason: "ui-busy" }; }
    return { prompt: true, reason: "newer-version" };
  }

  /* 编排器：io 由 app.js 注入（全部复用手动检查的同一条路径）。
     io.getAppInfo() -> Promise<{id, versionName, versionCode}|null>   （Capacitor App.getInfo 同款）
     io.channelFor(applicationId) -> "dev"|"stable"|null               （MSQUpdater.updateChannelFor）
     io.fetchLatest(channel) -> Promise<manifest>                       （MSQSample.getJSON 同一 endpoint，失败即 reject）
     io.validate(manifest, expected) -> {ok,error}                      （MSQUpdater.validateManifest）
     io.compare(currentVersionCode, manifest) -> state                  （MSQUpdater.checkUpdateState）
     io.canShowNow() -> bool                                            （主菜单可见且无 Modal）
     io.showPrompt(info, manifest) -> void                              （把既有更新页切到 available 态）
     io.debug(msg) -> void                                              （非敏感 debug 日志出口） */
  function createController(io) {
    var started = false;    /* 每个 App process / WebView 生命周期只自动检查一次（纯内存） */
    var dismissed = false;  /* 用户关闭启动提示后，本次 session 不再自动弹 */

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
          var decision = decideStartupPrompt(
            v.ok ? { ok: true, state: state } : { ok: false },
            { dismissed: dismissed, canShowNow: !!io.canShowNow() });
          if (decision.prompt) {
            io.showPrompt(info, manifest); /* 既有更新提示 UI，manifest 原样传递 */
          } else {
            io.debug("startup update check skipped/failed: " + decision.reason);
          }
        }, function () {
          /* offline / DNS / 超时 / 5xx / JSON 解析失败：完全静默，仅 debug log */
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
      flags: function () { return { started: started, dismissed: dismissed }; }
    };
  }

  return {
    decideStartupPrompt: decideStartupPrompt,
    createController: createController
  };
});
