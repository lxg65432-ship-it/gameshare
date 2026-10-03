import {
  DEFAULT_QUALITY,
  ROLE_MEDIA_KIND,
  TRACK_ROLES,
  QualityLevel,
  computeMaxBitrate,
  computeMaxFramerate,
  computeScaleResolutionDownBy,
  getProfile,
  roleForMid,
  type TrackRole,
} from '@game-share/protocol';
import type { IceServerConfig } from '@game-share/shared';

import { PeerStats } from './stats';
import {
  emptyLocalTracks,
  emptyRemoteTracks,
  type LinkState,
  type LinkStats,
  type LocalTracks,
  type PeerSignaling,
  type RemoteTracks,
} from './types';

/**
 * 一条 P2P 链路 = 一个远端玩家 = 一个 RTCPeerConnection。
 *
 * --- 关于「发送通道怎么建」的教训 ---
 *
 * 最初想在构造函数里预建一条 sendrecv transceiver，之后开关共享只走
 * sender.replaceTrack()，以此完全避开重协商。实测在 Chrome 上不行：
 * 远端 offer 到达时浏览器不保证复用预建的 transceiver，可能自己另建一条
 * 并绑到 m-line 上。于是我们手里的那条 mid 恒为 null，改它的方向对协商
 * 毫无影响，answer 永远是 recvonly —— 表现为「连接正常、我能看到对方、
 * 对方看不到我」，是极难发现的一类隐性故障。
 *
 * 现在的规则（三条，缺一条就会出问题）：
 *   1. m-line 只由主动方（peerId 较大的一方）创建，被动方一律只接受。
 *      两边都建会出多条 m-line，直接报 m-line 顺序不匹配。
 *   2. 每次 SDP 落地后都以「真正绑定了 m-line 的那条 transceiver」为准
 *      （#pickBoundTransceiver），而不是我们手里那条对象引用。
 *   3. 方向永远写 sendrecv，不随「是否正在共享」来回切。
 *      开关任何一条轨都只用 replaceTrack(null) 表达，因此协商只发生一次。
 *
 * --- 关于三条轨 ---
 *
 * 固定三条 m-line，顺序由 `TRACK_ROLES` 定死（video → voice → appAudio）：
 *
 *   video     共享的窗口 / 屏幕
 *   voice     麦克风（AEC / NS / AGC）
 *   appAudio  被共享应用 / 整机的声音
 *
 * voice 与 appAudio **刻意不混**：混了接收端就没法分别控制，opus 也没法对
 * 语音单独优化，而且两者的采集约束本来就相反（麦克风要 AEC/NS，回环绝不能开）。
 *
 * 这三条轨各自开关互不影响：`replaceTrack(null)` 只摘自己那一条，
 * 不重新协商、不碰别人，也不影响视频。
 *
 * --- 关于「角色」怎么认（别用数组下标） ---
 *
 * 接收端认角色**只用 mid**（见 `roleForMid`）：mid 是 m-line 在 SDP 里的序号，
 * 由主动方在 offer 里定下、被动方继承同一份，两端算出来必然一致，且协商一次
 * 之后就不再变（本项目从不重建 transceiver）。
 *
 * ⚠️ 反面做法是 `stream.getAudioTracks()[0]` 那种**数组下标** —— 轨道增删、
 * replaceTrack、重排都会让下标漂移，拿它认「第一条音频就是语音」迟早出错。
 *
 * --- 关于画质 ---
 * maxBitrate / maxFramerate / scaleResolutionDownBy 都落在本条链路的 sender 上，
 * 所以 A 被 B 放大到 1080p 时，C 看到的仍是 540p，互不影响。
 */

export interface EncodingParams {
  maxBitrate: number | null;
  maxFramerate: number | null;
  scaleResolutionDownBy: number;
}

/** 单条轨的体检快照。三条轨各自的处境分开列，混在一起看不出「是哪条没谈成」。 */
export interface RoleDiagnostics {
  mid: string | null;
  direction: RTCRtpTransceiverDirection | null;
  currentDirection: RTCRtpTransceiverDirection | null;
  /** 我们这边有没有往这条轨上挂东西 */
  hasLocalTrack: boolean;
  localTrackState: MediaStreamTrackState | null;
  localTrackMuted: boolean | null;
  /** 对端有没有往这条轨上挂东西（本地看得见的是 receiver 的那条轨道） */
  remoteTrackState: MediaStreamTrackState | null;
  /** 远端轨道是否 muted。对端 replaceTrack(null) 之后这里会变 true —— 这是判断「对端关了这条」的正规依据 */
  remoteTrackMuted: boolean | null;
  remoteTrackEnabled: boolean | null;
}

export interface LinkDiagnostics {
  signalingState: RTCSignalingState;
  iceConnectionState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  transceiverMid: string | null;
  transceiverDirection: RTCRtpTransceiverDirection | null;
  currentDirection: RTCRtpTransceiverDirection | null;
  transceiverCount: number;
  /** SDP 里 m=video 段声明的方向，用来判断是「报文意图」不对还是「协商结果」不对 */
  localSdpDirection: string | null;
  remoteSdpDirection: string | null;
  localVideoSdp: string[] | null;
  remoteVideoSdp: string[] | null;
  directionRepairAttempts: number;
  /** ICE 自愈：已重开次数 / 上限。排障时用来判断「还有没有得试」 */
  iceRestartAttempts: number;
  iceRestartMaxAttempts: number;
  /** 已调用 restartIce 但协商尚未落地。true 时不能再调，否则搅乱协商 */
  iceRestartPending: boolean;
  /** 退避定时器已排、正在等。排障时能看出「正卡在退避里等」而不是「压根没试」 */
  iceRestartScheduled: boolean;
  /** 等 answer 的兜底定时器已排。true = 这一轮重开的 offer 还没等到回应 */
  iceRestartAnswerPending: boolean;
  hasSenderTrack: boolean;
  senderTrackState: MediaStreamTrackState | null;
  senderTrackMuted: boolean | null;
  sentMedia: boolean;
  /** 音频 m-line 的绑定与方向。单独列出来，混在视频里看不出「是哪条没谈成」 */
  audioTransceiverMid: string | null;
  audioCurrentDirection: RTCRtpTransceiverDirection | null;
  hasSenderAudioTrack: boolean;
  localAudioTrackReadyState: MediaStreamTrackState | null;
  /** 三条轨按角色的完整快照 —— 上面那些标量是历史字段，判断「哪条没成」看这个 */
  roles: Record<TrackRole, RoleDiagnostics>;
  /** 实际落下去的档位，null 表示还没成功写入过编码参数 */
  appliedQuality: QualityLevel | null;
  encoding: EncodingParams | null;
}

export interface PeerLinkOptions {
  selfPeerId: string;
  remotePeerId: string;
  signaling: PeerSignaling;
  iceServers: IceServerConfig[];
  /**
   * 采集源的实际编码高度。
   *
   * 必须每次现取：scaleResolutionDownBy 的基准是源高度而非显示器高度，
   * 写死 1080 会让 1440p/768p 屏幕上的档位全部错位。
   */
  getSourceHeight?: () => number | null;
  /** 同上，码率自适应换算需要源像素量（宽 × 高） */
  getSourceWidth?: () => number | null;
  onStateChange?: (state: LinkState, detail?: string) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  /** 远端三条轨按角色上报。接收侧要分别控制语音 / 应用声音时读这个 */
  onRemoteTracks?: (tracks: RemoteTracks) => void;
  onError?: (err: Error) => void;
  log?: (line: string) => void;
}

/** 方向修复的最大尝试次数，防止浏览器行为异常时来回协商打转 */
const MAX_DIRECTION_REPAIRS = 3;

/** 建连后分几次检查方向，避开「刚 connected 时方向还没落定」的窗口 */
const DIRECTION_CHECK_DELAYS_MS = [0, 1_200, 3_000];

/**
 * ICE 自愈：断链后重开 ICE 的退避表（单位 ms，索引 = 已重试次数）。
 *
 * **为什么值得做**：断链有两种病因，处置完全相反 ——
 *   · 本来能通、只是断了（NAT 映射端口被运营商回收、换网络、WiFi 抖动）
 *     ⇒ 重开 ICE 就能救回来，媒体轨与编码参数全部保留，用户零感知
 *   · 本来就通不了（两端都在对称 NAT / CGNAT）
 *     ⇒ 无论重试几次都不会成功
 * 重开 ICE 只能救第一类，但代价极小（不动协议、不动架构），
 * 而第二类会被退避表挡在几次之内 —— 到顶就打住并明说「只能 TURN」，
 * 不会变成一条每分钟重开一次的僵尸链路。
 *
 * 退避本身是必须的：NAT 映射端口的回收周期通常是分钟级，
 * 立刻重试只会再拿一个同样打不通的映射；间隔拉长才有碰上「窗口重开」的机会。
 */
const ICE_RESTART_BACKOFF_MS = [0, 10_000, 25_000, 60_000];

/** 超过这个次数就认定「不是抖动，是真不通」，停止重试并给出最终判读 */
const ICE_RESTART_MAX_ATTEMPTS = ICE_RESTART_BACKOFF_MS.length;

/**
 * `disconnected` 的宽限期。
 *
 * `disconnected` 是中间态而非终点（Chromium 自己也会在若干秒后转 failed），
 * 短暂抖动常常在宽限期内自己恢复。**别一断就重开**：restartIce 会重跑一遍
 * 完整候选收集，抢在自愈前面反而拖慢恢复。
 */
const DISCONNECTED_GRACE_MS = 4_000;

/**
 * connected 后要稳定这么久，才把重试配额还回去。
 *
 * 直接在 connected 时清零会让「重启成功 → 立刻又断」无限循环；
 * 而完全不清零又会让一次下午的正常抖动把配额耗光，最后真断时已经没得试。
 */
const ICE_RESTART_RESET_MS = 10_000;

/**
 * offer 发出后等 answer 的兜底超时。
 *
 * 没有它会死锁：`pending` 靠 answer 落地或 connected 来解除，
 * 而「offer 发出去了、对端却已经走了」时这两条都不会发生 ——
 * pending 永久为 true，之后所有退避重试都被 `#scheduleIceRestart` 挡掉，
 * 链路变成一条再也不肯自愈的僵尸（成员列表过滤会把它从 UI 上删掉，
 * 于是这条僵尸还会静默活到房间解散）。
 */
const ICE_RESTART_ANSWER_TIMEOUT_MS = 15_000;

export class PeerLink {
  readonly remotePeerId: string;
  readonly pc: RTCPeerConnection;
  readonly stats = new PeerStats();

  #transceivers = new Map<TrackRole, RTCRtpTransceiver>();
  #signaling: PeerSignaling;
  #polite: boolean;
  #initiator: boolean;
  #getSourceHeight: () => number | null;
  #getSourceWidth: () => number | null;
  #onStateChange: (state: LinkState, detail?: string) => void;
  #onRemoteStream: (stream: MediaStream) => void;
  #onRemoteTracks: (tracks: RemoteTracks) => void;
  #onError: (err: Error) => void;
  #log: (line: string) => void;

  #makingOffer = false;
  #ignoreOffer = false;
  #settingRemoteAnswer = false;
  #remoteDescriptionSet = false;
  #pendingCandidates: RTCIceCandidateInit[] = [];

  #localTracks: LocalTracks = emptyLocalTracks();
  #remoteTracks: RemoteTracks = emptyRemoteTracks();
  #remoteStream: MediaStream | null = null;
  #desiredQuality: QualityLevel = DEFAULT_QUALITY;
  /** 用户选择的共享帧率（30/60/120）；null = 未选择，按档位默认走 */
  #userFps: number | null = null;
  #appliedQuality: QualityLevel | null = null;
  #qualityLogDone = false;
  #directionRepairAttempts = 0;
  /**
   * ICE 自愈的状态。
   *
   * 三者分开记，因为它们回答的是三个不同的问题：
   *   · `#iceRestartAttempts` —— 已经重开过几次（决定还能不能试、该等多久）
   *   · `#iceRestartPending`  —— 已调用 restartIce()、协商还没落地
   *     （这段时间里**不能**再调，否则会把正在进行的协商搅乱）
   *   · `#iceRestartTimer`     —— 退避等待中的定时器（close 时必须清掉，
   *     否则链路销毁后仍会醒来打日志）
   */
  #iceRestartAttempts = 0;
  #iceRestartPending = false;
  #iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  /** connected 稳定期的定时器。与上面的退避定时器分开：两者可能同时存在 */
  #iceRestartResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** 等 answer 的兜底定时器。与上面两个都分开，三者可能同时存在 */
  #iceRestartAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  /** 保证「挂轨道 → 生成 offer」不会抢跑，否则会协商出单向 m-line */
  #pendingTrackApply: Promise<void> = Promise.resolve();
  #closed = false;
  #state: LinkState = 'new';
  /** 已上报过的 ICE 错误，key = `url|code`。避免 mesh 场景下同一错误刷屏 */
  #reportedIceErrors = new Set<string>();
  /**
   * 本次 ICE 收集到的候选类型计数（host / srflx / prflx / relay）。
   *
   * 存在的唯一理由是**归因**：链路 failed 时，「有没有 srflx」是唯一能把两种
   * 完全不同的病因分开的判据 ——
   *   · 只有 host   ⇒ 一个 STUN 都没成，问题在 DNS 或出网被拦
   *   · 有 srflx 仍 failed ⇒ 候选拿到了但洞打不通，只能靠 TURN 兜底（M8）
   * 2026-09-22 之前没有任何地方记录这件事，于是「连不上」只能靠猜：
   * 日志里只有一条 code=701，而 701 本身并不能说明 STUN 不可用。
   */
  #candidateTypes = new Map<string, number>();

  constructor(opts: PeerLinkOptions) {
    this.remotePeerId = opts.remotePeerId;
    this.#signaling = opts.signaling;
    this.#getSourceHeight = opts.getSourceHeight ?? (() => null);
    this.#getSourceWidth = opts.getSourceWidth ?? (() => null);
    this.#onStateChange = opts.onStateChange ?? (() => undefined);
    this.#onRemoteStream = opts.onRemoteStream ?? (() => undefined);
    this.#onRemoteTracks = opts.onRemoteTracks ?? (() => undefined);
    this.#onError = opts.onError ?? (() => undefined);
    this.#log = opts.log ?? (() => undefined);

    // peerId 是随机串，用它比大小等价于抛硬币，但两端结果一致 —— 这正是在这里要的。
    // 只用于决定「首次协商谁来发起」，之后双方都可发起。
    this.#initiator = opts.selfPeerId > opts.remotePeerId;
    this.#polite = !this.#initiator;

    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });

    // m-line 只由主动方创建，被动方一律只接受。
    //
    // 两边都建是踩过的坑：会出现多条 video m-line，随后报
    // "The order of m-lines in answer doesn't match order in offer"，
    // 而且方向判断会在多条之间反复横跳，链路永远收敛不到双向。
    //
    // **顺序就是 TRACK_ROLES 的顺序，这是硬约束**：m-line 在 SDP 里的顺序
    // 就是我们 addTransceiver 的顺序，两端不一致时 answer 会对不上，
    // 而且接收端靠 mid 认角色的前提也正是这个顺序。
    // 改动这里的顺序 = 改协议，要同步改 harness 的断言。
    if (this.#initiator) {
      for (const role of TRACK_ROLES) {
        const transceiver = this.pc.addTransceiver(ROLE_MEDIA_KIND[role], { direction: 'sendrecv' });
        this.#transceivers.set(role, transceiver);
      }
    }

    this.#bind();
    this.#log(`链路创建 → ${opts.remotePeerId}（${this.#initiator ? '主动方' : '被动方'}）`);
  }

  get state(): LinkState {
    return this.#state;
  }

  get desiredQuality(): QualityLevel {
    return this.#desiredQuality;
  }

  /** 三条本地轨的当前挂载情况 */
  get localTracks(): LocalTracks {
    return { ...this.#localTracks };
  }

  /** 远端三条轨按角色。接收侧分别控制语音 / 应用声音时读这个，不要去看 MediaStream 的下标。 */
  get remoteTracks(): RemoteTracks {
    return { ...this.#remoteTracks };
  }

  /* ---------------- 事件绑定 ---------------- */

  #bind(): void {
    this.pc.onnegotiationneeded = () => {
      if (this.#closed) return;
      // m-line 由主动方独占创建，所以也只有主动方发起协商。
      // 被动方需要发送时不需要重新协商 —— m-line 本来就是双向的。
      if (!this.#initiator) return;
      // 已在协商中途就不再插一脚，否则会多发一份多余的 offer/answer
      if (this.pc.signalingState !== 'stable') return;
      void this.#negotiate();
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.#closed) return;
      this.#countCandidateType(candidate.candidate);
      this.#signaling.sendIceCandidate(this.remotePeerId, candidate.toJSON());
    };

    // 收集开始/完成的汇总挂在 #bind 末尾（与 ICE 自愈的状态机放在一起）

    this.pc.ontrack = (event) => {
      // 用 replaceTrack 发送时远端 track 不挂在任何 stream 上，
      // event.streams 为空，必须自己养一个 MediaStream。
      if (!this.#remoteStream) this.#remoteStream = new MediaStream();
      if (!this.#remoteStream.getTracks().includes(event.track)) {
        this.#remoteStream.addTrack(event.track);
      }

      /**
       * 认角色：**只看 mid**，不看轨道在数组里的位置。
       *
       * 认不出来就不认领、也不猜 —— 猜错方向的后果是把对方的语音当成
       * 应用声音发回去，那正是这一整套架构要根除的数字反馈环。
       */
      const role = roleForMid(event.transceiver.mid);
      if (role === null) {
        this.#log(
          `远端轨道无法识别角色，已丢弃（mid=${event.transceiver.mid ?? 'null'}，` +
            `kind=${event.track.kind}）← ${this.remotePeerId}`,
        );
        this.#onRemoteStream(this.#remoteStream);
        return;
      }
      if (ROLE_MEDIA_KIND[role] !== event.track.kind) {
        this.#log(
          `远端轨道角色与协商不符，已丢弃：mid=${event.transceiver.mid} 判为 ${role}` +
            `（应为 ${ROLE_MEDIA_KIND[role]}），实际是 ${event.track.kind} ← ${this.remotePeerId}`,
        );
        this.#onRemoteStream(this.#remoteStream);
        return;
      }

      this.#remoteTracks[role] = event.track;
      this.#log(`收到远端 ${role} 轨道 ← ${this.remotePeerId}（mid=${event.transceiver.mid}）`);
      this.#onRemoteStream(this.#remoteStream);
      // 发一份浅拷贝：订阅方（React）靠引用变化判断状态更新
      this.#onRemoteTracks({ ...this.#remoteTracks });
    };

    this.pc.onconnectionstatechange = () => {
      const prev = this.#state;
      this.#emitState();
      const now = this.pc.connectionState;
      if (now === 'connected') {
        void this.#applyQuality();
        this.#scheduleDirectionCheck();
        // 从断链回来才算数：connected 只说明此刻通了，
        // 还得再稳一段时间才把重试配额还回去，否则「通了又断」会打转。
        if (prev === 'disconnected' || prev === 'failed') {
          this.#scheduleIceRestartReset();
        }
        return;
      }
      if (now === 'disconnected') {
        // 中间态：先给自愈留宽限期，别抢在 Chromium 自己恢复前面动手
        this.#scheduleIceRestart('链路断开', DISCONNECTED_GRACE_MS);
        return;
      }
      if (now === 'failed') {
        // 终态判定，但「本来能通只是断了」仍可救 —— 已拿到公网映射时
        // 尤其值得试：NAT 映射端口被回收是分钟级的，换一批候选就能通。
        this.#scheduleIceRestart('ICE failed', 0);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.#emitState();
    };

    /**
     * 重开后候选会重新收集 —— 每轮都从零计数，否则判读会混进上一轮数据。
     *
     * 挂在 `gathering` 而不是 `complete`：真正要拦的是「重开后又开始收集」，
     * 而 gathering 是收集的起点，`complete` 那一刻数据已经是两轮混合的了。
     */
    this.pc.onicegatheringstatechange = () => {
      if (this.pc.iceGatheringState === 'gathering') this.#resetCandidateTypes();
      if (this.pc.iceGatheringState !== 'complete') return;
      this.#log(`候选收集完成 ${this.remotePeerId}：${this.#describeCandidateTypes()}`);
    };

    this.pc.onicecandidateerror = (event) => {
      // 不上抛，只记日志：STUN 节点报错很常见，而且 code=701 的原文是
      // "STUN host lookup received error" —— 属于 DNS 解析失败，
      // 不代表 STUN 不可达。同一节点完全可能一边报 701 一边成功给出 srflx 候选。
      //
      // 同一 (url, code) 每条链路只记一次：Chromium 对同一个 URL 会重复上报，
      // mesh 下再乘以链路数，不收敛的话真正的错误会被淹掉。
      const e = event as RTCPeerConnectionIceErrorEvent;
      const key = `${e.url}|${e.errorCode}`;
      if (this.#reportedIceErrors.has(key)) return;
      this.#reportedIceErrors.add(key);
      this.#log(`ICE 候选错误 ${this.remotePeerId} url=${e.url} code=${e.errorCode}`);
    };
  }

  /* ---------------- 候选归因 ---------------- */

  /** 从 SDP candidate 串里取 `typ` 记账（host / srflx / prflx / relay）。取不到就不记，不猜 */
  #countCandidateType(sdp: string): void {
    const matched = / typ (\w+)/.exec(sdp);
    if (!matched) return;
    const type = matched[1];
    this.#candidateTypes.set(type, (this.#candidateTypes.get(type) ?? 0) + 1);
  }

  #describeCandidateTypes(): string {
    if (this.#candidateTypes.size === 0) return '没有任何候选';
    return [...this.#candidateTypes]
      .map(([type, count]) => `${type}×${count}`)
      .join(' ');
  }

  /**
   * 把 ARCHITECTURE §6.1 的归因表落进日志本身。
   *
   * 为什么值得占一行：这两种病因的处置**完全相反**，而日志里原先只有候选计数，
   * 得靠人去翻文档对照 —— 2026-09-22 那晚连着两轮都在这上面绕。
   *
   * 判据只看「有没有 srflx / relay」，**绝不看有没有报 701** ——
   * 701 只是 DNS 解析失败，有它照样可能拿到 srflx（同一批节点实测：
   * 一边报 701、一边给出 srflx，两者可以同时成立）。
   */
  #diagnoseFailure(): string {
    const reachedPublic = this.#candidateTypes.has('srflx') || this.#candidateTypes.has('relay');
    return reachedPublic
      ? '已拿到公网映射却仍打不通 ⇒ 打洞失败（对称 NAT / CGNAT / 出网 UDP 被拦）；'
        + 'STUN 侧已无优化空间，只能靠 TURN 中继（M8）'
      : '一个 STUN 都没成 ⇒ 问题在 DNS 或出网 UDP；先按 `npm run check:stun` 的实测结果换节点';
  }

  /* ---------------- ICE 自愈 ---------------- */

  /**
   * 链路掉到 disconnected / failed 时安排一次重开。
   *
   * **只在断链时调用**，正常链路永远不碰。
   *
   * 关键取舍：`restartIce()` 会重跑一遍完整候选收集，但它**保留已有媒体轨与
   * 编码参数** —— 也就是说「本来能通、只是断了」的场景能零感知救回来，
   * 不必重建链路、不必让用户重进房间。这是 M8（TURN）之前唯一能实打实
   * 改善断链的动作，而 TURN 解决的是「两端都在对称 NAT」这种本来无解的情况。
   *
   * 代价是「本来就通不了」的场景会白等 —— 所以有退避表与次数上限，
   * 到顶就停手并把最终判读说清楚，绝不无限重试。
   *
   * @param graceMs 状态本身的宽限（`disconnected` 给 4s 等它自愈，`failed` 给 0）。
   *                与退避档位**相加**而不是二选一：两者要的东西不同 ——
   *                宽限针对「这次断链可能是暂时的」，退避针对「已经试过几次了」。
   */
  #scheduleIceRestart(reason: string, graceMs: number): void {
    if (this.#closed) return;
    // 被动方不参与重开（见 #restartIce）。**必须在这里就返回**而不是排个定时器：
    // 否则每次断链都会白跑一次退避，等到真该重试时配额已经被这些空转跑满了。
    if (!this.#initiator) return;
    // 已有重开在途：重复调会把正在落地的协商搅乱，直接跳过
    if (this.#iceRestartPending) return;
    // 退避表已走完 ⇒ 认定不是抖动，重试再多次也是白试
    if (this.#iceRestartAttempts >= ICE_RESTART_MAX_ATTEMPTS) {
      this.#log(
        `ICE 重开已达上限 ${ICE_RESTART_MAX_ATTEMPTS} 次仍不通，判定为真不通，` +
          `不再重试 → ${this.remotePeerId}（${this.#diagnoseFailure()}）`,
      );
      return;
    }

    // 退避按「已重试次数」取档：第 1 次用索引 0（即 0ms，立即救），之后逐级拉长。
    // 这条 setTimeout 的 delay **就是**退避表本身 ——
    // 别在旁边另算一份只打日志的 backoff，那样等于退避没生效（这个坑踩过：
    // 反向验证时把退避表全改成 0，断言居然还是全绿）。
    const backoff = ICE_RESTART_BACKOFF_MS[this.#iceRestartAttempts] ?? 0;
    const delay = graceMs + backoff;
    // 重排前先清掉上一个 —— `#iceRestartTimer` 是单值字段，不清的话
    // 新定时器会把它盖掉，而**旧定时器并不会消失**（只是再也拿不到了）：
    // 于是「断链 → 排退避 → 退避期间又断链」会把退避无限往后推，
    // 表现为 `iceRestartScheduled` 永远为 true、一次都执行不到。
    // （反向验证抓到的：连打 3 轮后 attempts 仍是 1，第二个定时器被第三个盖掉了。）
    if (this.#iceRestartTimer !== null) {
      clearTimeout(this.#iceRestartTimer);
    }
    this.#iceRestartTimer = setTimeout(() => {
      this.#iceRestartTimer = null;
      void this.#restartIce(reason, backoff);
    }, delay);
  }

  /**
   * 执行一次 ICE 重开。
   *
   * `restartIce()` 本身只是**打标记**：它让下一次 `createOffer()` 带上新的
   * ICE 凭据，并触发 `negotiationneeded`。真正把新凭据送到对端靠的是那次协商 ——
   * 而协商只由主动方发起（见构造函数与 onnegotiationneeded）。
   *
   * ⇒ **重开只能由主动方执行**。被动方这里什么都不做：
   * 调 restartIce() 只会留下一个永远等不到 createOffer 的脏标记
   * （被动方的 onnegotiationneeded 直接 return），下次真协商时凭据已经不对了。
   * 这不构成问题，因为 ICE 的 consent 检查是双向的：被动方察觉断链时，
   * 主动方同样会因收不到响应而走到 disconnected/failed，由它发起重开即可。
   */
  async #restartIce(reason: string, backoffMs: number): Promise<void> {
    if (this.#closed) return;
    // 主动方守卫在 #scheduleIceRestart 里就做了（那里早退，避免空转耗配额），
    // 这里再挡一道是因为这个方法也可能被别处调到。
    if (!this.#initiator) return;

    // 上一次重开还在等协商落地 ⇒ 这次跳过，避免连着 restartIce
    if (this.#iceRestartPending) return;
    /**
     * 上限**在这里也要查一遍**，不能只靠 `#scheduleIceRestart`。
     *
     * 那是同一道检查，但两次调用之间隔着一次 setTimeout：
     * 排定时器时 attempts=3（未到顶）→ 等待期间又断链 → attempts 仍可能是 3，
     * 但两个定时器都会醒、都看到「未到顶」⇒ 实际重试次数会超过上限。
     * （这个 bug 由反向验证抓到：连打 8 轮后 attempts 到了 5 而上限是 4。）
     */
    if (this.#iceRestartAttempts >= ICE_RESTART_MAX_ATTEMPTS) {
      this.#log(
        `ICE 重开已达上限 ${ICE_RESTART_MAX_ATTEMPTS} 次仍不通，判定为真不通，` +
          `不再重试 → ${this.remotePeerId}（${this.#diagnoseFailure()}）`,
      );
      return;
    }
    // 协商中途（signalingState 非 stable）重开会拿到不一致的 SDP
    if (this.pc.signalingState !== 'stable') {
      this.#log(
        `ICE 重开延后（正在协商，signalingState=${this.pc.signalingState}）→ ${this.remotePeerId}`,
      );
      return;
    }

    const attempt = this.#iceRestartAttempts + 1;
    this.#iceRestartAttempts = attempt;
    this.#iceRestartPending = true;

    try {
      this.pc.restartIce();
      this.#log(
        `ICE 重开 ${attempt}/${ICE_RESTART_MAX_ATTEMPTS}（${reason}，退避 ${backoffMs}ms）→ ` +
          `${this.remotePeerId}：${this.#describeCandidateTypes()}`,
      );
      // 兜底：answer 迟迟不来就把 pending 放掉，否则这条链路再也不肯自愈。
      // 正常路径由 handleAnswer 提前解除，这里只是防「offer 石沉大海」。
      this.#iceRestartAnswerTimer = setTimeout(() => {
        this.#iceRestartAnswerTimer = null;
        if (this.#closed || !this.#iceRestartPending) return;
        this.#iceRestartPending = false;
        this.#log(
          `ICE 重开后 ${ICE_RESTART_ANSWER_TIMEOUT_MS}ms 未收到 answer，放开 pending 等待下一轮 → ` +
            `${this.remotePeerId}`,
        );
      }, ICE_RESTART_ANSWER_TIMEOUT_MS);
      // restartIce 只发标记，真正的重开走这一次协商
      await this.#negotiate();
    } catch (err) {
      this.#fail(err);
    }
  }

  /**
   * 候选收集重新开始时清空计数。
   *
   * **必须清**：重开后拿到的是一批全新候选，混进上一轮的话
   * 「候选构成」那行会同时含两轮数据，failed 时的判读就不可信了 ——
   * 而那正是 1.3.2 唯一可靠的归因依据。
   */
  #resetCandidateTypes(): void {
    if (this.#candidateTypes.size > 0) {
      this.#log(`候选计数清零（重开前）${this.remotePeerId}`);
    }
    this.#candidateTypes.clear();
  }

  /** 重开的退避计时器与协商状态归零 */
  #markIceRecovered(): void {
    if (this.#iceRestartAttempts > 0) {
      this.#log(
        `ICE 重开成功（累计尝试 ${this.#iceRestartAttempts} 次）→ ${this.remotePeerId}：` +
          this.#describeCandidateTypes(),
      );
    }
    this.#iceRestartAttempts = 0;
    this.#iceRestartPending = false;
  }

  /**
   * connected 稳定够久之后才归还重试配额。
   *
   * 不在 connected 当下清零的原因：重开成功后紧接着又断（映射端口又被回收）
   * 会形成无限循环 —— 每次都以为「这是第一次断」，配额永远用不完。
   */
  #scheduleIceRestartReset(): void {
    if (this.#iceRestartResetTimer !== null) return;
    this.#iceRestartResetTimer = setTimeout(() => {
      this.#iceRestartResetTimer = null;
      // 期间又断了就作废：这次的配额不该给下一次断链用
      if (this.#closed || this.pc.connectionState !== 'connected') return;
      this.#markIceRecovered();
    }, ICE_RESTART_RESET_MS);
  }

  #emitState(): void {
    const raw = this.pc.connectionState;
    const next: LinkState =
      raw === 'new'
        ? 'new'
        : raw === 'connecting'
          ? 'connecting'
          : raw === 'connected'
            ? 'connected'
            : raw === 'disconnected'
              ? 'disconnected'
              : raw === 'failed'
                ? 'failed'
                : 'closed';

    if (next === this.#state) return;
    this.#state = next;

    const ice = this.pc.iceConnectionState;
    this.#onStateChange(next, `ice=${ice}`);
    this.#log(`链路状态 ${this.remotePeerId} → ${next}（ice=${ice}）`);

    // failed 时补两行：候选构成 + 判读。上面那行的格式一个字都不动 —— 现有断言盯着它。
    // 判据表见 ARCHITECTURE §6.1；「有 srflx 却仍 failed」这一支 2026-09-23 已实测确认。
    //
    // 注意这两行现在**可能重复出现**：ICE 重开后再次 failed 是正常的诊断序列
    // （每轮都重新归因，因为候选是重新收集的），不是重复打印的 bug。
    if (next === 'failed') {
      this.#log(`候选构成 ${this.remotePeerId}：${this.#describeCandidateTypes()}`);
      const attempt =
        this.#iceRestartAttempts > 0
          ? `（第 ${this.#iceRestartAttempts}/${ICE_RESTART_MAX_ATTEMPTS} 次重开后再失败）`
          : '（尚未重试）';
      this.#log(`· 判读 ${this.remotePeerId}：${this.#diagnoseFailure()}${attempt}`);
    }
  }

  /* ---------------- 发送通道 ---------------- */

  /**
   * 取得指定角色用于发送的 transceiver。
   *
   * 优先用已经绑定 m-line 的那条；没有绑定关系时，只有主动方有权新建，
   * 被动方必须等对方的 m-line 到来（否则就会多出 m-line）。
   */
  #acquireTransceiver(role: TrackRole): RTCRtpTransceiver | null {
    const current = this.#transceivers.get(role) ?? null;
    if (current && !isStopped(current)) return current;

    const bound = this.#pickBoundTransceiver(role);
    if (bound) {
      this.#log(`复用已绑定 m-line 的 ${role} transceiver mid=${bound.mid} → ${this.remotePeerId}`);
      return bound;
    }

    if (!this.#initiator) return null;

    // 动态新建只应出现在「构造函数里没建过」的异常路径。正常流程三条 m-line
    // 在构造函数里就按 TRACK_ROLES 的顺序建好了，顺序不能反。
    // 真走到这里说明前面丢了 transceiver，多出来的 m-line 会让 mid → 角色的
    // 映射整体后移 —— 所以必须留下显眼的日志，不能静默。
    this.#log(
      `⚠️ 角色 ${role} 没有可用的 transceiver，动态新建一条 → ${this.remotePeerId}：` +
        `m-line 数会超出 ${TRACK_ROLES.length}，mid → 角色的映射可能已经失准`,
    );
    const created = this.pc.addTransceiver(ROLE_MEDIA_KIND[role], { direction: 'sendrecv' });
    this.#transceivers.set(role, created);
    return created;
  }

  /**
   * 以「真正绑定了 m-line」的那条 transceiver 为准。
   *
   * 实测：远端 offer 到达时浏览器不一定复用我们预建的 transceiver，
   * 可能自己另建一条并绑到 m-line 上。这时我们手里的那条 mid 是 null，
   * 改它的方向对协商毫无影响 —— 于是 answer 恒为 recvonly，链路变单向。
   * 所以每次 SDP 落地后都要按绑定关系重新认一次。
   *
   * **按 mid 认角色，不按 kind 认**：voice 与 appAudio 的 kind 都是 audio，
   * 只用 kind 根本区分不开，这正是三轨改造必须动这里的原因。
   */
  #pickBoundTransceiver(role: TrackRole): RTCRtpTransceiver | null {
    const kind = ROLE_MEDIA_KIND[role];
    const bound = this.pc
      .getTransceivers()
      .find(
        (t) => !isStopped(t) && t.mid !== null && roleForMid(t.mid) === role && t.receiver.track?.kind === kind,
      );

    const current = this.#transceivers.get(role) ?? null;
    if (bound && bound !== current) {
      this.#log(
        `改用已绑定 m-line 的 ${role} transceiver mid=${bound.mid}（原 mid=${current?.mid ?? 'null'}）→ ${this.remotePeerId}`,
      );
      this.#transceivers.set(role, bound);
    }
    if (bound) return bound;
    return current && !isStopped(current) ? current : null;
  }

  /**
   * 把方向对齐到「双向」。
   *
   * 刻意始终写 sendrecv：方向一旦从 recvonly 变成 sendrecv 就会触发重协商，
   * 而「开始/停止共享」「开/关麦」「开/关应用声音」都只靠 replaceTrack(null)
   * 表达即可，不必再谈一轮。
   */
  #syncDirection(role: TrackRole): void {
    const transceiver = this.#transceivers.get(role);
    if (!transceiver || isStopped(transceiver)) return;
    if (transceiver.direction === 'sendrecv') return;
    try {
      transceiver.direction = 'sendrecv';
      this.#log(`方向意图 ${this.remotePeerId} ${role} ← sendrecv`);
    } catch (err) {
      this.#fail(err);
    }
  }

  /* ---------------- 本地媒体 ---------------- */

  /**
   * 挂载 / 摘除指定角色的本地轨。
   *
   * 传 null 表示这条轨关掉（停止共享 / 关麦 / 关应用声音）：
   * 只摘自己这一条，其余两条不受影响，链路本身保持存活，不会掉线。
   *
   * 三条轨共用一条串行队列：并发 replaceTrack 会让「哪条先挂上」变得不确定，
   * 而诊断与验收都要看得到确定的中间态。
   */
  async setLocalTrack(role: TrackRole, track: MediaStreamTrack | null): Promise<void> {
    await this.#applyLocalTrack(role, track);
  }

  async #applyLocalTrack(role: TrackRole, track: MediaStreamTrack | null): Promise<void> {
    this.#localTracks[role] = track;
    if (role === 'video' && track) {
      // 游戏画面运动量大，'motion' 让编码器优先保证帧率与运动清晰度。
      // 2D / 文字为主的画面切换到 'detail' 更清楚，留给设置项（M10 评估）。
      try {
        track.contentHint = 'motion';
      } catch {
        // 个别浏览器不支持 contentHint，忽略
      }
    }

    this.#pendingTrackApply = (async () => {
      try {
        const transceiver = this.#acquireTransceiver(role);
        if (!transceiver) {
          // 被动方在对方的 m-line 到来之前没有发送通道，等 handleOffer 里补挂
          this.#log(`${role} 发送通道尚未建立，本地轨道挂载延后 → ${this.remotePeerId}`);
        } else if (transceiver.sender.track !== track) {
          await transceiver.sender.replaceTrack(track);
          this.#log(
            `${track ? '挂载' : '摘除'} ${role} 本地轨道 → ${this.remotePeerId}（mid=${transceiver.mid ?? '未绑定'}）`,
          );
        }
      } catch (err) {
        this.#fail(err);
      }

      this.#syncDirection(role);
      if (role === 'video') await this.#applyQuality();
    })();

    await this.#pendingTrackApply;
  }

  /* ---------------- 协商（perfect negotiation） ---------------- */

  async #negotiate(): Promise<void> {
    if (this.#closed) return;
    try {
      // 必须等挂轨结果落定再生成 offer / answer，
      // 否则会协商出与真实意图不符的方向（见文件头注释）。
      await this.#pendingTrackApply;
      if (this.#closed) return;

      this.#syncDirection('video');
      this.#makingOffer = true;
      await this.pc.setLocalDescription();
      // 自己刚生成的 offer 会把 transceiver 绑到新的 m-line 上，刷新一次
      for (const role of TRACK_ROLES) this.#pickBoundTransceiver(role);
      const sdp = this.pc.localDescription?.sdp;
      if (sdp) {
        this.#log(
          `发出 offer → ${this.remotePeerId} 方向=${extractVideoDirection(sdp) ?? '?'}` +
            `${this.#describeTransceivers()}`,
        );
        this.#signaling.sendOffer(this.remotePeerId, sdp);
      }
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#makingOffer = false;
    }
  }

  async handleOffer(sdp: string): Promise<void> {
    if (this.#closed) return;

    // 自己正在发 offer，同时收到对方的 offer —— 冲突
    const readyForOffer =
      !this.#makingOffer && (this.pc.signalingState === 'stable' || this.#settingRemoteAnswer);
    const offerCollision = !readyForOffer;

    this.#ignoreOffer = !this.#polite && offerCollision;
    if (this.#ignoreOffer) {
      this.#log(`忽略来自 ${this.remotePeerId} 的 offer（本方为主动方，冲突时不让步）`);
      return;
    }

    try {
      this.#log(`收到 offer ← ${this.remotePeerId} 方向=${extractVideoDirection(sdp) ?? '?'}`);
      this.#settingRemoteAnswer = true;
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      this.#remoteDescriptionSet = true;
      this.#settingRemoteAnswer = false;

      await this.#flushCandidates();

      // 以实际绑定了 m-line 的那条为准（浏览器可能没用我们预建的那条），
      // 并把本地轨道补挂到它上面 —— 否则这条链路只能收不能发。
      // **三条轨各认各的**：只认 video 会让音频链路永远单向，
      // 只按 kind 认会让 voice 与 appAudio 互相抢同一条 m-line。
      for (const role of TRACK_ROLES) {
        const bound = this.#pickBoundTransceiver(role);
        const local = this.#localTracks[role];
        if (bound && local && bound.sender.track !== local) {
          try {
            await bound.sender.replaceTrack(local);
          } catch (err) {
            this.#fail(err);
          }
        }
        this.#syncDirection(role);
      }

      await this.pc.setLocalDescription();
      const answer = this.pc.localDescription?.sdp;
      if (answer) {
        this.#log(
          `发出 answer → ${this.remotePeerId} 方向=${extractVideoDirection(answer) ?? '?'}` +
            `${this.#describeTransceivers()}`,
        );
        this.#signaling.sendAnswer(this.remotePeerId, answer);
      }

      await this.#applyQuality();
    } catch (err) {
      this.#settingRemoteAnswer = false;
      this.#fail(err);
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (this.#closed) return;
    if (this.#settingRemoteAnswer) this.#settingRemoteAnswer = false;
    if (this.pc.signalingState !== 'have-local-offer') {
      this.#log(`忽略迟到的 answer（signalingState=${this.pc.signalingState}）`);
      return;
    }

    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.#remoteDescriptionSet = true;
      await this.#flushCandidates();
      await this.#applyQuality();
      /**
       * answer 落地 = 这一轮重开已经发完了，`pending` 的语义（等协商收尾）
       * 到此为止。**必须在这里解除**，不能只靠 connected 后 10 秒那条路径：
       * 重开后链路**仍然 failed** 是常事（NAT 类型不兼容时必然如此），
       * 那时永远等不到 connected，`pending` 会永久卡住，之后的退避重试全部失效。
       */
      if (this.#iceRestartAnswerTimer !== null) {
        clearTimeout(this.#iceRestartAnswerTimer);
        this.#iceRestartAnswerTimer = null;
      }
      this.#iceRestartPending = false;
    } catch (err) {
      this.#iceRestartPending = false;
      this.#fail(err);
    }
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.#closed || !candidate.candidate) return;

    // 描述还没落地时 addIceCandidate 会抛 InvalidStateError。
    // 信令虽然有序，但 offer 的 setRemoteDescription 是异步的，
    // 候选完全可能赶在它完成之前到达，所以必须缓冲。
    if (!this.#remoteDescriptionSet) {
      this.#pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.#ignoreOffer) this.#fail(err);
    }
  }

  async #flushCandidates(): Promise<void> {
    const pending = this.#pendingCandidates;
    this.#pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        this.#fail(err);
      }
    }
  }

  /**
   * 协商结果与本意不符时拉回来。
   *
   * 保险丝：方向正常时什么都不做；一旦出现「该发不发」「该收不收」，
   * 就重新协商一轮。次数有上限，避免来回打转。
   */
  #repairDirectionIfOneWay(): void {
    if (this.#closed) return;
    // 只有主动方能重新发起协商，被动方交给主动方修
    if (!this.#initiator) return;
    if (this.#directionRepairAttempts >= MAX_DIRECTION_REPAIRS) return;

    // video 是主体，方向不对直接掉观感；音频方向不对只是没声音。
    // 三条都查，但只计一次修复次数 —— 否则一轮就会把配额耗光。
    const broken = TRACK_ROLES.filter((role) => {
      const t = this.#transceivers.get(role);
      if (!t || isStopped(t)) return false;
      const current = t.currentDirection;
      return current !== null && current !== 'sendrecv';
    });
    if (broken.length === 0) return;

    this.#directionRepairAttempts += 1;
    this.#log(
      `方向不符（${broken.join('/')}），第 ${this.#directionRepairAttempts} 次重新协商 → ${this.remotePeerId}`,
    );
    for (const role of broken) this.#syncDirection(role);
    void this.#negotiate();
  }

  #scheduleDirectionCheck(): void {
    for (const delay of DIRECTION_CHECK_DELAYS_MS) {
      setTimeout(() => {
        if (!this.#closed) this.#repairDirectionIfOneWay();
      }, delay);
    }
  }

  /* ---------------- 画质 ---------------- */

  /** 只影响「本发送方 → 该观看者」这一条链路 */
  async setQuality(level: QualityLevel): Promise<void> {
    this.#desiredQuality = level;
    await this.#applyQuality();
  }

  /**
   * 用户改了共享帧率（30/60/120）。所有链路共用一个采集源，
   * 所以帧率是全局偏好，每条链路的编码上限同步更新。
   */
  async setUserFps(fps: number): Promise<void> {
    if (this.#userFps === fps) return;
    this.#userFps = fps;
    await this.#applyQuality();
  }

  async #applyQuality(): Promise<void> {
    if (this.#closed) return;

    const sender = this.#transceivers.get('video')?.sender;
    if (!sender) {
      if (!this.#qualityLogDone) {
        this.#qualityLogDone = true;
        this.#log(`画质参数待发送通道建立后应用 → ${this.remotePeerId}`);
      }
      return;
    }

    const profile = getProfile(this.#desiredQuality);
    const sourceWidth = this.#getSourceWidth() ?? sender.track?.getSettings().width ?? null;
    const sourceHeight = this.#getSourceHeight() ?? sender.track?.getSettings().height ?? null;
    const scaleDown = computeScaleResolutionDownBy(sourceHeight, profile.targetHeight);
    const userFps = this.#userFps ?? profile.maxFramerate;
    const maxFramerate = computeMaxFramerate(profile, userFps);
    const maxBitrate = computeMaxBitrate(profile, sourceWidth, sourceHeight, userFps);

    try {
      const params = sender.getParameters();
      // 协商完成前 encodings 为空，这时不能填，否则 setParameters 会抛
      if (!params.encodings || params.encodings.length === 0) {
        throw new Error('encodings 尚未协商完成');
      }
      params.encodings[0].maxBitrate = maxBitrate;
      params.encodings[0].maxFramerate = maxFramerate;
      params.encodings[0].scaleResolutionDownBy = scaleDown;
      await sender.setParameters(params);

      this.#appliedQuality = this.#desiredQuality;
      this.#log(
        `画质 ${this.remotePeerId} → ${profile.label}（scaleDown=${scaleDown.toFixed(3)}，` +
          `base=${sourceHeight ?? 'unknown'}p，fps≤${maxFramerate}，cap=${Math.round(maxBitrate / 1000)}k）`,
      );
    } catch (err) {
      // 首次协商完成前必然落到这里，属预期路径，不打错误日志污染诊断
      if (!this.#qualityLogDone) {
        this.#qualityLogDone = true;
        this.#log(`画质参数延迟到协商完成后应用（${(err as Error).message}）`);
      }
    }
  }

  /* ---------------- 统计与销毁 ---------------- */

  /**
   * 读回实际生效的编码参数。
   *
   * getStats() 只给编码结果的尺寸，不给「我们要求了什么」。
   * M5 验证画质档位是否真的落下去、M7 调试面板都要靠这个。
   */
  readEncodingParams(): EncodingParams | null {
    const sender = this.#transceivers.get('video')?.sender;
    if (!sender) return null;
    try {
      const params = sender.getParameters();
      const encoding = params.encodings?.[0];
      if (!encoding) return null;
      return {
        maxBitrate: encoding.maxBitrate ?? null,
        maxFramerate: encoding.maxFramerate ?? null,
        scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? 1,
      };
    } catch {
      return null;
    }
  }

  readStats(): Promise<LinkStats> {
    return this.stats.read(this.pc);
  }

  /**
   * 排障快照。
   *
   * 「连上了但没画面 / 没声音」的原因至少有四种：协商方向不对、轨道没挂上、
   * 编码器不出帧、解码端没在工作。单看连接状态分不出来，必须把方向 / 轨道 /
   * 编码参数一起打出来，而且要**分角色**打 —— 三条轨各自的处境完全不同。
   */
  getDiagnostics(): LinkDiagnostics {
    const sender = this.#transceivers.get('video')?.sender ?? null;
    const track = sender?.track ?? null;

    const roles = {} as Record<TrackRole, RoleDiagnostics>;
    for (const role of TRACK_ROLES) {
      const transceiver = this.#transceivers.get(role) ?? null;
      const local = this.#localTracks[role];
      const remote = this.#remoteTracks[role];
      roles[role] = {
        mid: transceiver?.mid ?? null,
        direction: transceiver?.direction ?? null,
        currentDirection: transceiver?.currentDirection ?? null,
        hasLocalTrack: local !== null,
        localTrackState: local?.readyState ?? null,
        localTrackMuted: local ? local.muted : null,
        remoteTrackState: remote?.readyState ?? null,
        remoteTrackMuted: remote ? remote.muted : null,
        remoteTrackEnabled: remote ? remote.enabled : null,
      };
    }

    const appAudio = this.#transceivers.get('appAudio') ?? null;

    return {
      signalingState: this.pc.signalingState,
      iceConnectionState: this.pc.iceConnectionState,
      connectionState: this.pc.connectionState,
      transceiverMid: this.#transceivers.get('video')?.mid ?? null,
      transceiverDirection: this.#transceivers.get('video')?.direction ?? null,
      currentDirection: this.#transceivers.get('video')?.currentDirection ?? null,
      transceiverCount: this.pc.getTransceivers().length,
      localSdpDirection: extractVideoDirection(this.pc.localDescription?.sdp),
      remoteSdpDirection: extractVideoDirection(this.pc.remoteDescription?.sdp),
      localVideoSdp: extractVideoSection(this.pc.localDescription?.sdp),
      remoteVideoSdp: extractVideoSection(this.pc.remoteDescription?.sdp),
      directionRepairAttempts: this.#directionRepairAttempts,
      iceRestartAttempts: this.#iceRestartAttempts,
      iceRestartMaxAttempts: ICE_RESTART_MAX_ATTEMPTS,
      iceRestartPending: this.#iceRestartPending,
      iceRestartScheduled: this.#iceRestartTimer !== null,
      iceRestartAnswerPending: this.#iceRestartAnswerTimer !== null,
      hasSenderTrack: track !== null,
      senderTrackState: track?.readyState ?? null,
      senderTrackMuted: track ? track.muted : null,
      sentMedia: this.#localTracks.video !== null,
      audioTransceiverMid: appAudio?.mid ?? null,
      audioCurrentDirection: appAudio?.currentDirection ?? null,
      hasSenderAudioTrack: (appAudio?.sender.track ?? null) !== null,
      localAudioTrackReadyState: this.#localTracks.appAudio?.readyState ?? null,
      roles,
      appliedQuality: this.#appliedQuality,
      encoding: this.readEncodingParams(),
    };
  }

  #describeTransceivers(): string {
    const list = this.pc
      .getTransceivers()
      .map((t) => {
        const role = roleForMid(t.mid);
        return (
          `${t.mid ?? 'null'}${role ? `:${role}` : ':?'}:${t.direction}→${t.currentDirection ?? 'null'}` +
          `${t.sender.track ? '/有轨' : '/无轨'}${isStopped(t) ? '/stopped' : ''}`
        );
      });
    return ` transceivers=[${list.join(', ')}]`;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    // 定时器必须在 close 时清掉。链路已经销毁，退避定时器再醒来
    // 只会对着一条不存在的链路重开 ICE 并写日志 —— mesh 8 人时
    // 一个人退出会连带销毁 7 条链路，这些幽灵定时器全都得掐掉。
    if (this.#iceRestartTimer !== null) {
      clearTimeout(this.#iceRestartTimer);
      this.#iceRestartTimer = null;
    }
    if (this.#iceRestartResetTimer !== null) {
      clearTimeout(this.#iceRestartResetTimer);
      this.#iceRestartResetTimer = null;
    }
    if (this.#iceRestartAnswerTimer !== null) {
      clearTimeout(this.#iceRestartAnswerTimer);
      this.#iceRestartAnswerTimer = null;
    }

    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onicecandidateerror = null;

    try {
      this.pc.close();
    } catch {
      // 重复 close 会抛，忽略
    }

    this.stats.reset();
    this.#remoteStream = null;
    this.#localTracks = emptyLocalTracks();
    this.#remoteTracks = emptyRemoteTracks();
    this.#transceivers.clear();
    this.#state = 'closed';
    this.#onStateChange('closed', 'link closed');
  }

  #fail(err: unknown): void {
    this.#onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * 从 SDP 里取出 m=video 段的媒体方向。
 *
 * 排障用：区分「发出去的报文意图就不对」和「对方答成了别的」。
 * 注意不能只扫 m=video 段的头几行 —— 方向属性排在 rtpmap/fmtp 之后。
 */
export function extractVideoDirection(sdp: string | undefined): string | null {
  if (!sdp) return null;
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video');
      continue;
    }
    if (!inVideo) continue;
    const match = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** 取出 m=video 段的前若干行，排查「m-line 怎么谈的」时用 */
export function extractVideoSection(sdp: string | undefined, maxLines = 4): string[] | null {
  if (!sdp) return null;
  const lines = sdp.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('m=video'));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length && out.length < maxLines; i += 1) {
    if (i > start && lines[i].startsWith('m=')) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * 从 SDP 里列出所有 m-line 的类型与 mid。
 *
 * 验收脚本用它核对「三条 m-line 的类型与顺序真的是 video / audio / audio」——
 * 只看我们自己的 transceiver 列表证不了这件事，得看真正协商出去的报文。
 */
export function extractMediaLines(sdp: string | undefined): Array<{ kind: string; mid: string | null }> {
  if (!sdp) return [];
  const out: Array<{ kind: string; mid: string | null }> = [];
  let current: { kind: string; mid: string | null } | null = null;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      if (current) out.push(current);
      current = { kind: line.slice(2).split(/\s+/)[0] ?? '', mid: null };
      continue;
    }
    if (!current || current.mid !== null) continue;
    const match = /^a=mid:(\S+)/.exec(line);
    if (match) current.mid = match[1] ?? null;
  }
  if (current) out.push(current);
  return out;
}

/**
 * transceiver 是否已停止。
 *
 * `stopped` 在部分 TS DOM 版本里没声明，用结构化读取避免为它放宽 lib 配置。
 */
export function isStopped(transceiver: RTCRtpTransceiver): boolean {
  return (transceiver as { stopped?: boolean }).stopped === true;
}
