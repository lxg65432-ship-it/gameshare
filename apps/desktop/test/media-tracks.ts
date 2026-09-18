/**
 * 三轨媒体结构的验收页面（对应 ARCHITECTURE 4.16）。
 *
 * 与 `harness.ts` 的分工：
 *   harness.ts        验「链路通不通、画质档位对不对」（视频为主体）
 *   media-tracks.ts   验「三条轨各自的绑定、角色、以及会不会互相串线」
 *
 * --- 为什么要分两轮（mode）---
 *
 * `structure` 轮 —— 一个人共享、其余只开麦，验结构：
 *   · 三条 m-line 的顺序与类型
 *   · mid → 角色 两端一致
 *   · 三条轨各自挂对，且 voice 与 appAudio 不是同一条
 *   · 接收端按角色分得开
 *   · 生命周期：关麦→再开、关应用声音但画面继续→再开、换源旧轨真的没了、停止共享不关麦
 *   · 交叉串线：给两条音频轨灌**不同频率**，断言谁也没混进谁
 *
 * `isolation` 轮 —— 四人模型，验**数字反馈环**：
 *   这一轮才是任务书里那句「A 的 App Audio Track 里不得出现 Voice B/C/D」的正面回答。
 *   结构轮用的是**合成源**当应用声音，那条轨里本来就不可能混进语音 ——
 *   断言必然绿，却证明不了任何事。要真的验它，必须让：
 *
 *     1. A 走**真实桌面捕获**（`getDisplayMedia` + 真 `setDisplayMediaRequestHandler`），
 *        音频模式用窗口共享的正式方案 `application`（`applicationLoopback:<pid>`）；
 *     2. 被共享的那个应用是**另一个独立进程**在出声（`_probe-audio-app.cjs`），
 *        它同时充当「必须被采到」的正对照；
 *     3. A 把 B/C/D 的语音**真的播到扬声器上**（`<audio>` 元素，与产品里同一套做法）
 *        —— 这才是反馈环的那半截：远端语音变成了本机的声学输出。
 *
 *   然后断言：A 的 appAudio 里**有**噪声源那个频率、**没有**任何一个人的语音频率。
 *   反过来还要有**对照组**：B 收到 A 的 voice 里必须**有** A 的语音频率 ——
 *   否则「appAudio 里没有语音」可能只是因为语音那条链路压根没通（最典型的假绿）。
 *
 * --- 频率是算出来的，不是随手挑的 ---
 *
 * 六个频点两两相隔 ≥300 Hz，且任何两个同时在场的频率，它的二 / 三次谐波与和差产物
 * 都不落在别人的 ±25 Hz 带里 —— 否则互调产物会被判成「听见了那个频率」，
 * 断言就变成假红或假绿。挑法见 `scripts/check-media-tracks.mjs` 的 `verifyFreqPlan()`。
 *
 * --- 角色识别一律走 mid ---
 *
 * 见 `packages/protocol/src/media-roles.ts`。不看 `getAudioTracks()[0]` 那种会漂的下标。
 */

import {
  ROLE_MEDIA_KIND,
  TRACK_ROLES,
  roleForMid,
  type TrackRole,
} from '@game-share/protocol';

import { extractMediaLines } from '../src/rtc/PeerLink';
import { ShareSession } from '../src/session/ShareSession';

interface HarnessBridge {
  ready: () => void;
  log: (line: string) => void;
  announceRoomCode: (code: string) => void;
  report: (payload: Record<string, unknown>) => void;
  waitGo: () => Promise<void>;
  waitRoomCode: () => Promise<string>;
  phaseReady: (name: string) => void;
  waitPhase: (name: string) => Promise<void>;
}

declare global {
  interface Window {
    harnessBridge?: HarnessBridge;
  }
}

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const INDEX = Number(params.get('index') ?? '0');
const TOTAL = Number(params.get('total') ?? '4');
const SIGNALING_URL = params.get('url') ?? 'http://127.0.0.1:8080';
const PHASE_MS = Number(params.get('timeout') ?? '45000');
const NICKNAME = `P${INDEX}`;

/** `structure`（结构 + 生命周期）或 `isolation`（真实回环下的数字反馈环） */
const MODE: 'structure' | 'isolation' = params.get('mode') === 'isolation' ? 'isolation' : 'structure';

/** 只有 0 号共享画面；其余人只开麦 —— 正是需求里那个 A/B/C/D 模型 */
const IS_SHARER = INDEX === 0;

/**
 * **频点由驱动脚本传入，页面不自己写一份。**
 *
 * 理由和「device id 只有一个产地」完全一样：两份常量迟早漂移，而漂移的后果是
 * 断言悄悄失去意义（量的频率跟灌的频率不是一回事，读出来永远是「没有」）。
 * 数值的合法性（两两间隔、谐波与和差产物）由 `scripts/check-media-tracks.cjs`
 * 的 `verifyFreqPlan()` 统一把关。
 */
const VOICE_HZ = String(params.get('voicehz') ?? '620,980,1300,1680')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
if (VOICE_HZ.length < 4) throw new Error(`voicehz 参数不合法：${params.get('voicehz')}`);

const MY_VOICE_HZ = VOICE_HZ[INDEX] ?? VOICE_HZ[VOICE_HZ.length - 1]!;

/** 结构轮：假麦克风 WAV 的频率（由驱动脚本生成，两边必须同一个数） */
const HZ_MIC = Number(params.get('michz') ?? '1200');
/**
 * 结构轮：合成源那路声音的频率。
 *
 * **必须落在假麦克风那条轨的频谱缝隙里。** 实测（`scripts/_probe-fake-mic.mjs`）：
 * 灌进去一个纯正弦，量回来的是一条**旁带梳**，主音 ± 250k Hz 都有一条，
 * 幅度与主音差不多少（1200 的那次量到 199 / 451 / 697 / 949 / 1201 / 1447 /
 * 1699 / 1951……全是 `1200 ± 250k`）。于是第一版的 440 Hz 正好撞在
 * `1200 − 750 = 450` 那条旁带上 —— 判据窗口只有 ±12 Hz，读出来
 * 「voice 上的 440 比 1200 只低 0.7 dB」，看着像串音，其实是**仪器自己的鬼影**。
 *
 * 2825 = 1200 + 1625 = 1200 + 6.5×250，**正落在两条旁带（2700 / 2950）正中间**，
 * 离哪一条都有 125 Hz，比判据窗口宽十倍。
 */
const HZ_APP = Number(params.get('apphz') ?? '2825');

/** isolation 轮：被共享的那个独立应用的频率，与窗口标题 */
const NOISE_HZ = Number(params.get('noisehz') ?? '2100');
const NOISE_TITLE = params.get('noisetitle') ?? 'PROBE-MEDIA-NOISE';

/** isolation 轮的音频模式；窗口共享的正式方案是按应用 */
const APP_AUDIO_MODE = (params.get('appmode') ?? 'application') as 'application' | 'system';

/**
 * 这一轮用的是不是**假麦克风设备**（`--use-fake-device-for-media-stream`）。
 *
 * 必须显式断言一次：那个开关是**按进程**给 Chromium 的，没生效的话
 * `getUserMedia` 会安静地回落到本机真实麦克风 —— 界面照常显示「已开启」、
 * 三个约束照常为 true，只是**内容不是我们灌的那个频率**，
 * 于是频谱判据会变成「跟自己较劲」。
 */
const USING_FAKE_MIC = params.get('fakemic') === '1';

/** 判「这个频点里有能量」时，比本底高多少 dB 才算有（正对照用） */
const MARGIN_OVER_FLOOR = 20;
/** 判「这个频点里没有别的东西」时，要比本路已知一定在的那个频率低多少 dB */
const MARGIN_SEPARATION = 20;
/** 频谱测量时长 */
const MEASURE_MS = 2_500;

const bridge = window.harnessBridge;

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

const statusEl = document.getElementById('status');
const lines: string[] = [];

function say(line: string): void {
  lines.push(line);
  if (statusEl) statusEl.textContent = lines.slice(-26).join('\n');
  bridge?.log(`[P${INDEX}] ${line}`);
}

const checks: Array<{ ok: boolean; label: string; detail?: string }> = [];

function check(label: string, ok: boolean, detail?: string): boolean {
  checks.push({ ok, label, detail });
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  return ok;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(150);
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）`);
}

/**
 * 等相位屏障，但**带超时**。
 *
 * 屏障的语义是「所有窗口都到达了某一步」—— 所以它天然是个可能永远不兑现的承诺：
 * 只要有任何一个窗口在到达之前就失败退出，其余人就会一直挂在那里，最后被
 * harness 的总超时一起判死，日志里只剩一句「未上报」。加个上限之后，
 * 失败的那一方照常失败，其余人还能把自己的检查项报出来。
 */
async function waitPhaseBounded(name: string, ms: number): Promise<void> {
  const wait = bridge?.waitPhase(name) ?? Promise.resolve();
  await Promise.race([wait, sleep(ms)]);
}

/* ------------------------------------------------------------------ *
 * 频谱测量（与 check-app-audio.cjs 同一套教训：逐帧中位数，不取时间峰值）
 * ------------------------------------------------------------------ */

interface Spectrum {
  peaks: number[];
  /** 全频带逐 bin 中位数再取中位数 —— 「本底」的估计，正对照要拿它当参照 */
  floor: number;
  /** 采到的帧数（每 60ms 一帧） */
  frames: number;
  /** 全程最大值。等于 -Infinity 就说明整条轨是**数字静音**，跟「某个频率没听见」是两回事 */
  max: number;
  /**
   * 整条谱里最响的几个局部极大值（Hz + dB）。
   *
   * 有它才能在「判据红了」的时候一眼看出**那条轨里到底有什么** ——
   * 只报几个预设频点的读数时，红的那一条只能看出「有/没有」，
   * 看不出对面那个音是「同一个音的谐波」还是「另一条链路漏过来的」。
   */
  top: { hz: number; db: number }[];
  /** AudioContext 的状态；suspended 时读数是自证 */
  state: AudioContextState;
  trackMuted: boolean;
  trackReadyState: MediaStreamTrackState;
}

async function measureSpectrum(
  track: MediaStreamTrack,
  freqs: number[],
  ms = MEASURE_MS,
): Promise<Spectrum> {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  // **必须接一个目的地**才当得上「这条轨有人消费」：远端音轨在没有任何 sink 时
  // 是拿不到解码数据的（读数会是全 -Infinity，看起来像「没有那个频率」，
  // 其实是整条轨根本没出数据）。这里接一个静音增益，不出声但把消费关系立起来。
  const silent = ctx.createGain();
  silent.gain.value = 0;
  analyser.connect(silent).connect(ctx.destination);

  const bins = new Float32Array(analyser.frequencyBinCount);
  const frames: Float32Array[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await sleep(60);
    analyser.getFloatFrequencyData(bins);
    frames.push(Float32Array.from(bins));
  }

  // 每个 bin 取逐帧中位数：一次瞬态（咔哒 / underrun）是宽带的，会把全频段同时抬起来，
  // 用峰值统计会让「哪条轨在响」失去意义（实测一次咔哒能把 744~797 Hz 顶成全场最高）。
  const medianByBin = (i: number): number => {
    const column = frames.map((f) => f[i] ?? -Infinity).sort((a, b) => a - b);
    return column[column.length >> 1] ?? -Infinity;
  };

  const binHz = ctx.sampleRate / analyser.fftSize;
  const peaks = freqs.map((freq) => {
    const center = Math.round(freq / binHz);
    const lo = Math.max(0, center - 2);
    const hi = Math.min(bins.length - 1, center + 2);
    let best = -Infinity;
    for (let i = lo; i <= hi; i += 1) best = Math.max(best, medianByBin(i));
    return best;
  });

  // 本底：整条中位数谱的中间值（-Infinity 会排到最前面，中位数不受影响）
  const whole = new Float32Array(bins.length);
  let max = -Infinity;
  for (let i = 0; i < bins.length; i += 1) {
    whole[i] = medianByBin(i);
    if (whole[i] > max) max = whole[i];
  }
  const sorted = Float32Array.from(whole).sort();
  const floor = sorted[sorted.length >> 1] ?? -Infinity;

  // 局部极大值（左右各比一格高），按响度取前 10 —— 红了的时候靠它认人
  const top: { hz: number; db: number }[] = [];
  for (let i = 2; i < whole.length - 2; i += 1) {
    const v = whole[i]!;
    if (v < -200) continue;
    if (v >= whole[i - 1]! && v >= whole[i + 1]! && v > whole[i - 2]! && v > whole[i + 2]!) {
      top.push({ hz: Math.round(i * binHz), db: v });
    }
  }
  top.sort((a, b) => b.db - a.db);

  const state = ctx.state;
  const trackMuted = track.muted;
  const trackReadyState = track.readyState;
  await ctx.close();
  return {
    peaks,
    floor,
    frames: frames.length,
    max,
    top: top.slice(0, 10),
    state,
    trackMuted,
    trackReadyState,
  };
}

/** 把一次测量的「装置本身的健康状况」打出来 —— 读数是 -inf 时先看这个 */
const describe = (s: Spectrum): string =>
  `帧数=${s.frames} ctx=${s.state} 轨=${s.trackReadyState}${s.trackMuted ? '(muted)' : ''} 最强bin=${fmt(s.max)}`;

const fmt = (v: number): string => (v <= -900 ? '-inf' : v.toFixed(1));

/** 把最响的几个局部极大值一行打出来：`1201Hz@-34 2825Hz@-86 …` */
const spectrumTop = (s: Spectrum): string =>
  s.top.length === 0 ? '（整条轨没有可辨的峰）' : s.top.map((p) => `${p.hz}Hz@${p.db.toFixed(1)}`).join(' ');

/* ------------------------------------------------------------------ *
 * 「这条远端音轨现在还有没有声音」—— 旁观者持续观测用的电平探针
 * ------------------------------------------------------------------ */

/**
 * 一条音轨的时刻电平（dBFS）。
 *
 * **为什么不判 `track.muted`**：`replaceTrack(null)` 之后**不重新协商**，
 * m-line 一直是 `sendrecv`，接收端的 `muted` 实测根本不翻 —— 它是跟着
 * m-line 的方向走的，不是跟着「这条线上还有没有数据」走的。
 * 所以「静默」只能量内容：这条轨上还有没有声音。
 *
 * 判据是**相对**的：记住见过的最高电平，掉了 20 dB 以上才算静默。
 * 绝对门限在这里不好用 —— 这条语音链路的绝对电平低得离谱（实测主音才 -82 dB
 * 上下），「数字静音」和「很小的声音」在绝对值上分不开。
 */
interface LevelProbe {
  /** 读一次当前电平，同时更新内部峰值 */
  read: () => number;
  /** 建探针以来见过的最高电平 */
  peak: () => number;
  close: () => void;
}

function attachLevelProbe(track: MediaStreamTrack): LevelProbe {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  src.connect(an);
  // 与 `measureSpectrum` 同一条教训：没有 sink 的远端轨拿不到解码数据
  const silent = ctx.createGain();
  silent.gain.value = 0;
  an.connect(silent).connect(ctx.destination);

  const buf = new Float32Array(an.fftSize);
  let peaked = -Infinity;
  return {
    read: () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      if (db > peaked) peaked = db;
      return db;
    },
    peak: () => peaked,
    close: () => void ctx.close(),
  };
}

/** 相对见过的最高电平掉这么多 dB，才算「这条轨静默了」 */
const SILENT_DROP_DB = 20;

/** 旁观者的两条探针（只有非 0 号会建） */
let voiceProbe: LevelProbe | null = null;
let appProbe: LevelProbe | null = null;

/**
 * 旁观者在 0 号动手**之前**做的事：挂上电平探针，并等两条轨真的出过数据。
 *
 * 「出过数据」这一步不能省 —— 基线没建起来的话，探针峰值还是 -inf，
 * 后面那条「掉 20 dB 算静默」的判断永远不会成立（既不会假绿也不会假红，
 * 只会一直沉默），看起来跟「0 号什么都没干」一模一样。
 */
async function prepareObservation(): Promise<void> {
  const sharer = sharerPeerId();
  if (!sharer) throw new Error('没找到 0 号的 peerId');
  const tracks = session.getState().remoteTracks[sharer];
  if (!tracks?.voice || !tracks.appAudio) {
    throw new Error(
      `0 号的两条音频轨还没到齐（voice=${tracks?.voice ? '有' : '无'} appAudio=${tracks?.appAudio ? '有' : '无'}）`,
    );
  }

  voiceProbe = attachLevelProbe(tracks.voice);
  appProbe = attachLevelProbe(tracks.appAudio);

  await waitFor(
    () => voiceProbe!.read() > -120 && appProbe!.read() > -120,
    20_000,
    '两条远端音轨都出过数据（电平基线）',
  );
  say(
    `旁观者基线：voice 峰值 ${fmt(voiceProbe.peak())} dB · appAudio 峰值 ${fmt(appProbe.peak())} dB`,
  );
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const session = new ShareSession();

/** 换源前后留一份旧音轨，用来断言它真的被释放了（不是还挂在 sender 上） */
let staleAppAudio: MediaStreamTrack | null = null;

/** 旁观者（非 0 号）持续观察 0 号的轨，记录「有没有见过某个瞬时状态」 */
const observed = {
  sawSharerVoiceMuted: false,
  sawSharerAppAudioMuted: false,
  videoAdvancedWhileAppAudioMuted: false,
};

/** 结构轮：交叉串线量完了（0 号这时才能动生命周期） */
const PHASE_CROSS_CHECKED = 'cross-checked';
/** 结构轮：双方都准备好看生命周期了 —— 0 号这时才开始动 */
const PHASE_LIFECYCLE_START = 'lifecycle-start';
/** isolation 轮：所有窗口都完成频谱测量 */
const PHASE_MEASURED = 'measured';
/** isolation 轮诊断：全体已停掉「远端应用声音」的播放 */
const PHASE_APP_PLAYBACK_OFF = 'app-playback-off';
/** isolation 轮诊断：全体已恢复播放 */
const PHASE_APP_PLAYBACK_ON = 'app-playback-on';

function sharerPeerId(): string | null {
  const room = session.getState().room;
  if (!room) return null;
  const peer = room.peers.find((p) => p.nickname === 'P0');
  return peer?.peerId ?? null;
}

/**
 * 0 号自己**送出去**的那条轨。
 *
 * 0 号没有「对端视角」（`room.peers` 里不含自己，`sharerPeerId()` 在它身上恒为 null），
 * 但交叉串线这件事在发送侧有等价的正面证据：**真正协商出来的 transceiver 上
 * `sender.track` 是谁**。这比 `mesh.getLocalTracks()` 更贴近判据 ——
 * 后者只说明「本机有这么一条轨」，不说明它挂在哪条 m-line 上。
 */
function ownSendingTrack(role: TrackRole): MediaStreamTrack | null {
  const mesh = session.mesh;
  if (!mesh) return null;
  for (const link of mesh.links.values()) {
    for (const t of link.pc.getTransceivers()) {
      if (roleForMid(t.mid) === role && t.sender.track) return t.sender.track;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 语音播放（把对端语音真的播到扬声器 —— 反馈环的那半截）
 * ------------------------------------------------------------------ */

interface Player {
  el: HTMLAudioElement;
  track: MediaStreamTrack;
}

const players = new Map<string, Player>();

/**
 * 把收到的远端**音频**挂到 `<audio>` 上播出去（voice 与 appAudio 各一条）。
 *
 * 与产品里 App.tsx 的做法一致（`<audio>` 元素，不并进 `<video>`），
 * 原因也一样：播放端要保留「这条是语音、那条是应用声音」的身份。
 *
 * ⚠️ 这一步在 isolation 轮**不是可选的装饰**：A 的 appAudio 之所以可能混进
 * B/C/D 的语音，正是因为 A 把它们的语音播了出来。少了这一步，那条断言
 * 就变成自证（本来就没有声音，当然「没采到」）。
 *
 * 顺带也是「让远端音轨真的有数据」的正规做法（同 `measureSpectrum` 里那句注释）。
 */
function pumpRemoteAudio(): void {
  const state = session.getState();
  for (const [peerId, tracks] of Object.entries(state.remoteTracks)) {
    for (const role of ['voice', 'appAudio'] as const) {
      const track = tracks[role];
      if (!track) continue;
      const key = `${peerId}:${role}`;
      const existing = players.get(key);
      if (existing && existing.track === track) continue;

      const el = existing?.el ?? document.createElement('audio');
      if (!existing) {
        el.autoplay = true;
        el.volume = 0.6;
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      el.srcObject = new MediaStream([track]);
      void el.play().catch(() => undefined);
      players.set(key, { el, track });
    }
  }
}

/** 正在往扬声器上播的远端**语音**路数（应用声音不计，它不是「语音」） */
function playingVoiceCount(): number {
  let n = 0;
  for (const [key, { el, track }] of players.entries()) {
    if (!key.endsWith(':voice')) continue;
    if (track.readyState === 'live' && !track.muted && !el.paused) n += 1;
  }
  return n;
}

/** 持续把远端音频往扬声器上送 */
function startAudioPlayback(): () => void {
  pumpRemoteAudio();
  const timer = setInterval(pumpRemoteAudio, 300);
  return () => clearInterval(timer);
}

/**
 * 诊断用：把本机「远端**应用声音**」的播放全体开 / 关（语音照旧）。
 *
 * 为什么这个开关是**判据的一部分**，而不是调试残留 —— 这个装置里有一个坑：
 *
 *   B/C/D 会把 A 的 appAudio 挂到 `<audio>` 上播出来（产品就是这么做的），
 *   于是机器上除了**目标应用**在发噪声源那个频率，**harness 进程自己**也在发。
 *   一旦回环没有真的按进程隔离，这两路是分不开的：
 *
 *     · 停掉播放后那个频率**还在**   ⇒ 它来自目标应用（回环确实按进程隔离了）
 *     · 停掉播放后那个频率**掉下去** ⇒ 它来自别的窗口的播放（根本没隔离）
 *
 * 与 `check-app-audio` 那套「开 / 关自己」的 A/B 是同一条方法论。
 */
function setAppAudioPlayback(enabled: boolean): number {
  let n = 0;
  for (const [key, { el }] of players.entries()) {
    if (!key.endsWith(':appAudio')) continue;
    el.muted = !enabled;
    n += 1;
  }
  return n;
}

async function main(): Promise<void> {
  say(`启动 index=${INDEX}/${TOTAL} mode=${MODE}，角色=${IS_SHARER ? '共享 + 开麦' : '只开麦'}`);

  bridge?.ready();
  await bridge?.waitGo();

  session.connect(SIGNALING_URL);
  await waitFor(
    () => session.getState().connection.state === 'connected',
    20_000,
    '连接信令服务器',
  );
  check('已连接信令服务器', true);

  if (IS_SHARER) {
    const data = await session.createRoom(NICKNAME);
    await sleep(300);
    bridge?.announceRoomCode(data.roomCode);
  } else {
    if (!bridge) throw new Error('缺少 harnessBridge');
    const code = await bridge.waitRoomCode();
    await session.joinRoom(code, NICKNAME);
  }
  check('已进入房间', session.getState().room !== null);

  /* ---- 语音这一路 ---- */

  if (MODE === 'structure') {
    await session.setMicEnabled(true);
    const micSettings = session.getState().micSettings;
    check('麦克风已开启', session.getState().micEnabled);
    check(
      '麦克风的三个约束真的落下去了（回声消除 / 降噪 / 自动增益）',
      micSettings?.echoCancellation === true &&
        micSettings.noiseSuppression === true &&
        micSettings.autoGainControl === true,
      `ec=${micSettings?.echoCancellation} ns=${micSettings?.noiseSuppression} agc=${micSettings?.autoGainControl}`,
    );
    if (USING_FAKE_MIC) {
      // 这一条是**测量装置的自证**：开关没生效时 getUserMedia 会安静地回落到本机
      // 真实麦克风 —— 三个约束照样 true、界面照样「已开启」，只有内容不是 1200 Hz。
      const label = session.mic.track?.label ?? '';
      check(
        '用的是假麦克风设备（不然频谱里那个 1200Hz 跟灌进去的不是一回事）',
        /fake/i.test(label),
        `设备名「${label}」`,
      );
    }
  } else {
    /**
     * isolation 轮刻意**不用真麦克风**：这一轮要四个人各带一个**互不相同**的频率，
     * 而假麦克风设备是**按进程**生效的 —— 四个窗口同属一个 Electron 进程，
     * 拿到的会是同一路信号，分不出谁是谁。
     *
     * 语音内容从哪来跟这一轮要验的东西无关：被测的是「A 播放出去的远端语音
     * 会不会被 A 的回环采回去」，那条路径从 A 的扬声器才开始。
     */
    installVoiceTone(MY_VOICE_HZ);
    say(`语音轨使用本机合成音 ${MY_VOICE_HZ} Hz（isolation 轮需按人区分）`);
  }

  /* ---- 共享 ---- */

  if (IS_SHARER) {
    if (MODE === 'structure') {
      // 音调调高一点是为了频谱量得准（默认 0.002 是刻意压低的，量不出干净峰值）
      await session.startShare({ testPattern: true, label: NICKNAME, toneHz: HZ_APP, toneGain: 0.06 });
      check('共享已开始（合成源）', session.getState().sharing);
    } else {
      const source = await findNoiseSource();
      check('找到了被共享的那个独立应用窗口', source !== null, source?.name ?? '（没找到）');
      if (!source) throw new Error(`源列表里没有标题含「${NOISE_TITLE}」的窗口`);
      await session.startShare({ sourceId: source.id, audioMode: APP_AUDIO_MODE });
      check(`共享已开始（真实采集，音频模式=${APP_AUDIO_MODE}）`, session.getState().sharing);
      check(
        '这次共享真的采到了应用声音',
        session.getState().hasAudio,
        session.getState().hasAudio ? '' : (session.capture.audioError ?? '没有音频轨'),
      );
    }
  }

  /* ---- 等所有链路建连 ---- */

  await waitFor(
    () => {
      const links = session.getState().links;
      const ids = Object.keys(links);
      return ids.length === TOTAL - 1 && ids.every((id) => links[id].state === 'connected');
    },
    PHASE_MS,
    `全部 ${TOTAL - 1} 条链路建连`,
  );
  check(`全部 ${TOTAL - 1} 条链路 connected`, true);

  // 远端音频要挂到播放器上才算「有人消费」——否则远端音轨拿不到解码数据，
  // 频谱读出来全是 -Infinity，看着像「没有那个频率」，其实是整条轨没出数据
  const stopAudio = startAudioPlayback();

  /* ---- 结构断言 ---- */

  if (MODE === 'structure') {
    await step('结构断言', assertStructure);
    await step('轨道绑定', assertBinding);
    await step('接收端角色', assertReceiverRoles);
    await step('交叉串线', runCrossWiringCheck);
    await step('生命周期', runLifecycleOrObserve);
  } else {
    await step('数字反馈环', runIsolationCheck);
  }

  /**
   * 这个数必须在拆播放器**之前**取。
   *
   * 先 `players.clear()` 再数的话永远是 0，而驱动脚本正是拿它判
   * 「反馈环成立的前提在不在」（`peer.playingVoices !== TOTAL - 1` 直接判红）——
   * 实测踩到过：三个窗口的断言全过，却报「只把 0/3 路远端语音播上了扬声器」。
   */
  const playingVoices = playingVoiceCount();

  stopAudio();
  for (const { el } of players.values()) el.remove();
  players.clear();

  /* ---- 收尾 ---- */

  await sleep(400);

  const failed = checks.filter((c) => !c.ok);
  bridge?.report({
    index: INDEX,
    mode: MODE,
    ok: failed.length === 0,
    failure: failed.length ? failed.map((c) => c.label).join(' / ') : undefined,
    checks,
    observed,
    // 语音合成音所用 AudioContext 的状态。它要是 suspended，上面那些「没听见语音」
    // 就得先怀疑是这边压根没出声，而不是链路
    voiceToneState: voiceToneCtx?.state ?? null,
    playingVoices,
  });
}

/**
 * 结构轮的后半段，顺序是**刻意**的：
 *
 *   先量交叉串线（此时 0 号正在共享、开着麦），再走生命周期（会关麦 / 关应用声音 / 停共享）。
 *
 * 反过来放会踩到一条很隐蔽的假红：`stopShare()` 之后 appAudio 那条轨已经被摘了，
 * 频谱读出来整条 -Infinity —— 四个频率**全都没有**，于是「appAudio 里没有语音」
 * 这条会**绿**，而它的正对照会红。看起来像「隔离成功、装置坏了」，
 * 其实是**量晚了**。
 *
 * 两道屏障都用「**就位**」语义（谁都不宣布「我做完了」）：
 * 宣布式屏障在这里会死锁 —— 观察者要等 0 号宣布做完，而它自己「做完」的条件
 * 恰恰是 0 号开始动之后才能观测到的状态。就位式没有这个环。
 */
async function runLifecycleOrObserve(): Promise<void> {
  await waitAll(PHASE_CROSS_CHECKED, MEASURE_MS * 3 + 20_000);
  /**
   * 旁观者**先建立基线再报到** —— 这一句的位置是判据的一部分。
   *
   * 0 号上来第一件事就是关麦，探针要是还没见过「响」，后面就再也分不出
   * 「一直很安静」和「刚刚变安静」。屏障是「就位」语义，所以只要基线在
   * 报到之前建好，所有人在 `lifecycle-start` 上对齐之后 0 号才动手。
   */
  if (!IS_SHARER) await prepareObservation();
  await waitAll(PHASE_LIFECYCLE_START, 30_000);
  if (IS_SHARER) await runLifecycle();
  else await observeLifecycle();
}

/** 「所有人就位」屏障：自己先报到，再等别人。带超时，别让某一端的失败拖死全场 */
async function waitAll(name: string, ms: number): Promise<void> {
  bridge?.phaseReady(name);
  await waitPhaseBounded(name, ms);
}

/**
 * 跑一段断言，**炸了也继续**。
 *
 * 不这么包的话，前面某一段抛异常会让后面整串跟着红：相位屏障等人等到超时、
 * 旁观者永远等不到那个状态 —— 最后报出来十几条，看起来像全盘皆输，
 * 其实根因只有第一条。而根因那条往往还是这种「取不到节点」的脚本问题，
 * 不是被测代码的问题。捕获后照样记一条失败项，流程往下走。
 */
async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    check(
      `${label}：这一段自己抛异常了（它之后的断言都不可信）`,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/* ------------------------------------------------------------------ *
 * isolation 轮的语音轨：本机合成音
 * ------------------------------------------------------------------ */

let voiceToneCtx: AudioContext | null = null;

function installVoiceTone(hz: number): void {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  osc.type = 'sine';
  osc.frequency.value = hz;
  gain.gain.value = 0.35;
  osc.connect(gain).connect(dest);
  osc.start();
  voiceToneCtx = ctx;

  const track = dest.stream.getAudioTracks()[0];
  if (!track) throw new Error('合成语音轨创建失败');
  const mesh = session.mesh;
  if (!mesh) throw new Error('Mesh 没建起来');
  mesh.setLocalTrack('voice', track);
}

/* ------------------------------------------------------------------ *
 * isolation 轮：找被共享的那个独立应用窗口
 * ------------------------------------------------------------------ */

async function findNoiseSource(): Promise<{ id: string; name: string } | null> {
  // Windows 的窗口枚举是快照式的：窗口刚创建完、焦点切换中的那几秒里偶发漏掉
  // （完整两轮验收跑出过一次：独立应用明明报了「窗口就绪」，P0 首次枚举的列表里
  // 就是没有它）。枚举不到就等一小会再试，连续多次都没有才认输。
  for (let attempt = 1; attempt <= 10; attempt++) {
    const sources = await session.capture.listSources();
    const hit = sources.find((s) => s.kind === 'window' && s.name.includes(NOISE_TITLE));
    if (hit) {
      // 把源 id 与解出来的 pid 打出来：`applicationLoopback:<pid>` 的 pid 就是它，
      // 主进程那行 `[capture] … → device=` 里的 pid 必须与这里一致。
      say(
        `选中的源 ${hit.id}（pid=${hit.pid ?? 'null'}）` +
          (attempt > 1 ? ` —— 第 ${attempt} 次枚举才出现（前 ${attempt - 1} 次漏掉了）` : ''),
      );
      return { id: hit.id, name: hit.name };
    }
    if (attempt === 1) {
      say(
        `源列表里没有「${NOISE_TITLE}」，现有窗口源：` +
          (sources
            .filter((s) => s.kind === 'window')
            .map((s) => s.name)
            .join(' | ') || '（一个都没有）'),
      );
    } else {
      say(`第 ${attempt} 次枚举仍然没有「${NOISE_TITLE}」，600ms 后重试…`);
    }
    await sleep(600);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 结构断言
 * ------------------------------------------------------------------ */

async function assertStructure(): Promise<void> {
  const mesh = session.mesh;
  if (!mesh) throw new Error('Mesh 没建起来');

  for (const [peerId, link] of mesh.links) {
    const local = extractMediaLines(link.pc.localDescription?.sdp);
    const remote = extractMediaLines(link.pc.remoteDescription?.sdp);

    check(
      `链路 ${peerId.slice(0, 8)}：协商出去的 m-line 恰好 ${TRACK_ROLES.length} 条`,
      local.length === TRACK_ROLES.length,
      `实际 ${local.map((m) => `${m.kind}/${m.mid}`).join(' ')}`,
    );

    check(
      `链路 ${peerId.slice(0, 8)}：m-line 类型顺序 == ${TRACK_ROLES.map((r) => ROLE_MEDIA_KIND[r]).join(' → ')}`,
      local.every((m, i) => m.kind === ROLE_MEDIA_KIND[TRACK_ROLES[i] as TrackRole]),
    );

    check(
      `链路 ${peerId.slice(0, 8)}：mid → 角色 在本端与对端 SDP 里完全一致`,
      local.map((m) => m.mid).join(',') === remote.map((m) => m.mid).join(','),
      `local=${local.map((m) => m.mid).join(',')} remote=${remote.map((m) => m.mid).join(',')}`,
    );

    // 我们自己那份 mid → 角色 的换算，必须和按 SDP 顺序推出的角色一致
    const byMid = link.pc
      .getTransceivers()
      .map((t) => `${t.mid}:${roleForMid(t.mid) ?? '?'}(${t.receiver.track?.kind ?? '?'})`)
      .join(' ');
    check(
      `链路 ${peerId.slice(0, 8)}：本端 transceiver 的 mid 都能算出角色，且与类型吻合`,
      link.pc.getTransceivers().every((t) => {
        const role = roleForMid(t.mid);
        return role !== null && t.receiver.track?.kind === ROLE_MEDIA_KIND[role];
      }),
      byMid,
    );
  }
}

async function assertBinding(): Promise<void> {
  const mesh = session.mesh;
  if (!mesh) throw new Error('Mesh 没建起来');

  const localTracks = mesh.getLocalTracks();
  check(
    IS_SHARER ? 'video 那条挂的正是采集的视频轨' : 'video 那条没有挂任何轨（本机没共享）',
    IS_SHARER ? (localTracks.video?.kind ?? null) === 'video' : localTracks.video === null,
    localTracks.video?.label ?? '（无）',
  );
  check(
    MODE === 'structure' ? 'voice 那条挂的正是麦克风轨' : 'voice 那条挂的是本机的语音轨',
    (localTracks.voice?.kind ?? null) === 'audio' &&
      (MODE === 'structure' ? localTracks.voice === session.mic.track : localTracks.voice !== null),
  );
  check(
    IS_SHARER ? 'appAudio 那条挂的正是采集的音频轨' : 'appAudio 那条没有挂任何轨（本机没共享）',
    IS_SHARER ? (localTracks.appAudio?.kind ?? null) === 'audio' : localTracks.appAudio === null,
    localTracks.appAudio?.label ?? '（无）',
  );
  check(
    'voice 与 appAudio 不是同一条轨道对象（混轨 = 接收端再也分不开）',
    localTracks.voice === null ||
      localTracks.appAudio === null ||
      localTracks.voice !== localTracks.appAudio,
  );
}

async function assertReceiverRoles(): Promise<void> {
  if (IS_SHARER) return;
  const sharer = sharerPeerId();
  if (!sharer) throw new Error('没找到 0 号的 peerId');

  const tracks = session.getState().remoteTracks[sharer];
  check('接收端拿到了 0 号的 video 轨', tracks?.video != null);
  check('接收端拿到了 0 号的 voice 轨', tracks?.voice != null);
  check('接收端拿到了 0 号的 appAudio 轨', tracks?.appAudio != null);

  // 按角色取出来的必须是三条不同的东西
  const ids = new Set(
    [tracks?.video?.id, tracks?.voice?.id, tracks?.appAudio?.id].filter(Boolean) as string[],
  );
  check('三条远端轨是三个不同的轨道对象', ids.size === 3, `实际 ${ids.size} 个`);

  // 其余非共享者：appAudio 那条线上没有媒体
  const others = session
    .getState()
    .room!.peers.filter((p) => p.peerId !== sharer)
    .map((p) => p.peerId);
  const othersNoAppAudio = others.every((id) => {
    const t = session.getState().remoteTracks[id]?.appAudio ?? null;
    return t === null || t.muted === true;
  });
  check(
    '只有共享者那一路的 appAudio 有媒体，其他人的 appAudio 是静默的',
    othersNoAppAudio,
    `检查了 ${others.length} 个非共享成员`,
  );
}

/* ------------------------------------------------------------------ *
 * 结构轮的生命周期
 * ------------------------------------------------------------------ */

/**
 * 0 号的生命周期：每一步都断言**自己的**状态，不依赖对端的观测时机。
 *
 * 顺序刻意按需求里那两条走：
 *   麦：开 → 关 → 再开
 *   应用声音：关（画面继续）→ 再开
 *   换源：旧应用音轨必须真的没了
 *   停止共享：只摘画面与应用声音，**麦克风必须还活着**
 */
async function runLifecycle(): Promise<void> {
  const mesh = session.mesh;
  if (!mesh) throw new Error('Mesh 不存在');

  const link = [...mesh.links.values()][0];
  if (!link) throw new Error('没有链路');

  /* 8.1 关麦 → 再开 */
  await session.setMicEnabled(false);
  check('关麦后本机不再挂 voice 轨', link.getDiagnostics().roles.voice.hasLocalTrack === false);
  check('关麦后麦克风设备真的被释放了（不是只静音）', session.mic.live === false);

  await sleep(1_200);

  await session.setMicEnabled(true);
  check('再次开麦后 voice 轨重新挂上', link.getDiagnostics().roles.voice.hasLocalTrack === true);
  check('再次开麦后设备是活的', session.mic.live === true);

  /* 8.2 关应用声音但继续共享画面 */
  const framesBefore = await readSharerEncodedFrames();
  session.setAppAudioEnabled(false);
  check(
    '关掉应用声音后本机不再挂 appAudio 轨',
    link.getDiagnostics().roles.appAudio.hasLocalTrack === false,
  );
  check('关掉应用声音后仍在共享（画面没被牵连）', session.getState().sharing === true);

  await sleep(2_000);
  const framesAfter = await readSharerEncodedFrames();
  check(
    '应用声音关着的这段时间里，画面仍在往外编码（两条轨确实解耦）',
    framesAfter > framesBefore,
    `${framesBefore} → ${framesAfter}`,
  );

  session.setAppAudioEnabled(true);
  check('再开应用声音后 appAudio 轨重新挂上', link.getDiagnostics().roles.appAudio.hasLocalTrack === true);

  /* 8.3 切换共享源：旧的应用音轨必须彻底释放 */
  staleAppAudio = mesh.getLocalTracks().appAudio;
  check('换源前记下旧的应用音轨', staleAppAudio !== null, staleAppAudio?.label ?? '（无）');

  await session.startShare({
    testPattern: true,
    label: `${NICKNAME}-SWITCHED`,
    toneHz: HZ_APP,
    toneGain: 0.06,
  });
  await sleep(800);

  const newAppAudio = mesh.getLocalTracks().appAudio;
  check(
    '换源后旧的应用音轨 readyState === ended（被真正 stop 掉了）',
    staleAppAudio?.readyState === 'ended',
    `实际 ${staleAppAudio?.readyState}`,
  );
  check(
    '换源后挂上的是**新的**应用音轨，不是旧的',
    newAppAudio !== null && newAppAudio !== staleAppAudio,
  );
  check(
    '换源后 appAudio 那条 m-line 上有轨且 mid 没变（没有重新协商）',
    link.getDiagnostics().roles.appAudio.mid === '2' &&
      link.getDiagnostics().roles.appAudio.hasLocalTrack === true,
    `mid=${link.getDiagnostics().roles.appAudio.mid}`,
  );
  check(
    '换源没有影响麦克风',
    link.getDiagnostics().roles.voice.hasLocalTrack === true && session.mic.live === true,
  );

  /* 8.4 停止共享：只摘画面与应用声音 */
  session.stopShare();
  check('停止共享后 video 轨已摘', link.getDiagnostics().roles.video.hasLocalTrack === false);
  check('停止共享后 appAudio 轨已摘', link.getDiagnostics().roles.appAudio.hasLocalTrack === false);
  check(
    '停止共享**没有**顺手关掉麦克风（停止共享 ≠ 挂电话）',
    link.getDiagnostics().roles.voice.hasLocalTrack === true && session.mic.live === true,
  );
  check(
    '停止共享后三条 m-line 依然都在（没有重建协商）',
    link.pc.getTransceivers().length === TRACK_ROLES.length,
    `实际 ${link.pc.getTransceivers().length} 条`,
  );
}

/** 0 号自己看自己的出站编码帧数 */
async function readSharerEncodedFrames(): Promise<number> {
  const mesh = session.mesh;
  const link = mesh ? [...mesh.links.values()][0] : null;
  if (!link) return 0;
  const stats = await link.readStats();
  return stats.outbound?.framesEncoded ?? 0;
}

/**
 * 旁观者的观测：0 号做生命周期的那段时间里，持续轮询自己这边的远端轨。
 *
 * 判「静默」用**电平**（见 `attachLevelProbe`），不判 `muted` ——
 * `replaceTrack(null)` 不重新协商，m-line 一直是 sendrecv，
 * 接收端的 `muted` 实测根本不翻。`muted` 仍然读着，只当旁证打进 detail 里：
 * 红了的时候要能一眼看出是「属性没翻」还是「电平没掉」。
 *
 * 基线由 `prepareObservation()` 在**屏障之前**建好，所以进到这里时
 * 两条探针都已经见过「响」的状态。
 *
 * 轮询间隔 150ms，而 0 号每一步之间都留了 ≥1.2 秒的窗口，看得到。
 */
async function observeLifecycle(): Promise<void> {
  const sharer = sharerPeerId();
  if (!sharer) throw new Error('没找到 0 号的 peerId');
  const link = session.mesh?.getLink(sharer) ?? null;
  if (!link) throw new Error('没有指向 0 号的链路');
  if (!voiceProbe || !appProbe) throw new Error('电平探针没建起来（prepareObservation 没跑？）');

  /** 每种信号分别有没有响 —— 红了的时候靠它区分「哪一层没看见」 */
  const hits = { voiceMuted: false, voiceLevel: false, appMuted: false, appLevel: false };
  let sawFinalMuted = false;
  let sawFinalStall = false;

  const deadline = Date.now() + PHASE_MS;
  let lastFrames = 0;
  let stall = 0;
  let sawFramesAdvance = false;

  while (Date.now() < deadline) {
    const tracks = session.getState().remoteTracks[sharer];
    const vPeak = voiceProbe.peak();
    const aPeak = appProbe.peak();
    const vDb = voiceProbe.read();
    const aDb = appProbe.read();
    // 峰值还是 -inf 时不算数：那代表基线没建起来，不是「静默」
    const voiceSilent = vPeak > -200 && vDb < vPeak - SILENT_DROP_DB;
    const appSilent = aPeak > -200 && aDb < aPeak - SILENT_DROP_DB;

    if (tracks?.voice?.muted === true) hits.voiceMuted = true;
    if (tracks?.appAudio?.muted === true) hits.appMuted = true;
    if (voiceSilent) hits.voiceLevel = true;
    if (appSilent) hits.appLevel = true;

    if (hits.voiceMuted || hits.voiceLevel) observed.sawSharerVoiceMuted = true;
    if (hits.appMuted || hits.appLevel) observed.sawSharerAppAudioMuted = true;

    const frames = (await link.readStats()).inbound?.framesDecoded ?? 0;
    if (frames > lastFrames) {
      sawFramesAdvance = true;
      if (observed.sawSharerAppAudioMuted) observed.videoAdvancedWhileAppAudioMuted = true;
      stall = 0;
    } else if (sawFramesAdvance) {
      stall += 1;
    }
    lastFrames = frames;

    // 停止共享：画面轨不动了（连续 4 次轮询 ≈0.6 秒没有新帧）。muted 只当旁证
    if (link.getDiagnostics().roles.video.remoteTrackMuted === true) sawFinalMuted = true;
    if (stall >= 4) {
      sawFinalStall = true;
      break;
    }
    await sleep(150);
  }

  check(
    '旁观者见到过 0 号的语音轨变为静默（关麦确实传到了对端）',
    observed.sawSharerVoiceMuted,
    `电平掉了=${hits.voiceLevel} muted 翻了=${hits.voiceMuted}（峰值 ${fmt(voiceProbe.peak())} dB）`,
  );
  check(
    '旁观者见到过 0 号的应用声音轨变为静默',
    observed.sawSharerAppAudioMuted,
    `电平掉了=${hits.appLevel} muted 翻了=${hits.appMuted}（峰值 ${fmt(appProbe.peak())} dB）`,
  );
  check(
    '应用声音静默期间画面仍在推进（两条轨互不牵连）',
    observed.videoAdvancedWhileAppAudioMuted,
    `静默期间解出 ${lastFrames} 帧`,
  );
  check(
    '观测窗口内见到了 0 号停止共享（对端画面轨变为静默）',
    sawFinalMuted || sawFinalStall,
    `帧数停走=${sawFinalStall} muted 翻了=${sawFinalMuted}`,
  );

  voiceProbe.close();
  appProbe.close();
  voiceProbe = null;
  appProbe = null;
}

/* ------------------------------------------------------------------ *
 * 结构轮：交叉串线（合成源 vs 假麦克风）
 * ------------------------------------------------------------------ */

/**
 * 0 号的 appAudio 里不能有语音那个频率，voice 里不能有应用声音那个频率。
 *
 * 这是「两条轨没有挂反」在**轨道内容层面**的证据 ——
 * 结构对了但挂反了的话，前面几组断言全是绿的，只有这一组会红。
 */
async function runCrossWiringCheck(): Promise<void> {
  /**
   * 判据是同一件事，观测点按角色分：
   *   0 号   —— 量**自己送出去**的那两条轨（`sender.track`）
   *   其余人 —— 量**收到的** 0 号那两条轨
   *
   * 0 号这里以前直接调 `sharerPeerId()`，而那在它自己身上恒为 null
   * （`room.peers` 不含自己）—— 于是它每次都抛「没找到 0 号的 peerId」，
   * 连带把后面的生命周期阶段整个跳过，四个窗口一起红成一片。
   */
  const who = IS_SHARER ? '本机送出去' : '0 号';

  let voice: MediaStreamTrack | null;
  let appAudio: MediaStreamTrack | null;
  if (IS_SHARER) {
    voice = ownSendingTrack('voice');
    appAudio = ownSendingTrack('appAudio');
  } else {
    const sharer = sharerPeerId();
    if (!sharer) throw new Error('没找到 0 号的 peerId');
    const tracks = session.getState().remoteTracks[sharer];
    voice = tracks?.voice ?? null;
    appAudio = tracks?.appAudio ?? null;
  }

  if (!voice || !appAudio) {
    check(
      '交叉串线：两条音频轨都在',
      false,
      `voice=${voice ? '有' : '无'} appAudio=${appAudio ? '有' : '无'}`,
    );
    return;
  }

  const freqs = [HZ_APP, HZ_MIC];
  const app = await measureSpectrum(appAudio, freqs);
  const mic = await measureSpectrum(voice, freqs);
  const [appOnApp, micOnApp] = app.peaks as [number, number];
  const [appOnMic, micOnMic] = mic.peaks as [number, number];

  say(
    `${who}：appAudio 上 ${HZ_APP}Hz=${fmt(appOnApp)} ${HZ_MIC}Hz=${fmt(micOnApp)} | ` +
      `voice 上 ${HZ_MIC}Hz=${fmt(micOnMic)} ${HZ_APP}Hz=${fmt(appOnMic)}`,
  );
  say(`  装置：appAudio(${describe(app)}) voice(${describe(mic)})`);
  say(`  appAudio 谱峰：${spectrumTop(app)}`);
  say(`  voice    谱峰：${spectrumTop(mic)}`);

  // 先立正对照：两个频率各自真的存在。否则下面那两条「没有」可能只是这套 FFT 聋了
  check(
    `正对照：${who}的 appAudio 里确实有应用声音（${HZ_APP}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
    appOnApp - app.floor >= MARGIN_OVER_FLOOR,
    `高 ${(appOnApp - app.floor).toFixed(1)} dB`,
  );
  check(
    `正对照：${who}的 voice 里确实有语音（${HZ_MIC}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
    micOnMic - mic.floor >= MARGIN_OVER_FLOOR,
    `高 ${(micOnMic - mic.floor).toFixed(1)} dB`,
  );

  check(
    `${who}的 appAudio 里**没有**语音（${HZ_MIC}Hz 比 ${HZ_APP}Hz 低够多）`,
    appOnApp - micOnApp >= MARGIN_SEPARATION,
    `低 ${(appOnApp - micOnApp).toFixed(1)} dB`,
  );
  check(
    `${who}的 voice 里**没有**应用声音（${HZ_APP}Hz 比 ${HZ_MIC}Hz 低够多）—— 两条轨没有互换`,
    micOnMic - appOnMic >= MARGIN_SEPARATION,
    `低 ${(micOnMic - appOnMic).toFixed(1)} dB`,
  );
}

/* ------------------------------------------------------------------ *
 * isolation 轮：真实回环下的数字反馈环
 * ------------------------------------------------------------------ */

/**
 * 诊断 A/B：全体先停掉「远端应用声音」的播放，再量一次 A 的 appAudio。
 *
 * 它回答一个只有它才能回答的问题：**A 的 appAudio 里那个噪声源频率，
 * 到底是目标应用出的，还是别的窗口把 A 的 appAudio 播出来又漏回来的。**
 *
 * 装置里为什么存在这个歧义：B/C/D 会把收到的 A 的 appAudio 挂到 `<audio>` 上
 * 播到扬声器（产品就是这么做的），于是机器上除了目标应用在发 2100，
 * **harness 进程自己也在发 2100**。两个来源同名同频，只有把播放这一路关掉才分得开：
 *
 *   · 关掉后 2100 还在   ⇒ 来自目标应用（回环确实按进程隔离了，正对照成立）
 *   · 关掉后 2100 没了   ⇒ 来自别的窗口的播放（回环根本没按进程隔离）
 *
 * 顺带也是那四路语音的同一问：它们的来源只可能是扬声器那条路径。
 */
async function runPlaybackAb(): Promise<void> {
  const n = setAppAudioPlayback(false);
  say(`诊断 A/B：先停掉本机 ${n} 路「远端应用声音」的播放（语音照旧）`);
  await waitAll(PHASE_APP_PLAYBACK_OFF, MEASURE_MS * 4 + 20_000);
  await sleep(1_500);

  const probeFreqs = [NOISE_HZ, ...VOICE_HZ];
  if (IS_SHARER) {
    const t = session.mesh?.getLocalTracks().appAudio ?? null;
    if (t) {
      const s = await measureSpectrum(t, probeFreqs);
      say(`诊断：停播之后 A 本地 appAudio 频谱：${s.peaks.map(fmt).join(' / ')}`);
      say(`  装置：${describe(s)}`);
      say(`  谱峰：${spectrumTop(s)}`);
    }
  } else {
    const sharer = sharerPeerId();
    const t = sharer ? (session.getState().remoteTracks[sharer]?.appAudio ?? null) : null;
    if (t) {
      const s = await measureSpectrum(t, probeFreqs);
      say(`诊断：停播之后 A→我 appAudio 频谱：${s.peaks.map(fmt).join(' / ')}`);
      say(`  装置：${describe(s)}`);
      say(`  谱峰：${spectrumTop(s)}`);
    }
  }

  await waitAll(PHASE_APP_PLAYBACK_ON, MEASURE_MS * 4 + 20_000);
  setAppAudioPlayback(true);
}

/**
 * 四人模型的正题。A 共享一个**独立进程**在出声的窗口，并用 `application` 模式采它的声音；
 * 同时 A 把 B/C/D 的语音播到自己的扬声器上。
 *
 * 断言（在接收端 B 上量，与产品里对端真实的处境一致）：
 *   1. A 的 appAudio 里有噪声源频率          —— 回环是活的（正对照）
 *   2. A 的 appAudio 里没有任何人的语音频率  —— 反馈环断了（正题）
 *   3. A 的 voice   里有 A 自己的语音频率    —— 语音链路是活的（反面对照）
 *   4. A 的 voice   里没有噪声源频率         —— 应用声音没有串进语音
 *
 * 另外在 A 本地也量一遍 appAudio：同一个轨道，两个观测点互为旁证。
 */
async function runIsolationCheck(): Promise<void> {
  // 远端语音此刻已经在播了（main 里统一起的播放泵），这里只等它真的进入播放状态
  await waitFor(
    () => playingVoiceCount() === TOTAL - 1,
    30_000,
    `${TOTAL - 1} 路远端语音都进入播放`,
  );
  check(
    `已把 ${TOTAL - 1} 路远端语音播到本机扬声器（反馈环成立的前提）`,
    true,
    `实际 ${playingVoiceCount()} 路`,
  );

  // 音频起播 + 编码器收敛需要一点时间，等一拍再量
  await sleep(2_500);

  const freqs = [NOISE_HZ, ...VOICE_HZ];
  const names = ['噪声源', ...VOICE_HZ.map((_, i) => `P${i} 语音`)];
  /** 每个窗口量到自己的结果才算就位；屏障的语义是「这一轮的量测全部就位」 */
  bridge?.phaseReady(PHASE_MEASURED);

  if (IS_SHARER) {
    // A 本地量一遍自己的 appAudio（与接收端那条是同一条轨道的两个观测点）
    const appTrack = session.mesh?.getLocalTracks().appAudio ?? null;
    if (!appTrack) {
      check('isolation：A 本地的 appAudio 轨存在', false);
      await waitPhaseBounded(PHASE_MEASURED, MEASURE_MS * 3 + 20_000);
      return;
    }
    const app = await measureSpectrum(appTrack, freqs);
    say(`A 本地 appAudio 频谱：${app.peaks.map(fmt).join(' / ')}`);
    say(`  装置：appAudio(${describe(app)})`);
    // 谱峰 + 采集轨的 settings：红了的时候靠这两行认人 ——
    // 只报五个预设频点的读数，看不出「那条轨里到底还有什么」，
    // 也看不出「Chromium 到底给了哪一路 device」（deviceId 是加盐哈希，
    // 但它是不是 `loopback` 那一支的哈希，跟 check-app-audio 的读数一比就知道）
    say(`  谱峰：${spectrumTop(app)}`);
    say(`  采集轨 settings：${JSON.stringify(appTrack.getSettings())}`);
    /**
     * 回环那条轨**必须**是「裸」的。
     *
     * 这一条是这条验收里唯一能直接抓到那类事故的断言：`getDisplayMedia({audio: true})`
     * 的默认值是 `echoCancellation / noiseSuppression / autoGainControl` **三项全开**
     * （Chromium 把它们当「麦克风」处理），而后果不是音质差一点 ——
     * AEC 会按「本机此刻在播什么」去减采集到的声音，于是目标应用自己的频点被减掉几十 dB，
     * 远端语音以残余回声的形式漏回来。**反馈环有没有断，被一个抵消器盖住了。**
     * 实测踩到过：隔离度只剩 5~11 dB，而停掉本机播放后同一路立刻回到干净电平。
     */
    const cap = appTrack.getSettings() as {
      echoCancellation?: boolean;
      noiseSuppression?: boolean;
      autoGainControl?: boolean;
    };
    check(
      '回环没有被套上麦克风那三件套（echoCancellation / noiseSuppression / autoGainControl 全为 false）',
      cap.echoCancellation === false &&
        cap.noiseSuppression === false &&
        cap.autoGainControl === false,
      `ec=${cap.echoCancellation} ns=${cap.noiseSuppression} agc=${cap.autoGainControl}`,
    );
    const noiseOnApp = app.peaks[0]!;
    const voicesOnApp = app.peaks.slice(1);
    check(
      `正对照：A 本地的 appAudio 里**有**被共享应用的声音（${NOISE_HZ}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
      noiseOnApp - app.floor >= MARGIN_OVER_FLOOR,
      `高 ${(noiseOnApp - app.floor).toFixed(1)} dB`,
    );

    /**
     * 本地口径的**反面对照**。
     *
     * 「语音链路是活的」这件事，接收端那边量的是「收到的 voice 轨里有 A 的语音」，
     * 而 A 这边量的是「本机送出去的 voice 轨里有我自己的语音」。两条分工不同：
     * 这条红了说明「A 这边压根没出声」，那条红了说明「声音没送到对端」——
     * 排查方向完全不一样，所以两条都要有。
     */
    const voiceTrack = session.mesh?.getLocalTracks().voice ?? null;
    if (voiceTrack) {
      const vs = await measureSpectrum(voiceTrack, [VOICE_HZ[0]!]);
      const ownOnVoice = vs.peaks[0]!;
      check(
        `反面对照：A 本地的 voice 轨里**有** A 自己的语音（${VOICE_HZ[0]}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
        ownOnVoice - vs.floor >= MARGIN_OVER_FLOOR,
        `高 ${(ownOnVoice - vs.floor).toFixed(1)} dB`,
      );
    } else {
      check('反面对照：A 本地的 voice 轨存在', false, '（没有 voice 轨，取不到读数）');
    }

    const leaked = voicesOnApp.filter((p) => noiseOnApp - p < MARGIN_SEPARATION);
    /**
     * 本地口径的**正题**。
     *
     * 量的是**同一条出站轨**，只是取在编码之前 —— 它与接收端那条（A→B 的 appAudio）
     * 是同一件事在两个观测点上的读数。驱动脚本两条都会要：只留接收端那条，
     * 「A 自己这一侧到底采到了什么」就没人验了。
     */
    check(
      '本地量自己的 App Audio：四路语音频率都没有出现（本地口径的「数字反馈环真的断了」）',
      leaked.length === 0,
      `四路语音分别低 ${voicesOnApp.map((p) => (noiseOnApp - p).toFixed(1)).join(' / ')} dB`,
    );
    await runPlaybackAb();
    await waitPhaseBounded(PHASE_MEASURED, MEASURE_MS * 3 + 20_000);
    return;
  }

  /* ---- 接收端（B/C/D）：这才是任务书里那句话的正面回答 ---- */

  const sharer = sharerPeerId();
  if (!sharer) throw new Error('没找到 0 号的 peerId');
  const tracks = session.getState().remoteTracks[sharer];
  if (!tracks?.voice || !tracks?.appAudio) {
    check(
      'isolation：0 号的 voice 与 appAudio 都收到了',
      false,
      `voice=${tracks?.voice ? '有' : '无'} appAudio=${tracks?.appAudio ? '有' : '无'}`,
    );
    await waitPhaseBounded(PHASE_MEASURED, MEASURE_MS * 3 + 20_000);
    return;
  }

  const app = await measureSpectrum(tracks.appAudio, freqs);
  const voice = await measureSpectrum(tracks.voice, freqs);
  say(`A→我 appAudio 频谱（${names.join(' / ')}）：${app.peaks.map(fmt).join(' / ')}`);
  say(`A→我 voice 频谱（${names.join(' / ')}）：${voice.peaks.map(fmt).join(' / ')}`);
  say(`  装置：appAudio(${describe(app)}) voice(${describe(voice)})`);
  say(`  appAudio 谱峰：${spectrumTop(app)}`);
  say(`  voice   谱峰：${spectrumTop(voice)}`);

  const noiseOnApp = app.peaks[0]!;
  const voicesOnApp = app.peaks.slice(1);
  const aVoiceOnVoice = voice.peaks[1]!;
  const noiseOnVoice = voice.peaks[0]!;

  check(
    `正对照：A 的 appAudio 里**有**被共享应用的声音（${NOISE_HZ}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
    noiseOnApp - app.floor >= MARGIN_OVER_FLOOR,
    `高 ${(noiseOnApp - app.floor).toFixed(1)} dB`,
  );
  check(
    `反面对照：A 的 voice 里**有** A 自己的语音（${VOICE_HZ[0]}Hz 高于本底 ${MARGIN_OVER_FLOOR}dB）`,
    aVoiceOnVoice - voice.floor >= MARGIN_OVER_FLOOR,
    `高 ${(aVoiceOnVoice - voice.floor).toFixed(1)} dB`,
  );

  // 正题：逐条列出「哪一路语音漏进了 appAudio」
  const leaked = voicesOnApp
    .map((peak, i) => ({ i, gap: noiseOnApp - peak, peak }))
    .filter((x) => x.gap < MARGIN_SEPARATION);
  check(
    '**A 的 App Audio 里没有 Voice B/C/D（也没有 A 自己的语音）** —— 数字反馈环真的断了',
    leaked.length === 0,
    leaked.length === 0
      ? `四路语音分别比噪声源低 ${voicesOnApp
          .map((p) => (noiseOnApp - p).toFixed(1))
          .join(' / ')} dB`
      : `漏进来了：${leaked
          .map((x) => `${VOICE_HZ[x.i]}Hz（只低 ${x.gap.toFixed(1)} dB，读数 ${fmt(x.peak)}）`)
          .join('；')}`,
  );

  check(
    `A 的 voice 里没有应用声音（${NOISE_HZ}Hz 比语音低够多）`,
    aVoiceOnVoice - noiseOnVoice >= MARGIN_SEPARATION,
    `低 ${(aVoiceOnVoice - noiseOnVoice).toFixed(1)} dB`,
  );

  await runPlaybackAb();
  await waitPhaseBounded(PHASE_MEASURED, MEASURE_MS * 3 + 20_000);
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  say(`失败：${message}`);
  bridge?.report({
    index: INDEX,
    mode: MODE,
    ok: false,
    failure: err instanceof Error ? err.message : String(err),
    checks,
    observed,
  });
});
