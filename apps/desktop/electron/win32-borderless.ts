/**
 * 强制无边框化（borderless）：把任意窗口去边框、铺满所在显示器，可一键还原。
 *
 * 为什么要有它：不少游戏不支持「无边框窗口化」，而独占全屏抓不到画面 ——
 * 这个功能替用户完成那个他们不会设置的窗口调整。
 *
 * **反作弊安全边界（设计约束，别越过去）**：
 * 只调用 Win32 公开 API 操作**窗口外观**（样式位 + 位置尺寸），
 * 不打开游戏进程、不读写它的内存、不注入任何东西 —— 和 WGC 捕获一样
 * 是「系统级旁观者」。Borderless Gaming / WindowedBorderlessGaming 这类
 * 工具十几年、百万级用户，无因无边框化被封号的公开记录，做的就是同样的事。
 * 所以这里**永远不要加**「改进程内存」「hook 渲染」之类的「增强」。
 *
 * 「尽力而为」语义：改不动的窗口（游戏每帧重设样式、纯独占全屏）如实报失败，
 * 不静默 —— 和音频那条「不许静默降级」是同一条纪律。
 *
 * 还原记录是**进程内的 map**，不是持久化配置：应用本进程改的窗口才由
 * 本进程负责还原。重启后原样式的记忆丢了——但样式改动本身跟着窗口活着，
 * 游戏退出重开窗口自然是全新样式，不会留下「永远去边框」的孤儿状态。
 */

import path from 'node:path';

import { parseHwndFromSourceId } from './audio/device-ids';

type NativeFunc = (...args: unknown[]) => unknown;

/** 窗口样式位（winuser.h） */
const WS_CAPTION = 0x00c00000;
const WS_THICKNESS = 0x00040000;
const WS_POPUP = 0x80000000;
/** SetWindowPos flags */
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_SHOWWINDOW = 0x0040;
/** MonitorFromWindow 的「取最近的显示器」 */
const MONITOR_DEFAULTTONEAREST = 2;
/** ShowWindow */
const SW_RESTORE = 9;

interface Win32Api {
  isWindow: NativeFunc;
  isIconic: NativeFunc;
  showWindow: NativeFunc;
  getWindowLong: NativeFunc;
  setWindowLong: NativeFunc;
  getWindowRect: NativeFunc;
  monitorFromWindow: NativeFunc;
  getMonitorInfo: NativeFunc;
  setWindowPos: NativeFunc;
}

/** 一次应用时保存的原始状态，还原时用 */
interface SavedWindowState {
  style: number;
  rect: { left: number; top: number; right: number; bottom: number };
}

let api: Win32Api | null = null;
let loadFailure: string | null = null;

/** hwnd（应用过的）→ 原始状态 */
const saved = new Map<number, SavedWindowState>();

/** koffi 双路径加载 —— 与 audio/win32-window-pid.ts 同一套约定，别拆开来改 */
function loadKoffiModule(): { load(library: string): { func(signature: string): NativeFunc } } {
  const candidates: string[] = ['koffi'];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'audio-ffi', 'node_modules', 'koffi'));
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require(candidate) as {
        load(library: string): { func(signature: string): NativeFunc };
      };
      if (loaded && typeof loaded.load === 'function') return loaded;
      errors.push(`${candidate}: 拿到的不是 koffi 模块`);
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join(' / '));
}

function ensureApi(): Win32Api {
  if (api) return api;
  if (loadFailure) throw new Error(`FFI 不可用：${loadFailure}`);
  try {
    const koffi = loadKoffiModule();
    const user32 = koffi.load('user32.dll');
    // 样式值域在 32 位内，用 LONG 版本（GetWindowLongW）即可，
    // 不必碰 x64 上指针宽的 GetWindowLongPtrW —— 少一个类型坑
    api = {
      isWindow: user32.func('bool IsWindow(void *hWnd)'),
      isIconic: user32.func('bool IsIconic(void *hWnd)'),
      showWindow: user32.func('bool ShowWindow(void *hWnd, int nCmdShow)'),
      getWindowLong: user32.func('int32 GetWindowLongW(void *hWnd, int nIndex)'),
      setWindowLong: user32.func('int32 SetWindowLongW(void *hWnd, int nIndex, int32 dwNewLong)'),
      // RECT / MONITORINFO 直接用 Buffer 传，省掉 koffi struct 定义
      getWindowRect: user32.func('bool GetWindowRect(void *hWnd, void *lpRect)'),
      monitorFromWindow: user32.func('void *MonitorFromWindow(void *hWnd, uint32 dwFlags)'),
      getMonitorInfo: user32.func('bool GetMonitorInfoW(void *hMonitor, void *lpmi)'),
      setWindowPos: user32.func(
        'bool SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)',
      ),
    };
    return api;
  } catch (err) {
    loadFailure = err instanceof Error ? err.message : String(err);
    throw new Error(`FFI 不可用：${loadFailure}`);
  }
}

/** 给能力检测：这条链能不能走（决定界面显不显示按钮） */
export function borderlessStatus(): { available: boolean; detail: string } {
  try {
    ensureApi();
    return { available: true, detail: 'koffi 可用，user32 窗口操作已就绪' };
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function readRect(buf: Buffer): { left: number; top: number; right: number; bottom: number } {
  return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) };
}

/** koffi 的数字返回值收窄（多数是 number，个别平台包成 BigInt） */
function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

/**
 * 这个窗口现在是不是已经「无边框」了。
 *
 * 判据：带 WS_POPUP 且无标题栏与可调边框。带这条判断才有「点了没反应」
 * 的自愈 —— 游戏自己就是无边框窗口时，原样保留、报告 already。
 */
function isBorderlessStyle(style: number): boolean {
  return (style & WS_POPUP) !== 0 && (style & WS_CAPTION) === 0;
}

/**
 * 切换：未应用 → 应用；已应用 → 还原。
 *
 * 返回给界面的话**直接说人话**，渲染层不做二次拼装 —— 失败原因只有
 * 主进程这一侧知道（FFI 错误、显示器枚举失败、游戏改回去），传过去的就是结论。
 */
export function toggleBorderless(sourceId: string): { applied: boolean; message: string } {
  const hwnd = parseHwndFromSourceId(sourceId);
  if (hwnd === null) return { applied: false, message: '无法识别这个窗口的句柄' };

  let fn: Win32Api;
  try {
    fn = ensureApi();
  } catch (err) {
    return { applied: false, message: err instanceof Error ? err.message : String(err) };
  }

  if (!fn.isWindow(hwnd)) {
    saved.delete(hwnd);
    return { applied: false, message: '这个窗口已经不存在了（可能刚被关闭），重新枚举后再试' };
  }

  // ---- 已应用：还原 ----
  if (saved.has(hwnd)) {
    const state = saved.get(hwnd);
    if (!state) return { applied: false, message: '内部状态异常，请重新枚举' };
    fn.setWindowLong(hwnd, -16 /* GWL_STYLE */, state.style);
    const rect = Buffer.alloc(16);
    rect.writeInt32LE(state.rect.left, 0);
    rect.writeInt32LE(state.rect.top, 4);
    rect.writeInt32LE(state.rect.right, 8);
    rect.writeInt32LE(state.rect.bottom, 12);
    fn.setWindowPos(
      hwnd,
      null,
      state.rect.left,
      state.rect.top,
      state.rect.right - state.rect.left,
      state.rect.bottom - state.rect.top,
      SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOOWNERZORDER,
    );
    saved.delete(hwnd);
    return { applied: false, message: '已还原窗口边框' };
  }

  // ---- 未应用：应用 ----
  const style = num(fn.getWindowLong(hwnd, -16 /* GWL_STYLE */));
  if (isBorderlessStyle(style)) {
    return { applied: false, message: '这个窗口本身已经是无边框的，不需要处理' };
  }

  // 最小化的窗口枚举列表里不会出现，但保险起见：改样式前先还原
  if (fn.isIconic(hwnd)) fn.showWindow(hwnd, SW_RESTORE);

  const rectBuf = Buffer.alloc(16);
  if (!fn.getWindowRect(hwnd, rectBuf)) {
    return { applied: false, message: '取不到窗口位置，处理失败' };
  }

  const mi = Buffer.alloc(40); // MONITORINFO：cbSize + rcMonitor + rcWork + dwFlags
  mi.writeUInt32LE(40, 0);
  const hMonitor = fn.monitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!hMonitor || !fn.getMonitorInfo(hMonitor, mi)) {
    return { applied: false, message: '取不到窗口所在显示器的尺寸，处理失败' };
  }
  const ml = mi.readInt32LE(4);
  const mt = mi.readInt32LE(8);
  const mw = mi.readInt32LE(12) - ml;
  const mh = mi.readInt32LE(16) - mt;

  const newStyle = (style | WS_POPUP) & ~(WS_CAPTION | WS_THICKNESS);
  const old = num(fn.setWindowLong(hwnd, -16, newStyle));
  if (old !== style) {
    // 顺带把真实旧值记下来（两者应相等，不等说明读取与设置之间被改过 —— 还原时以这里为准）
    saved.set(hwnd, { style: old, rect: readRect(rectBuf) });
  } else {
    saved.set(hwnd, { style, rect: readRect(rectBuf) });
  }

  fn.setWindowPos(
    hwnd,
    null,
    ml,
    mt,
    mw,
    mh,
    SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
  );

  // 验证：一部分游戏每帧重设自己的样式，改完立刻被弹回去 —— 这种要如实报告
  const after = num(fn.getWindowLong(hwnd, -16));
  if (!isBorderlessStyle(after)) {
    saved.delete(hwnd);
    return {
      applied: false,
      message: '这个游戏会自己把窗口样式改回去，无法强制无边框（可以在游戏内视频设置里找「无边框 / Borderless」选项）',
    };
  }

  return { applied: true, message: '已无边框化，铺满显示器；再点一次可还原' };
}

/** 这个窗口当前是否处于「被我们改过」的状态（源列表打标签用） */
export function isBorderlessApplied(sourceId: string): boolean {
  const hwnd = parseHwndFromSourceId(sourceId);
  if (hwnd === null) return false;
  if (!saved.has(hwnd)) return false;
  try {
    if (!ensureApi().isWindow(hwnd)) {
      saved.delete(hwnd);
      return false;
    }
  } catch {
    return false;
  }
  return true;
}
