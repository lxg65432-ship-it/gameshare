/**
 * 麦克风采集（Voice Track）。
 *
 * --- 为什么它必须和系统声音彻底分开 ---
 *
 * 这两路要处理的「回声」是**两件完全不同的事**，约束也正好相反：
 *
 * | | 麦克风 | 系统声音回环 |
 * |---|---|---|
 * | 回声来自 | 扬声器 → **空气** → 麦克风（声学） | 数字信号自己绕回来（反馈环） |
 * | 该开什么 | `echoCancellation` / `noiseSuppression` / `autoGainControl` | **一个都不能开** |
 * | 开了会怎样 | 正好，这就是它的用途 | 音乐和游戏音效被当成噪声削掉、被 AGC 压得忽大忽小 |
 *
 * 所以：**这一套约束只许出现在这里**，`CaptureManager` 那边给桌面捕获的
 * 音频约束必须保持空（那是有意为之，不是漏了）。反过来也一样 ——
 * 麦克风解决不了数字反馈环（loopback 抓的是渲染端点的输出流，不是空气里的声音，
 * 戴耳机也没用），那件事只能靠采集层选对 device id 来解决。
 *
 * --- 关闭必须是真关闭 ---
 *
 * 关麦走 `track.stop()` 释放设备，而不是 `enabled = false`：后者只是让轨道
 * 静音发不出去，**麦克风仍在被占用**（系统托盘上的录音指示灯还亮着），
 * 用户看到那个灯会以为程序在偷听。
 */

export interface MicSettings {
  deviceId: string | null;
  sampleRate: number | null;
  channelCount: number | null;
  /** 下面三个是「约束有没有真的落下去」的唯一凭据 —— 光请求了不算数 */
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
}

export interface MicFailure {
  message: string;
  /** 错误名（NotAllowedError / NotFoundError / NotReadableError…），便于界面分类处理 */
  name: string;
}

export class MicCapture {
  #stream: MediaStream | null = null;
  #track: MediaStreamTrack | null = null;
  #failure: MicFailure | null = null;
  #starting = false;
  /** 设备被拔出时通知上层（与「用户主动关麦」区分开） */
  #onDeviceLost: (() => void) | null = null;

  get track(): MediaStreamTrack | null {
    return this.#track;
  }

  get live(): boolean {
    return this.#track !== null && this.#track.readyState === 'live';
  }

  get failure(): MicFailure | null {
    return this.#failure;
  }

  get settings(): MicSettings | null {
    const track = this.#track;
    if (!track) return null;
    const s = track.getSettings();
    return {
      deviceId: s.deviceId ?? null,
      sampleRate: s.sampleRate ?? null,
      channelCount: s.channelCount ?? null,
      echoCancellation: s.echoCancellation ?? null,
      noiseSuppression: s.noiseSuppression ?? null,
      autoGainControl: s.autoGainControl ?? null,
    };
  }

  /** 设备被拔出 / 被系统回收时回调 */
  onDeviceLost(handler: (() => void) | null): void {
    this.#onDeviceLost = handler;
  }

  /**
   * 开启麦克风。重复调用是幂等的（已经在采就直接返回现有轨道）。
   *
   * 失败**不静默**：这里抛出的错误带着 `name`，调用方要么把它摆给用户，
   * 要么明确改用别的方案 —— 绝不允许悄悄降级成「一路没声音的麦克风轨」，
   * 那会让用户以为自己在说话，其实对面什么都听不到。
   */
  async start(): Promise<MediaStreamTrack> {
    if (this.live && this.#track) return this.#track;
    if (this.#starting) {
      throw new Error('麦克风正在开启中，重复调用请等上一次结果');
    }

    this.#starting = true;
    this.#failure = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const track = stream.getAudioTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('浏览器返回的麦克风流里没有音频轨');
      }

      this.#stream = stream;
      this.#track = track;

      // 设备被拔出 / 被系统回收（拔耳机、USB 声卡掉线）时要能感知到，
      // 否则界面会一直显示「麦克风开」而实际早就没在采了。
      track.addEventListener('ended', () => {
        if (this.#track !== track) return;
        this.stop();
        this.#onDeviceLost?.();
      });

      return track;
    } catch (err) {
      const failure: MicFailure = {
        name: err instanceof Error ? err.name : 'Error',
        message: describeMicError(err),
      };
      this.#failure = failure;
      throw new Error(failure.message);
    } finally {
      this.#starting = false;
    }
  }

  /** 关麦：真正 stop 掉轨道并释放设备 */
  stop(): void {
    if (this.#track) {
      try {
        this.#track.stop();
      } catch {
        // 已停止的轨道重复 stop 会抛，忽略
      }
    }
    if (this.#stream) {
      for (const t of this.#stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // 同上
        }
      }
    }
    this.#track = null;
    this.#stream = null;
  }
}

/**
 * 把 getUserMedia 的错误翻译成「照着做就能修好」的提示。
 *
 * 原文是 `NotAllowedError: Permission denied` 这类术语，用户看到只会以为程序坏了。
 */
function describeMicError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const raw = err instanceof Error ? err.message : String(err);

  switch (name) {
    case 'NotAllowedError':
      return `麦克风权限被拒绝。请到「Windows 设置 → 隐私和安全性 → 麦克风」里允许桌面应用访问麦克风。（原始错误：${raw}）`;
    case 'NotFoundError':
      return `这台机器上没有找到麦克风设备。插上耳机或麦克风后重试。（原始错误：${raw}）`;
    case 'NotReadableError':
      return `麦克风被其他程序占用了（可能是另一个 GameShare 实例或录音软件），关掉它再试。（原始错误：${raw}）`;
    case 'OverconstrainedError':
      return `麦克风不支持要求的参数（回声消除 / 降噪 / 自动增益）。（原始错误：${raw}）`;
    default:
      return `开启麦克风失败：${raw}`;
  }
}
