import {
  DEFAULT_QUALITY,
  ROLE_MEDIA_KIND,
  TRACK_ROLES,
  QualityLevel,
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

export class PeerLink {
  readonly remotePeerId: string;
  readonly pc: RTCPeerConnection;
  readonly stats = new PeerStats();

  #transceivers = new Map<TrackRole, RTCRtpTransceiver>();
  #signaling: PeerSignaling;
  #polite: boolean;
  #initiator: boolean;
  #getSourceHeight: () => number | null;
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
  #appliedQuality: QualityLevel | null = null;
  #qualityLogDone = false;
  #directionRepairAttempts = 0;
  /** 保证「挂轨道 → 生成 offer」不会抢跑，否则会协商出单向 m-line */
  #pendingTrackApply: Promise<void> = Promise.resolve();
  #closed = false;
  #state: LinkState = 'new';
  /** 已上报过的 ICE 错误，key = `url|code`。避免 mesh 场景下同一错误刷屏 */
  #reportedIceErrors = new Set<string>();

  constructor(opts: PeerLinkOptions) {
    this.remotePeerId = opts.remotePeerId;
    this.#signaling = opts.signaling;
    this.#getSourceHeight = opts.getSourceHeight ?? (() => null);
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
      this.#signaling.sendIceCandidate(this.remotePeerId, candidate.toJSON());
    };

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
      this.#emitState();
      if (this.pc.connectionState === 'connected') {
        void this.#applyQuality();
        this.#scheduleDirectionCheck();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.#emitState();
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
    } catch (err) {
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
    const scaleDown = computeScaleResolutionDownBy(
      this.#getSourceHeight() ?? sender.track?.getSettings().height ?? null,
      profile.targetHeight,
    );

    try {
      const params = sender.getParameters();
      // 协商完成前 encodings 为空，这时不能填，否则 setParameters 会抛
      if (!params.encodings || params.encodings.length === 0) {
        throw new Error('encodings 尚未协商完成');
      }
      params.encodings[0].maxBitrate = profile.maxBitrate;
      params.encodings[0].maxFramerate = profile.maxFramerate;
      params.encodings[0].scaleResolutionDownBy = scaleDown;
      await sender.setParameters(params);

      this.#appliedQuality = this.#desiredQuality;
      this.#log(
        `画质 ${this.remotePeerId} → ${profile.label}（scaleDown=${scaleDown.toFixed(3)}，` +
          `base=${this.#getSourceHeight() ?? 'unknown'}p）`,
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
