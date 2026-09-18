/**
 * 应用音频采集的公共类型。
 *
 * 为什么单独有一层抽象，而不是各处直接拼 device id：
 * Chromium 那几个回环 device id（`loopbackWithoutChrome`、`applicationLoopback:<pid>`…）
 * 在 Electron 的 `Streams.audio` 类型里**根本不存在** —— 类型上只有
 * `loopback | loopbackWithMute | WebFrameMain`，它们能生效纯粹是因为
 * Electron 把字符串**原样透传**给 Chromium 当 device id（实测见 `docs/APP-AUDIO-POC.md`）。
 * 也就是说：编译器管不住这些字符串，写错一个字母只会得到一条语焉不详的采集失败。
 *
 * 所以约定是：**字面量只准出现在 `device-ids.ts` 一处**，业务层只表达下面四种模式。
 */

/**
 * 四种采集模式。
 *
 * - `application` —— 只采所选应用**及其进程树**的声音（`applicationLoopback:<pid>`）。
 *   窗口共享的正式方案：别的应用、本机自己的播放都不进来。
 * - `system` —— 采全部电脑声音，但**排除本 Electron 实例自己**的播放
 *   （`loopbackWithoutChrome`）。共享整机声音时的正式方案，顺带断掉
 *   「把自己播出去的远端语音又采回来」那条啸叫环。
 * - `none` —— 不要声音。
 * - `loopback` —— 普通整机混音（`loopback`）。**不是正式方案**：它会把本机自己的
 *   播放一起采进去。只作为调试 / 高级兼容模式，必须显式开启，永远不自动落到这里。
 */
export type AudioCaptureMode = 'application' | 'system' | 'none' | 'loopback';

/** 运行时校验用（IPC 来的值不可信）。顺序 = 界面上的展示顺序 */
export const AUDIO_CAPTURE_MODES: readonly AudioCaptureMode[] = [
  'application',
  'system',
  'none',
  'loopback',
];

export function isAudioCaptureMode(value: unknown): value is AudioCaptureMode {
  return typeof value === 'string' && (AUDIO_CAPTURE_MODES as readonly string[]).includes(value);
}

/** 一次采集的目标：选中的那个源，以及它对应的进程（能取到的话） */
export interface AudioTarget {
  /** desktopCapturer 的 source id，形如 `window:1708206:0` / `screen:0:0` */
  sourceId: string;
  kind: 'window' | 'screen';
  /** 窗口源对应的 PID；屏幕源、或 FFI 不可用时为 null */
  pid: number | null;
}

export type AudioCaptureErrorCode =
  /** 非 Windows：Chromium 的这几个回环 id 只在 Windows 上有实现 */
  | 'unsupported-platform'
  /** FFI 拿不到（koffi 没装上 / 被打包漏掉）→ 取不到 PID，按应用采集无从谈起 */
  | 'ffi-unavailable'
  /** 源本身取不到 PID（屏幕源、窗口已消失、句柄失效） */
  | 'pid-unavailable'
  /** 请求了普通 loopback 但没有显式开启高级兼容模式 */
  | 'raw-loopback-not-allowed';

export interface AudioCaptureErrorInit {
  code: AudioCaptureErrorCode;
  message: string;
  /**
   * 建议改用的模式。**这只是「给调用方一个可选的下一步」，不是自动降级** ——
   * 采不到就是采不到，绝不悄悄换成普通 loopback 让用户以为成功了。
   */
  suggestion?: AudioCaptureMode | null;
}

/**
 * 音频采集的失败。
 *
 * 刻意区分「取不到目标进程」和「平台不支持」这类原因：调用方要把原因原样
 * 带到界面上（`capture:take-failure`），一句笼统的「采集失败」没法排查。
 */
export class AudioCaptureError extends Error {
  readonly code: AudioCaptureErrorCode;
  readonly suggestion: AudioCaptureMode | null;

  constructor(init: AudioCaptureErrorInit) {
    super(init.message);
    this.name = 'AudioCaptureError';
    this.code = init.code;
    this.suggestion = init.suggestion ?? null;
  }
}

/**
 * 一次采集失败的完整信息，走 `capture:take-failure` 交给渲染层。
 *
 * `suggestion` 是**可选**的替代模式。渲染层可以据此再问一次用户，
 * 但绝不能自己直接换过去 —— 那正好是「静默降级」。
 */
export interface AudioCaptureFailure {
  message: string;
  /** 失败时请求的是哪种音频模式 */
  failedMode: AudioCaptureMode | null;
  /** 可选的替代模式（例如 application 失败时建议 system）；不代表已经换过去 */
  suggestion: AudioCaptureMode | null;
}

/** 某一种模式在本机的可用性 */
export interface AudioModeCapability {
  mode: AudioCaptureMode;
  /** 展示名（界面与失败文案都用它，避免渲染层再抄一份） */
  label: string;
  /** 是否正式方案。false = 调试 / 高级兼容，界面上不该作为正常选项 */
  official: boolean;
  /** 静态前置条件是否满足。**不代表运行时一定起得来**（见 capability 里的说明） */
  available: boolean;
  /** 不可用 / 需要提醒时的原因 */
  reason: string | null;
}

export interface AudioCapabilities {
  platform: string;
  /** HWND → PID 这条链的可用性 */
  ffi: { available: boolean; detail: string };
  electron: string;
  modes: AudioModeCapability[];
}
