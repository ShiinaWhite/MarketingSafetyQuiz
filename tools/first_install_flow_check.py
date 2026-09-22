#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""first_install_flow_check.py —— 首装相机权限流验证（宿主侧驱动，真实系统 UI）。

为什么不用 instrumentation 测：pm revoke 会以 "permissions revoked" 直接杀掉
持有权限的应用进程，而 instrumentation 运行在该进程里，进程被杀会导致整轮
测试中止（Android 11 模拟器实测）。本脚本从宿主侧用 adb 驱动真实 UI，覆盖：

  1. 全新安装（无权限）→ 搜题 → 整页拍照 → 拍摄整页 → 必须弹出系统相机授权框
  2. 点“While using the app”→ 原生 CameraActivity 获得窗口焦点，dumpsys granted=true
  3. 拒绝链路：Deny 一次 → 页面出现中文提示（不透出裸错误码）
  4. 连续两次 Deny（Android 11+ 视为不再询问）→ 第三次不再弹窗，
     页面出现“相机权限已被拒绝…系统设置…”引导
  5. 结束后恢复 granted

用法：python tools/first_install_flow_check.py [--serial emulator-5570] --apk <apk路径>
"""
import argparse
import re
import subprocess
import sys
import time

ADB = r"D:/workSpace/MarketingSafetyQuiz/_build/android-sdk/platform-tools/adb.exe"
PKG = "com.jty.safetyquiz"
ACT = PKG + "/.MainActivity"
SERIAL = None


def sh(*args, timeout=40):
    cmd = [ADB]
    if SERIAL:
        cmd += ["-s", SERIAL]
    cmd += list(args)
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return (r.stdout + r.stderr).decode("utf-8", "replace")


def dump_ui():
    sh("shell", "uiautomator", "dump", "/sdcard/msq_ui.xml", timeout=60)
    time.sleep(0.4)
    xml = sh("shell", "cat", "/sdcard/msq_ui.xml", timeout=40)
    # uiautomator 会把 emoji 转成数字实体，先还原；匹配一律大小写不敏感
    return re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), xml)


def find_node(xml, text, attr="text"):
    needle = text.lower()
    for m in re.finditer(r'<node[^>]*/?>', xml):
        node = m.group(0)
        mm = re.search(attr + r'="([^"]*)"', node)
        if mm and needle in mm.group(1).lower():
            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if b:
                x1, y1, x2, y2 = map(int, b.groups())
                return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def wait_node(text, timeout_s=20, attr="text"):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        xml = dump_ui()
        pt = find_node(xml, text, attr)
        if pt:
            return pt, xml
        time.sleep(1.0)
    return None, ""


def tap(pt):
    sh("shell", "input", "tap", str(pt[0]), str(pt[1]))
    time.sleep(1.2)


def tap_when(text, timeout_s=25, attr="text", what=""):
    r, xml = wait_node(text, timeout_s, attr)
    if not r:
        print("  [FAIL] 未找到可点击项: %s (%s)" % (text, what))
        return False
    tap(r)
    return True


def camera_granted():
    out = sh("shell", "dumpsys", "package", PKG, timeout=60)
    m = re.search(r"android\.permission\.CAMERA:\s*granted=(true|false)", out)
    return m.group(1) == "true" if m else None


def focused_activity():
    out = sh("shell", "dumpsys", "window", timeout=60)
    m = re.search(r"mCurrentFocus=Window\{[^}]*\s(\S+)\}", out)
    return m.group(1) if m else ""


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  (%s)" % detail) if detail else ""))


def navigate_to_take_photo():
    """菜单 → 搜题 → 📷 → 点“拍摄整页”"""
    if not tap_when("搜题", 40, "text", "首页搜题入口"):
        return False
    if not tap_when("\U0001F4F7", 20, "text", "搜索页整页拍照入口"):
        return False
    return tap_when("拍摄整页", 20, "text", "拍摄整页按钮")


def wait_dialog(timeout_s=20):
    """等系统授权弹窗（dump 文本可能全大写，已做大小写不敏感匹配；支持中文环境）"""
    dl = time.time() + timeout_s
    while time.time() < dl:
        xml = dump_ui()
        pt = find_node(xml, "while using") or find_node(xml, "允许")
        if pt:
            return pt, xml
        time.sleep(1.0)
    return None, ""


def main():
    global SERIAL
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default=None)
    ap.add_argument("--apk", required=True)
    args = ap.parse_args()
    SERIAL = args.serial
    apk = args.apk

    print("== 卸载重装（模拟首装）==")
    sh("uninstall", PKG, timeout=60)
    out = sh("install", "-r", apk, timeout=180)
    if "Success" not in out:
        print("install 失败:", out)
        return 1
    def not_granted_with_retry():
        for _ in range(5):
            g = camera_granted()
            if g is False:
                return True
            time.sleep(1.0)
        return False
    check("fresh_install_no_permission", not_granted_with_retry(),
          "granted=%s" % camera_granted())

    print("== 流程 1：首装点拍摄 → 系统授权弹窗 → 允许 → 原生相机页 ==")
    sh("shell", "am", "start", "-n", ACT, timeout=40)
    time.sleep(4)
    if not navigate_to_take_photo():
        return 1
    dlg, _ = wait_dialog(25)
    check("first_install_system_dialog_shown", bool(dlg), "系统相机权限弹窗出现")
    if not dlg:
        return 1
    tap(dlg)
    time.sleep(3)
    focus = focused_activity()
    check("allow_grants_and_opens_native_camera",
          camera_granted() is True and focus.endswith(".CameraActivity"),
          "granted=%s focus=%s" % (camera_granted(), focus))
    sh("shell", "input", "keyevent", "4")   # LIVE 返回 → 取消，回入口页
    time.sleep(2)

    print("== 流程 2：拒绝 → 中文提示（不透出裸错误码）==")
    sh("shell", "am", "force-stop", PKG)
    sh("shell", "pm", "revoke", PKG, "android.permission.CAMERA")
    sh("shell", "am", "start", "-n", ACT, timeout=40)
    time.sleep(4)
    if not navigate_to_take_photo():
        return 1
    dlg, xml_d = wait_dialog(20)
    check("re_ask_dialog_shown", bool(dlg), "再次请求时弹窗出现")
    if not dlg:
        return 1
    deny = find_node(xml_d, "deny") or find_node(dump_ui(), "拒绝")
    if deny:
        tap(deny)
        time.sleep(2)
    # 拒绝后必须出现中文引导（允许引导或设置引导均可），绝不出现裸错误码
    ok, xml_s = wait_node("相机权限", 15)
    raw_code_leak = bool(ok) and ("PERMISSION_DENIED" in xml_s or "CAMERA_" in xml_s)
    check("deny_shows_chinese_message_no_raw_code", bool(ok) and not raw_code_leak,
          "拒绝后中文引导（无裸错误码）")

    print("== 流程 3：拒绝到不再弹窗 → 系统设置引导，且不得拉起相机 ==")
    # Android 11+：拒绝一次/两次后系统进入不再询问；以系统实际表现为准，
    # App 侧正确行为 = 不再弹窗时显示设置引导且不拉起相机。
    if not tap_when("拍摄整页", 15, "text", "再次请求入口"):
        return 1
    dlg, xml_d2 = wait_dialog(15)
    if dlg:
        deny2 = find_node(xml_d2, "deny") or find_node(dump_ui(), "拒绝")
        if not deny2:
            return 1
        tap(deny2)
        time.sleep(2)
        if not tap_when("拍摄整页", 15, "text", "第三次请求入口"):
            return 1
    time.sleep(3)
    xml_now = dump_ui()
    again = find_node(xml_now, "while using") or find_node(xml_now, "允许")
    check("permanent_no_more_dialog", again is None, "不再弹出系统授权框")
    focus = focused_activity()
    check("permanent_no_camera_launch", not focus.endswith(".CameraActivity"),
          "focus=%s" % focus)
    msg, xml_f = wait_node("已被拒绝", 15)
    if not msg:
        msg, xml_f = wait_node("相机权限", 8)
    check("permanent_chinese_settings_guide", bool(msg), "提示去系统设置开启相机权限")

    print("== 清理：恢复 granted ==")
    sh("shell", "am", "force-stop", PKG)
    sh("shell", "pm", "grant", PKG, "android.permission.CAMERA")
    check("restored_granted", camera_granted() is True)

    print("\n== 汇总 ==")
    fails = [r for r in RESULTS if not r[1]]
    for n, ok, d in RESULTS:
        print("  [%s] %s %s" % ("PASS" if ok else "FAIL", n, d))
    if fails:
        print("结果：%d 项未通过" % len(fails))
        return 1
    print("结果：全部通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
