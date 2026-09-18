#!/usr/bin/env python3
"""枚举 Windows 所有顶层窗口，并标出哪些会被 desktopCapturer 跳过、为什么。

起因：以撒的窗口有时出现在采集源列表里、有时不出现。实测已经确认
      进程在跑、窗口有标题，但 desktopCapturer.getSources 就是不返回它。
      Chromium 在 Windows 上枚举窗口时会静默跳过这几类窗口：

        1. 不可见          IsWindowVisible() == False
        2. 已最小化        IsIconic() == True
        3. 标题为空        GetWindowTextLength() == 0
        4. 被 DWM cloaked  DwmGetWindowAttribute(DWMWA_CLOAKED) != 0
                           （全屏应用切到后台、应用在别的虚拟桌面上）

      这些状态从 desktopCapturer 那一侧完全看不到，只会得到一个
      「列表里没有」。这个脚本把它们补出来。

      输出里的 hwnd 就是 sourceId `window:<hwnd>:0` 中间那个数字，
      可以直接和 Electron 侧的枚举结果对上。

另外它还会标出每个窗口在不在 **topmost 带**（`WS_EX_TOPMOST`）—— 这一栏是给浮窗模式用的：
**不少游戏全屏时自己也置顶**，那时我们的浮窗和它同处一个带，它一被激活就把浮窗压到带内
下方（这就是「点回游戏，浮窗掉到低层」的成因）。想确认某款游戏属不属于这种，全屏跑着它、
再执行本脚本看那一栏；有 `TOPMOST` 且 exe 是那个游戏，就用得着浮窗的 300ms 保活。

用法：
    python scripts/probe-windows.py
    python scripts/probe-windows.py isaac      # 只看名字含某关键字的窗口
"""

import ctypes
import sys
from ctypes import wintypes

if sys.stdout.encoding and sys.stdout.encoding.lower().replace('-', '') != 'utf8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

user32 = ctypes.WinDLL('user32', use_last_error=True)
dwmapi = ctypes.WinDLL('dwmapi', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

DWMWA_CLOAKED = 14
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008
WS_EX_NOACTIVATE = 0x08000000
WS_EX_LAYERED = 0x00080000

user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
# 64 位下必须用 GetWindowLongPtrW；GWL_EXSTYLE = -20
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.EnumWindows.restype = wintypes.BOOL
user32.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long
dwmapi.DwmGetWindowAttribute.argtypes = [
    wintypes.HWND,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def window_title(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def window_pid(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def process_name(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return '?'
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit('\\', 1)[-1]
        return '?'
    finally:
        kernel32.CloseHandle(handle)


def cloaked_state(hwnd):
    value = ctypes.c_int(0)
    hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value))
    return value.value if hr == 0 else -1


def style_flags(hwnd):
    """扩展样式里有用的位。TOPMOST 是浮窗掉层的关键，LAYERED 说明这窗口做过半透明。"""
    ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    flags = []
    if ex & WS_EX_TOPMOST:
        flags.append('TOPMOST')
    if ex & WS_EX_NOACTIVATE:
        flags.append('NOACTIVATE')
    if ex & WS_EX_LAYERED:
        flags.append('LAYERED')
    return flags


def collect():
    rows = []

    @WNDENUMPROC
    def on_window(hwnd, _lparam):
        hwnd = int(hwnd)
        title = window_title(hwnd)
        rows.append(
            {
                'hwnd': hwnd,
                'title': title,
                'pid': window_pid(hwnd),
                'visible': bool(user32.IsWindowVisible(hwnd)),
                'iconic': bool(user32.IsIconic(hwnd)),
                'cloaked': cloaked_state(hwnd),
                'style': style_flags(hwnd),
            }
        )
        return True

    user32.EnumWindows(on_window, 0)
    for row in rows:
        row['exe'] = process_name(row['pid'])
        reasons = []
        if not row['visible']:
            reasons.append('不可见')
        if row['iconic']:
            reasons.append('已最小化')
        if not row['title'].strip():
            reasons.append('无标题')
        if row['cloaked'] == 1:
            reasons.append('cloaked(应用自己隐藏)')
        elif row['cloaked'] == 2:
            reasons.append('cloaked(在别的虚拟桌面)')
        elif row['cloaked'] > 2:
            reasons.append(f'cloaked({row["cloaked"]})')
        row['reasons'] = reasons
    return rows


def main():
    keyword = sys.argv[1].lower() if len(sys.argv) > 1 else None
    rows = collect()
    if keyword:
        rows = [r for r in rows if keyword in r['exe'].lower() or keyword in r['title'].lower()]

    skipped = [r for r in rows if r['reasons']]
    kept = [r for r in rows if not r['reasons']]

    print(f'顶层窗口共 {len(rows)} 个：{len(kept)} 个可以被枚举，{len(skipped)} 个会被跳过')
    print()

    print('=== 会被 desktopCapturer 跳过的窗口 ===')
    if not skipped:
        print('  （没有）')
    for row in sorted(skipped, key=lambda r: r['exe']):
        print(f'  hwnd={row["hwnd"]:<12} {row["exe"]:<28} {" ".join(row["reasons"])}')
        print(f'        标题: {row["title"][:70] or "(空)"}')

    print()
    print('=== 可以被枚举的窗口 ===')
    for row in sorted(kept, key=lambda r: r['exe']):
        mark = '  ← 在 topmost 带' if 'TOPMOST' in row['style'] else ''
        print(f'  hwnd={row["hwnd"]:<12} {row["exe"]:<28} {row["title"][:60]}{mark}')

    topmost = [r for r in rows if 'TOPMOST' in r['style']]
    print()
    print(f'=== 处于 topmost 带的窗口（{len(topmost)} 个）===')
    print('  同一个带里，谁在上面取决于谁最后一次 SetWindowPos；**激活会把自己抬到带顶**。')
    print('  所以：如果游戏也在这个带里（不少游戏全屏时确实会给自己设 topmost），')
    print('  用户点回游戏那一下就会把我们的浮窗压到带内下方 —— 浮窗靠 300ms 保活夺回来。')
    if not topmost:
        print('  （没有）')
    for row in sorted(topmost, key=lambda r: r['exe']):
        print(f'  hwnd={row["hwnd"]:<12} {row["exe"]:<28} {row["title"][:60]}')


if __name__ == '__main__':
    main()
