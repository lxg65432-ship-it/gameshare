/**
 * HWND → PID。**唯一**一处 FFI。
 *
 * 为什么需要它：Chromium 的 `applicationLoopback:<pid>` 只认进程 ID，而
 * `desktopCapturer` 交给我们的是窗口句柄（藏在 source id 中间那一段）。
 * 两者之间那一步 `GetWindowThreadProcessId` 是 Win32 API，Node/Electron
 * 都没有暴露 —— 这就是整个「按应用采集声音」唯一缺的一小块。
 *
 * 刻意只做这一步，不做别的：
 * 采集本身、重采样、混音、声道处理全部由 Chromium 的音频服务承担，
 * 我们**不写 WASAPI、不写 C++ AudioClient、不写自己的 PCM 管线**。
 * 所以这里只有两个函数声明，加起来不到十行。
 *
 * 用 koffi（预编译、无需 node-gyp / VS 工具链）。它是原生模块，
 * **esbuild 打不进 bundle**（`build-electron.mjs` 里标了 external），
 * 于是加载路径分两种：
 *   - 开发：仓库根 `node_modules/koffi`（npm workspaces 提升）；
 *   - 打包后：`resources/audio-ffi/node_modules/koffi`（见 `package.json` 的
 *     `build.extraResources`）。**必须是这个嵌套结构** —— koffi 内部按
 *     `${__dirname}/../../../@koromix/koffi-<platform>-<arch>` 找它的二进制，
 *     摊平摆放就会找不到。
 *
 * 拿不到 koffi 时**不静默降级**：直接抛 `ffi-unavailable`，由上层决定是
 * 退回整机声音还是把错误摆给用户看。
 */

import path from 'node:path';

import { parseHwndFromSourceId } from './device-ids';
import { AudioCaptureError } from './types';

/** koffi 的调用面（只用到这两个，不引它的 .d.ts，免得把原生模块的类型塞进编译图） */
type NativeFunc = (...args: unknown[]) => unknown;

interface Win32Api {
  isWindow: NativeFunc;
  windowThreadProcessId: NativeFunc;
}

let api: Win32Api | null = null;
let loadFailure: string | null = null;

/**
 * 依次尝试两条加载路径。
 *
 * 不能用 `require('koffi')` 的静态形式当唯一入口：打包后它不在 asar 里，
 * 会在启动时就抛，而这是**可选能力**，不该让整个客户端起不来。
 */
function loadKoffiModule(): { load(library: string): { func(signature: string): NativeFunc } } {
  const candidates = [
    // 开发和自动化验收：仓库根 node_modules（npm workspaces 提升到这里）
    'koffi',
  ];
  // 打包后：extraResources 落点。开发环境下这个目录不存在，自然落到下一个候选
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
  if (loadFailure) {
    throw new AudioCaptureError({
      code: 'ffi-unavailable',
      message: `取不到窗口所属进程（FFI 不可用）：${loadFailure}`,
      suggestion: 'system',
    });
  }
  try {
    const koffi = loadKoffiModule();
    const user32 = koffi.load('user32.dll');
    api = {
      // 句柄可能已经失效（窗口关掉了），先问一句再取值，
      // 否则拿到的是「0 号 PID」这种看着像数据、其实什么都没有的结果
      isWindow: user32.func('bool IsWindow(void *hWnd)'),
      windowThreadProcessId: user32.func(
        'uint32 GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)',
      ),
    };
    return api;
  } catch (err) {
    // 记下来，后续调用直接抛同一个原因，不必每次都去试一遍加载
    loadFailure = err instanceof Error ? err.message : String(err);
    throw new AudioCaptureError({
      code: 'ffi-unavailable',
      message: `取不到窗口所属进程（FFI 不可用）：${loadFailure}`,
      suggestion: 'system',
    });
  }
}

/** 给能力检测用：不抛异常，只报告这条链能不能走 */
export function windowPidLookupStatus(): { available: boolean; detail: string } {
  try {
    ensureApi();
    return { available: true, detail: 'koffi 可用，GetWindowThreadProcessId 已就绪' };
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 取窗口所属进程的 PID。
 *
 * 取不到返回 null（句柄失效、进程已退出），**不抛异常** —— 「这个窗口现在没进程」
 * 是调用方要正常处理的输入，不是异常情况。真正「这条链整个不可用」才抛
 * `ffi-unavailable`（由 ensureApi 抛）。
 */
export function pidOfHwnd(hwnd: number): number | null {
  const fn = ensureApi();
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return null;
  if (!fn.isWindow(hwnd)) return null;

  // 出参用固定 4 字节的 Buffer 接：koffi 指针型返回值是 BigInt，
  // 走 Buffer 读回来更直白，也省得处理大整数
  const out = Buffer.alloc(4);
  const threadId = fn.windowThreadProcessId(hwnd, out);
  const pid = out.readUInt32LE(0);
  if (pid <= 0) return null;
  // threadId 为 0 说明调用没成功（句柄在 IsWindow 之后、取值之前被销毁）
  return threadId === 0 ? null : pid;
}

/** 一步到位：source id → HWND → PID。任一步不成返回 null */
export function pidOfWindowSource(sourceId: string): number | null {
  const hwnd = parseHwndFromSourceId(sourceId);
  if (hwnd === null) return null;
  return pidOfHwnd(hwnd);
}

/**
 * 给源列表用：解析失败**不让整个列表失败**。
 *
 * 列表里有几十个源，其中一个取不到 PID（刚好关掉了）不该让用户看不到列表，
 * 记 null 就行 —— 界面上那一项会显示成「不能按应用采声音」。
 */
export function tryPidOfWindowSource(sourceId: string): number | null {
  try {
    return pidOfWindowSource(sourceId);
  } catch {
    return null;
  }
}
