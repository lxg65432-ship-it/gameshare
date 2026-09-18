/**
 * Chromium 音频 device id 的**唯一产地**。
 *
 * 这些字符串是 Chromium 内部的 device id（`AudioDeviceDescription::k*DeviceId`）。
 * Electron 的 `Streams.audio` 类型没有声明它们，但 `setDisplayMediaRequestHandler`
 * 会把拿到的值当 device id **原样交给 Chromium，不做白名单校验** ——
 * 实测（`docs/APP-AUDIO-POC.md`，Electron 43.7.2 / Chromium 150）：
 *
 *   - `loopback`                     整机混音（含本实例自己的播放）
 *   - `loopbackWithoutChrome`        整机混音 **减去本实例自己**（另一个 Chromium 实例不受影响）
 *   - `applicationLoopback:<pid>`    只采 `<pid>` 及其**进程树**
 *
 * 因为是透传，写错一个字符不会有任何编译期提示，只会得到一句
 * 「采集失败」。所以：**本文件之外不许再出现这些字面量。**
 */

/**
 * 整机声音但排除本 Electron 实例自己的播放。
 *
 * 「排除的是**本实例**，不是整个 Chromium」这一点很关键：同在跑的另一个
 * Chromium 应用（共享浏览器窗口时那个浏览器）的声音**会被保留**，
 * 所以拿它当整机共享的默认方案是安全的。实测见 APP-AUDIO-POC.md 的 C2 表。
 *
 * 「自己那一路到底排没排掉」不能靠单次看读数（落在某个频点上的能量还可能来自
 * 别人的谐波、或几个别人频率组合出的互调产物 —— 实测撞上过
 * `1360 + 1740 − 2040 = 1060`）。正确的量法是**把自己那一放开 / 关**做 A/B：
 * 实测关掉之后该频点读数只差几个 dB，而同一次 A/B 在普通 `loopback` 下是 40 dB。
 * 验收见 `npm run check:app-audio` 的第 0 组。
 */
export const SYSTEM_AUDIO_WITHOUT_SELF_DEVICE_ID = 'loopbackWithoutChrome';

/**
 * 普通整机混音。
 *
 * **不是正式方案**：它会把本机自己的播放一起采进去，而收到的远端语音正是从
 * 本机扬声器出来的 —— 双向共享时构成数字正反馈（啸叫）。只作为调试 / 高级兼容模式。
 */
export const LEGACY_LOOPBACK_DEVICE_ID = 'loopback';

/**
 * 只采指定进程树的声音。
 *
 * Chromium 侧对应 `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`。
 * **实测的边界要写清楚：含的是「目标进程 + 它的直接子进程」，不含孙子。**
 *
 * 这件事很容易被一句「支持进程树」盖过去，所以值得留个具体的反例：
 * 拿目标应用 spawn 出来的**另一个 Electron 应用**去测，它的声音**采不到** ——
 * 因为那个应用的音频出自它的**渲染进程**，而渲染进程是它浏览器进程的子进程，
 * 对目标来说是孙子。真正能被采到的，是**自己持有音频流**的直接子进程
 * （实测用一个 Python + `winsound` 的播放进程验的）。
 *
 * 对产品的含义：目标应用自己播的声音一定采得到；它 spawn 出来的子进程里，
 * 那些自己出声的（多数游戏启动器 / 音频助手）也采得到；再往下一层就不行。
 * 验收见 `npm run check:app-audio` 的 Case 3 / Case 4。
 */
export function applicationLoopbackDeviceId(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new RangeError(`不是合法的进程 ID：${String(pid)}`);
  }
  return `applicationLoopback:${pid}`;
}

/**
 * 从 `desktopCapturer` 的 source id 里取出窗口句柄（HWND）。
 *
 * 窗口源的 id 形如 `window:1708206:0`，**中间那段就是 HWND**；屏幕源是
 * `screen:0:0`，没有 HWND。这里只做格式解析，取 PID 要走
 * `win32-window-pid.ts`（FFI）。
 *
 * 解析不出来一律返回 null，不猜 —— 猜错的代价是「共享了另一个应用的声音」
 * 这种看着像成功、实际张冠李戴的失败。
 */
export function parseHwndFromSourceId(sourceId: string): number | null {
  const matched = /^window:(\d+):\d+$/.exec(sourceId);
  if (!matched) return null;
  const hwnd = Number(matched[1]);
  return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null;
}

/** `setDisplayMediaRequestHandler` 回调里 `audio` 字段的类型 */
export type StreamAudio = NonNullable<Electron.Streams['audio']>;

/**
 * 把本文件里的 device id 交给 Electron 的回调。
 *
 * Electron 的类型只声明了 `loopback / loopbackWithMute / WebFrameMain`，
 * 而我们传的是 Chromium 自己的 device id —— 运行时原样透传（这就是上面那些
 * 字符串能生效的全部原因）。类型断言只准出现在这里一处，
 * 别处要是需要它，说明有人又开始自己拼字符串了。
 */
export function asStreamAudio(deviceId: string): StreamAudio {
  return deviceId as StreamAudio;
}
