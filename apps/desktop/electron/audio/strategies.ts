/**
 * 四种音频采集策略 + 能力检测。
 *
 * 业务层（main.ts 的采集 handler、preload、渲染层）只跟「模式」打交道：
 * `application` / `system` / `none`（外加显式开启的 `loopback`）。
 * **device id 的拼装只发生在本文件**，别处不许再拼字符串。
 *
 * 一条硬规矩：**不允许自动静默降级**。
 * 请求 `application` 却拿不到目标进程时，唯一允许的结局是「带着原因失败」，
 * 并附上一个**可选**的替代模式给调用方去决定 —— 绝不自己换成普通 `loopback`。
 * 理由：普通 loopback 会把本机自己的播放（也就是收到的远端语音）一起采进去，
 * 双向共享时直接啸叫。悄悄换过去等于把「有声音」当成「做对了」。
 */

import {
  applicationLoopbackDeviceId,
  LEGACY_LOOPBACK_DEVICE_ID,
  SYSTEM_AUDIO_WITHOUT_SELF_DEVICE_ID,
} from './device-ids';
import { AudioCaptureError, type AudioCaptureMode, type AudioCapabilities, type AudioTarget } from './types';
import { windowPidLookupStatus } from './win32-window-pid';

/** 本机是不是走 Windows 那套回环实现 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * 这套 device id 从哪个版本开始可用。
 *
 * 依据是实测（不是文档推断）：Electron 33.4.11 / Chromium 130 上
 * `applicationLoopback:<pid>` 起不来（采集直接失败），
 * 43.7.2 / Chromium 150 与 44.4.2 / Chromium 152 上正常且隔离彻底。
 * 官方 changelog 里没有这一条，所以只能钉一个版本下限当**静态前置条件** ——
 * 它不代表运行时一定成功，真正的判据永远是「采到了什么内容」（见 check:app-audio）。
 */
const MIN_ELECTRON_MAJOR = 43;

function electronMajor(): number {
  const major = Number.parseInt(process.versions.electron.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

function electronSupportsLoopbackVariants(): boolean {
  return electronMajor() >= MIN_ELECTRON_MAJOR;
}

/**
 * 普通 loopback（整机混音，含自己）属于**高级兼容模式**：
 * 必须显式打这个环境变量才允许使用，界面不会主动给。
 *
 * 用一个显式开关而不是「反正能用就用」，就是为了让「静默降级」在代码上
 * 根本不成立：没有这个变量时，请求 loopback 会直接报错。
 */
export function rawLoopbackAllowed(): boolean {
  return process.env.GAMESHARE_ALLOW_RAW_LOOPBACK === '1';
}

export interface StrategyCapability {
  available: boolean;
  reason: string | null;
}

export interface AudioCaptureStrategy {
  readonly mode: AudioCaptureMode;
  /** 界面上的名字 */
  readonly label: string;
  /** 是否正式方案（false = 调试 / 高级兼容，不该作为正常选项暴露） */
  readonly official: boolean;
  /** 这个模式打算做什么，用于能力报告与失败文案 */
  readonly summary: string;
  capability(target: AudioTarget | null): StrategyCapability;
  /** 解析成交给 `setDisplayMediaRequestHandler` 的 device id；null = 这次不要音频 */
  resolve(target: AudioTarget | null): string | null;
}

/** 只采所选应用（及其**直接**子进程）的声音 */
export const ApplicationAudioCapture: AudioCaptureStrategy = {
  mode: 'application',
  label: '应用声音',
  official: true,
  summary: '只共享所选应用及其子进程的声音，其他应用与本机自己的播放都不含',

  capability(target) {
    if (!IS_WINDOWS) {
      return { available: false, reason: `按应用采集声音目前只有 Windows 实现（当前 ${process.platform}）` };
    }
    if (!electronSupportsLoopbackVariants()) {
      return {
        available: false,
        reason: `需要 Electron ${MIN_ELECTRON_MAJOR}+（当前 ${process.versions.electron}），低版本 Chromium 还没接上按进程回环`,
      };
    }
    const ffi = windowPidLookupStatus();
    if (!ffi.available) {
      return { available: false, reason: `拿不到窗口所属进程：${ffi.detail}` };
    }
    if (target && (target.kind === 'screen' || target.pid === null)) {
      return {
        available: false,
        reason:
          '屏幕源没有所属应用（或者这个窗口已经取不到进程了）——「按应用」要选一个窗口；' +
          '想共享整机声音请改用整机方案',
      };
    }
    return { available: true, reason: null };
  },

  resolve(target) {
    const state = this.capability(target);
    if (!state.available) {
      throw new AudioCaptureError({
        code: IS_WINDOWS ? 'pid-unavailable' : 'unsupported-platform',
        message: `不能按应用采集声音：${state.reason}`,
        // 整机声音是**可选**替代，不是自动换过去
        suggestion: 'system',
      });
    }
    if (!target || target.pid === null) {
      throw new AudioCaptureError({
        code: 'pid-unavailable',
        message: '不能按应用采集声音：这次采集没有绑定到具体的应用窗口。',
        suggestion: 'system',
      });
    }
    return applicationLoopbackDeviceId(target.pid);
  },
};

/** 整机声音，但排除本 Electron 实例自己的播放 */
export const SystemAudioCapture: AudioCaptureStrategy = {
  mode: 'system',
  label: '整机声音（不含本软件）',
  official: true,
  summary: '共享全部电脑声音，但排除本软件自己播放的声音（避免把自己发出去的远端语音采回来）',

  capability() {
    if (!IS_WINDOWS) {
      return { available: false, reason: `系统回环采集目前只有 Windows 实现（当前 ${process.platform}）` };
    }
    if (!electronSupportsLoopbackVariants()) {
      return {
        available: false,
        reason: `需要 Electron ${MIN_ELECTRON_MAJOR}+（当前 ${process.versions.electron}）`,
      };
    }
    return { available: true, reason: null };
  },

  resolve(target) {
    void target; // 整机声音与选了哪个窗口/屏幕无关
    const state = this.capability(null);
    if (!state.available) {
      throw new AudioCaptureError({
        code: IS_WINDOWS ? 'ffi-unavailable' : 'unsupported-platform',
        message: `不能采集系统声音：${state.reason}`,
      });
    }
    return SYSTEM_AUDIO_WITHOUT_SELF_DEVICE_ID;
  },
};

/** 不要声音 */
export const NoAudio: AudioCaptureStrategy = {
  mode: 'none',
  label: '不含声音',
  official: true,
  summary: '只共享画面',

  capability() {
    return { available: true, reason: null };
  },

  resolve() {
    return null;
  },
};

/** 普通整机混音。**调试 / 高级兼容**，需要显式开启 */
export const RawLoopbackCapture: AudioCaptureStrategy = {
  mode: 'loopback',
  label: '整机声音（含本软件，调试用）',
  official: false,
  summary: '包含本软件自己的播放，双向共享会啸叫；只在排查问题时使用',

  capability() {
    if (!IS_WINDOWS) {
      return { available: false, reason: `系统回环采集目前只有 Windows 实现（当前 ${process.platform}）` };
    }
    if (!rawLoopbackAllowed()) {
      return {
        available: false,
        reason: `普通整机混音已不是正式方案（会把本软件自己的播放一起采进来）。确需使用请显式设置 GAMESHARE_ALLOW_RAW_LOOPBACK=1`,
      };
    }
    return { available: true, reason: null };
  },

  resolve() {
    const state = this.capability(null);
    if (!state.available) {
      throw new AudioCaptureError({ code: 'raw-loopback-not-allowed', message: state.reason ?? '不可用' });
    }
    return LEGACY_LOOPBACK_DEVICE_ID;
  },
};

const STRATEGIES: Record<AudioCaptureMode, AudioCaptureStrategy> = {
  application: ApplicationAudioCapture,
  system: SystemAudioCapture,
  none: NoAudio,
  loopback: RawLoopbackCapture,
};

export function audioCaptureStrategy(mode: AudioCaptureMode): AudioCaptureStrategy {
  return STRATEGIES[mode];
}

/** 模式的展示名，用于日志与失败文案 */
export function describeMode(mode: AudioCaptureMode): string {
  return STRATEGIES[mode].label;
}

export interface ResolvedAudio {
  mode: AudioCaptureMode;
  /** 交给 setDisplayMediaRequestHandler 的值；null = 不要音频 */
  deviceId: string | null;
}

/**
 * 把「模式 + 目标」解析成 Chromium 的 device id。
 *
 * 不可用时**抛错**（带 code 与 suggestion），不做任何自动替换。
 * 调用方要负责把原因原样交给用户（走 `capture:take-failure`）。
 */
export function resolveAudioDevice(
  mode: AudioCaptureMode,
  target: AudioTarget | null,
): ResolvedAudio {
  const strategy = STRATEGIES[mode];
  return { mode, deviceId: strategy.resolve(target) };
}

/** 能力总表。给界面（将来的设置项）与验收脚本用 */
export function audioCapabilities(): AudioCapabilities {
  const ffi = windowPidLookupStatus();
  return {
    platform: process.platform,
    electron: process.versions.electron,
    ffi,
    modes: (Object.keys(STRATEGIES) as AudioCaptureMode[]).map((mode) => {
      const strategy = STRATEGIES[mode];
      // 目标未知时按「有没有窗口源」问一次，拿到的是「前置条件」层面的答案
      const state = strategy.capability(null);
      return {
        mode,
        label: strategy.label,
        official: strategy.official,
        available: state.available,
        reason: state.reason,
      };
    }),
  };
}
