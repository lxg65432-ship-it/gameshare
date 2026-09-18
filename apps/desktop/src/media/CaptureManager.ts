/**
 * 画面采集。
 *
 * 两种来源：
 * - startDisplay() 走真实桌面/窗口捕获（Electron 主进程 desktopCapturer + getDisplayMedia）
 * - startTestPattern() 用 canvas 合成一路动画画面
 *
 * 合成源不是玩具：自动化验收要在无人值守的机器上跑真实 WebRTC 链路，
 * 而真实捕获需要屏幕权限、依赖当前桌面内容是否在动，做断言会飘。
 * 用合成源可以把「链路通了」和「捕获权限拿到了」两件事分开验证。
 */

import type { AudioCaptureFailure, AudioCaptureMode } from '../types/global';

export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  /** JPEG data URL，用于源选择列表的缩略图 */
  thumbnail: string | null;
  appIcon: string | null;
  /**
   * 窗口源所属进程的 PID，屏幕源为 null。
   *
   * 界面要凭它判断「这个源能不能按应用共享声音」—— 为 null 时那种模式对它是不可用的
   * （主进程会拒绝，不会悄悄退回整机声音）。
   */
  pid: number | null;
}

export interface TestPatternOptions {
  label?: string;
  width?: number;
  height?: number;
  fps?: number;
  /**
   * 合成源那路声音的频率（Hz），默认 440。
   *
   * 可配是为了验收：三轨隔离要**按角色灌互不相同的已知频率**再做频谱分离，
   * 否则「某条轨里有没有别人的声音」这件事没有参照物可量。
   */
  toneHz?: number;
  /**
   * 合成音的幅度（0~1），默认 0.002。
   *
   * 默认值刻意压得很低（长时间自动化跑起来不至于吵人）；只有需要做频谱断言时
   * 才调高。**不能设 0**：全零会被编码器当静音优化掉，对端就算收到轨道也没有数据。
   */
  toneGain?: number;
}

export interface StartDisplayOptions {
  /**
   * 是否要声音。**这是老界面的布尔开关**，渲染层内部会翻译成 audioMode：
   * `true → 'system'`、`false → 'none'`。
   *
   * 与 audioMode 同时给时以 audioMode 为准。
   */
  withAudio?: boolean;
  /**
   * 要哪一种声音。业务层只表达这个，不许自己拼 Chromium 的 device id。
   *
   * - `application` —— 只共享所选应用（及其进程树）的声音；窗口共享的正式方案
   * - `system` —— 整机声音，但排除本软件自己（默认就是它）
   * - `none` —— 不要声音
   * - `loopback` —— 普通整机混音，**调试 / 高级兼容**，需要显式开启
   *
   * 拿不到声音时**不会**自动换到别的模式：要么带着原因失败，要么（画面是主体时）
   * 降级为**无声**画面并把原因记在 `audioError` 里。
   */
  audioMode?: AudioCaptureMode;
}

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export class CaptureManager {
  #stream: MediaStream | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #sourceLabel: string | null = null;
  #onSourceEnded: (() => void) | null = null;
  #framesDrawn = 0;
  #lastDrawError: string | null = null;
  /** 合成源的测试音，stop() 时要显式释放，否则 AudioContext 会一直挂着 */
  #tone: { context: AudioContext; oscillator: OscillatorNode } | null = null;
  /** 这次采集带声音失败的原因；有值时说明已降级为**无声**画面（不是换成别的音频模式） */
  #audioError: string | null = null;
  /** 这次 startDisplay 实际请求的音频模式；UI 显示「当前声音状态」用 */
  #lastAudioMode: AudioCaptureMode | null = null;
  /**
   * 这次音频失败的完整信息（含主进程给的可选替代模式）。
   *
   * 单独存一份是因为它是**给调用方决策用的**：`#audioError` 只是一句给人看的文案，
   * 而「要不要换一种模式再试一次」要看 `suggestion`。换不换由调用方决定，
   * 采集层永远不自作主张。
   */
  #audioFailure: AudioCaptureFailure | null = null;

  get stream(): MediaStream | null {
    return this.#stream;
  }

  get track(): MediaStreamTrack | null {
    return this.#stream?.getVideoTracks()[0] ?? null;
  }

  /** 系统声音轨；采集不到时为 null（非 Windows、不支持的模式、或初始化失败） */
  get audioTrack(): MediaStreamTrack | null {
    return this.#stream?.getAudioTracks()[0] ?? null;
  }

  get audioError(): string | null {
    return this.#audioError;
  }

  /** 最近一次 startDisplay 请求的音频模式；从未真实采集过时为 null */
  get lastAudioMode(): AudioCaptureMode | null {
    return this.#lastAudioMode;
  }

  /**
   * 音频失败详情（含 `suggestion`）；没失败时为 null。
   *
   * 语义上要拎清：拿到 `suggestion` **不等于**已经换过去了。采集层不会自动降级，
   * 调用方要么明确改用那个模式再调一次，要么把原因摆给用户。
   */
  get audioFailure(): AudioCaptureFailure | null {
    return this.#audioFailure;
  }

  get sourceLabel(): string | null {
    return this.#sourceLabel;
  }

  /** 合成源自绘帧数。用来区分「定时器没跑」和「跑了但编码器不收」 */
  get framesDrawn(): number {
    return this.#framesDrawn;
  }

  get lastDrawError(): string | null {
    return this.#lastDrawError;
  }

  /**
   * 采集源的实际编码高度。
   *
   * QualityManager 换算 scaleResolutionDownBy 必须用这个值当下限基准，
   * 不能用显示器分辨率 —— 采集的可能只是一个 600p 高的窗口。
   */
  get sourceHeight(): number | null {
    const settings = this.track?.getSettings();
    return settings?.height ?? null;
  }

  /** 源被关闭（用户关掉被共享的窗口）时回调，M2 用它弹提示 */
  onSourceEnded(handler: (() => void) | null): void {
    this.#onSourceEnded = handler;
  }

  /* ---------------- 枚举 ---------------- */

  async listSources(): Promise<CaptureSourceInfo[]> {
    const api = window.gameShare?.capture;
    if (!api) {
      throw new CaptureError('当前不在 Electron 环境，无法枚举采集源');
    }
    return api.listSources();
  }

  /* ---------------- 真实捕获 ---------------- */

  async startDisplay(sourceId: string, options: StartDisplayOptions = {}): Promise<MediaStream> {
    const api = window.gameShare?.capture;
    if (!api) throw new CaptureError('当前不在 Electron 环境，无法采集屏幕');

    /**
     * 老界面只给一个布尔开关，这里翻译成模式。
     *
     * `true / 未指定 → 'system'`（整机声音，但排除本软件自己）—— **刻意不是 `loopback`**：
     * 普通整机混音会把本软件自己的播放一起采进去，而收到的远端语音正是从本机
     * 扬声器出来的，双向共享时直接啸叫。这个翻译只在这里发生一次；
     * 别处一律直接传 `audioMode`。界面的正式默认（窗口共享 → `application`）
     * 由 UI 层显式传入，不靠这里兜底。
     */
    const mode: AudioCaptureMode =
      options.audioMode ?? (options.withAudio === false ? 'none' : 'system');
    this.#lastAudioMode = mode;

    this.#audioError = null;
    this.#audioFailure = null;

    // 先把「采哪个源 + 要哪一种声音」交给主进程：getDisplayMedia 的 request handler
    // 拿不到约束，只能靠这里传过去的值决定回哪一路。
    // 两边不一致时 Chromium 会让采集整个失败。
    await api.selectSource(sourceId, { audioMode: mode });

    let stream: MediaStream;
    try {
      stream = await this.#requestDisplay(mode !== 'none');
    } catch (err) {
      /**
       * 主进程主动拒绝时会留下原因（选定的窗口已不在可捕获列表里、音频模式解析不出来…）。
       * 这条比 getDisplayMedia 抛的 NotAllowedError 有用得多，直接采用 ——
       * 而且**不重试**：主进程已经明确说了这次不行，再试一次还是不行。
       */
      const failure = await api.takeFailure().catch(() => null);
      if (failure) {
        this.#audioFailure = failure;
        this.#audioError = failure.message;
        throw new CaptureError(failure.message);
      }

      if (mode === 'none') {
        throw new CaptureError(`获取画面失败：${err instanceof Error ? err.message : String(err)}`);
      }

      /**
       * 带声音失败时不连画面一起放弃 —— 画面是主体，声音是附加。
       *
       * 降级到的是**无声**，不是换成别的音频模式：普通 loopback 已经不在候选里
       * （它会把本机自己的播放采回去），而换成整机方案这种事必须由调用方
       * 显式决定 —— 想换就读 `audioFailure.suggestion` 再调一次，
       * 采集层不替用户做这个选择。
       */
      const detail = err instanceof Error ? err.message : String(err);
      this.#audioError = `按「${await this.#modeLabel(mode)}」采集声音失败：${detail}`;
      this.#audioFailure = { message: this.#audioError, failedMode: mode, suggestion: null };

      try {
        // 主进程那边要同步改成不要音频，否则约束对不上会再失败一次
        await api.selectSource(sourceId, { audioMode: 'none' });
        stream = await this.#requestDisplay(false);
      } catch (retryErr) {
        const retryFailure = await api.takeFailure().catch(() => null);
        throw new CaptureError(
          retryFailure?.message ??
            `获取画面失败：${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        );
      }
    }

    this.stop();
    const track = stream.getVideoTracks()[0];
    const name = track?.label || sourceId;
    this.#adopt(stream, name);
    return stream;
  }

  /**
   * 模式的展示名。
   *
   * 从主进程的能力表里取，渲染层**不再抄一份文案**（两份文案迟早漂移），
   * 而且只在失败路径上才付这一次 IPC。取不到就退回模式 id。
   */
  async #modeLabel(mode: AudioCaptureMode): Promise<string> {
    const api = window.gameShare?.capture;
    if (!api) return mode;
    const caps = await api.getAudioCapabilities().catch(() => null);
    return caps?.modes.find((m) => m.mode === mode)?.label ?? mode;
  }

  /**
   * 请求一路桌面捕获。
   *
   * **音频那三件套必须显式关掉，不能「什么都不写」。**
   *
   * 这里原先写的是 `audio: withAudio`，注释里的理由是「不加约束就不会给回环套上
   * echoCancellation / noiseSuppression 那套给麦克风设计的东西」。**方向对，做法错**：
   * `audio: true` 不等于「无约束」，它等于「用默认值」，而 Chromium 对桌面捕获音频的
   * 默认值恰恰是三项全开。实测（三轨验收 isolation 轮打出来的 `getSettings()`）：
   *
   *   { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, … }
   *
   * 后果有两层，第二层才是致命的：
   *
   *   1. 共享出去的是**被处理过**的声音 —— 降噪削音乐与音效、AGC 把电平压平，
   *      正是当初想避免的那件事；
   *   2. **回声消除会按「本机此刻在播什么」去减采集到的声音**，而本机在播的正是收到的
   *      远端语音（以及其它窗口在播的这份应用声音）。于是一条本该由进程隔离保证干净的回环，
   *      被一个自适应抵消器接管：实测目标应用自己的频点被减掉 **47 dB**
   *      （停掉本机播放之后同一路立刻回到干净电平），四路远端语音则以**残余回声**
   *      的形式漏回来，隔离度只剩 5~11 dB。
   *
   * 换句话说：**AEC 开着的时候，「数字反馈环断没断」这件事根本没有被验证 ——
   * 它只是被一个抵消器盖住了，而且盖得并不严。**
   *
   * 麦克风那条路相反：`getUserMedia` 里三项都要开着（见 `MicCapture`）。
   */
  #requestDisplay(withAudio: boolean): Promise<MediaStream> {
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: withAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });
  }

  /* ---------------- 合成源（自动化验收 / 无权限场景） ---------------- */

  startTestPattern(options: TestPatternOptions = {}): MediaStream {
    const width = options.width ?? 640;
    const height = options.height ?? 360;
    const fps = options.fps ?? 30;
    const label = options.label ?? 'TEST';

    // 必须在建定时器之前收尾上一路，否则会把自己的定时器一起清掉
    this.stop();
    this.#framesDrawn = 0;
    this.#lastDrawError = null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CaptureError('无法创建 2D 画布上下文');

    const startedAt = performance.now();
    const hue = (label.charCodeAt(label.length - 1) * 47) % 360;

    const draw = (): void => {
      try {
        const t = (performance.now() - startedAt) / 1000;
        const frame = Math.round(t * fps);

        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, `hsl(${(hue + t * 24) % 360} 55% 16%)`);
        gradient.addColorStop(1, `hsl(${(hue + 120 + t * 24) % 360} 55% 26%)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // 网格：压缩后网格线最容易糊，是判断画质的直观参照
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= width; x += 40) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, height);
          ctx.stroke();
        }
        for (let y = 0; y <= height; y += 40) {
          ctx.beginPath();
          ctx.moveTo(0, y + 0.5);
          ctx.lineTo(width, y + 0.5);
          ctx.stroke();
        }

        // 圆周运动标记：一眼看出画面是活的还是冻住了
        const cx = width / 2 + Math.cos(t * 1.8) * width * 0.3;
        const cy = height / 2 + Math.sin(t * 1.8) * height * 0.3;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.round(height * 0.06), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(height * 0.22)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, width / 2, height * 0.36);

        ctx.font = `${Math.round(height * 0.09)}px "Consolas", monospace`;
        ctx.fillText(`${frame}  ${width}x${height}@${fps}`, width / 2, height * 0.62);

        this.#framesDrawn += 1;
      } catch (err) {
        // 定时器里抛异常不会中断 interval，但会每帧刷屏；记一次用于诊断
        this.#lastDrawError = err instanceof Error ? err.message : String(err);
      }
    };

    draw();
    // 刻意不用 requestAnimationFrame：窗口隐藏时 rAF 会被节流甚至停摆，
    // 定时器配合 backgroundThrottling:false 才能稳定出帧。
    const timer = setInterval(draw, Math.round(1000 / fps));

    const stream = canvas.captureStream(fps);
    this.#canvas = canvas;
    this.#timer = timer;
    this.#startTestTone(stream, options.toneHz ?? 440, options.toneGain ?? 0.002);
    this.#adopt(stream, `合成源 ${label}（${width}x${height}@${fps}）`);
    return stream;
  }

  /**
   * 给合成源配一路极小音量的正弦音。
   *
   * 目的是让自动化验收能断言「音频轨道真的到了对端」—— 真实采集在无人值守
   * 的机器上要么没音频设备、要么声音内容一直在变，做不了稳定断言。
   * 音量不能设 0：全零会被编码器当静音优化掉，对端就算收到轨道也没有数据。
   */
  #startTestTone(stream: MediaStream, toneHz: number, toneGain: number): void {
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();

      oscillator.type = 'sine';
      oscillator.frequency.value = toneHz;
      gain.gain.value = toneGain;

      oscillator.connect(gain).connect(destination);
      oscillator.start();

      const track = destination.stream.getAudioTracks()[0];
      if (!track) {
        void context.close();
        return;
      }
      stream.addTrack(track);
      this.#tone = { context, oscillator };
    } catch (err) {
      // 没有音频设备的机器不该让合成源整个失败 —— 画面对验收才是主体
      this.#lastDrawError = `合成音不可用：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /* ---------------- 生命周期 ---------------- */

  #adopt(stream: MediaStream, label: string): void {
    this.#stream = stream;
    this.#sourceLabel = label;

    const track = stream.getVideoTracks()[0];
    if (track) {
      // 被采集的窗口/屏幕被关闭时浏览器会 end 掉轨道，必须能感知到
      track.addEventListener('ended', () => {
        if (this.#stream !== stream) return;
        this.stop();
        this.#onSourceEnded?.();
      });
    }
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    // 测试音是独立于采集流的资源，不显式收掉的话 AudioContext 会一直占着音频设备
    if (this.#tone) {
      try {
        this.#tone.oscillator.stop();
      } catch {
        // 已停止的 oscillator 重复 stop 会抛，忽略
      }
      void this.#tone.context.close().catch(() => undefined);
      this.#tone = null;
    }
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // 已停止的轨道重复 stop 会抛，忽略
        }
      }
    }
    // 把画布尺寸清零，主动释放那块显存/内存，M10 四人长跑时会有意义
    if (this.#canvas) {
      this.#canvas.width = 0;
      this.#canvas.height = 0;
      this.#canvas = null;
    }
    this.#stream = null;
    this.#sourceLabel = null;
  }
}
