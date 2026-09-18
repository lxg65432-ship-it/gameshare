import {
  DEFAULT_QUALITY,
  type PeerInfo,
  type QualityLevel,
  type TrackRole,
} from '@game-share/protocol';
import { DEFAULT_SIGNALING_URL, buildIceServers } from '@game-share/shared';

import { CaptureError, CaptureManager } from '../media/CaptureManager';
import { MicCapture, type MicSettings } from '../media/MicCapture';
import { MeshManager } from '../rtc/MeshManager';
import type { LinkState, RemoteTracks } from '../rtc/types';
import {
  SignalingClient,
  SignalingError,
  type ConnectionState,
} from '../signaling/SignalingClient';
import type { AudioCaptureFailure, AudioCaptureMode } from '../types/global';

/**
 * 业务编排层：把信令、Mesh、采集三块拼成一个「会话」。
 *
 * UI 与自动化验收都只依赖这一层 —— 保证脚本跑的是真实代码路径，
 * 而不是另写一套只用来过测试的接线。
 *
 * 状态以不可变快照对外发布，React 侧用 useSyncExternalStore 订阅。
 *
 * --- 三条轨道的所有权分属两处，谁也别动谁的 ---
 *
 *   video / appAudio  →  `this.capture`（同一次桌面捕获的产物）
 *   voice             →  `this.mic`
 *
 * 所以「停止共享」只摘 video + appAudio，**绝不碰 voice** ——
 * 停止共享不等于挂电话，用户可能还在说话。反过来关麦也不该动画面。
 */

const MAX_LOG_LINES = 300;

export interface PeerLinkState {
  state: LinkState;
  detail: string;
}

export interface SessionState {
  connection: { state: ConnectionState; detail: string; rttMs: number | null };
  room: { roomCode: string; self: PeerInfo; peers: PeerInfo[] } | null;
  /** peerId -> 链路状态 */
  links: Record<string, PeerLinkState>;
  /** peerId -> 远端画面 */
  remoteStreams: Record<string, MediaStream>;
  /** peerId -> 远端三条轨（按角色）。要分别控制语音 / 应用声音就读这个，别看 MediaStream 的下标 */
  remoteTracks: Record<string, RemoteTracks>;
  /** peerId -> 对方是否正在共享 */
  remoteSharing: Record<string, boolean>;
  sharing: boolean;
  captureLabel: string | null;
  /** 本机这次共享是否真的带上了系统声音（采集降级时为 false） */
  hasAudio: boolean;
  /** 应用声音这一条轨当前是否在往外发（关掉后画面照常推） */
  appAudioEnabled: boolean;
  /** 这次共享用的音频模式（application / system / none…）；UI 显示「共享声音状态」用 */
  audioMode: AudioCaptureMode | null;
  /**
   * 本次共享的音频失败详情；null 表示没有失败。
   *
   * **这不是「已处理」的记录，而是「待用户决策」的挂起项**：采集层降级为无声
   * 只是保住画面，用户选择什么（换整机声音 / 接受无声 / 取消）必须显式给出，
   * UI 读到它就该把三个选项摆出来。用户做出选择或停止共享后清掉。
   */
  audioFailure: AudioCaptureFailure | null;
  /** 麦克风是否正在采集。false 就是真的把设备释放了，不是静音 */
  micEnabled: boolean;
  /** 麦克风开启失败的原因；正常时为 null */
  micError: string | null;
  /** 麦克风实际生效的约束 —— AEC / NS / AGC 有没有真落下去就看它 */
  micSettings: MicSettings | null;
  logs: string[];
}

export interface StartShareOptions {
  /** 真实采集源 id；与 testPattern 二选一 */
  sourceId?: string;
  /** 用合成动画源代替真实采集，自动化验收用 */
  testPattern?: boolean;
  label?: string;
  /** 合成源尺寸，默认 640x360 */
  width?: number;
  height?: number;
  fps?: number;
  /** 合成源那路声音的频率（Hz），默认 440。验收要按角色灌不同频率时用 */
  toneHz?: number;
  /** 合成音的幅度（0~1），默认 0.002 */
  toneGain?: number;
  /**
   * 真实采集时是否带系统声音，默认 true。
   *
   * 采不到时不会抛错，而是降级为无声画面，原因记在 capture.audioError 里。
   */
  withAudio?: boolean;
  /**
   * 要哪一种声音：`application`（按应用，窗口共享的正式方案）/ `system`（整机减本实例）
   * / `none` / `loopback`（调试）。
   *
   * 与 `withAudio` 同时给时**以它为准**。界面要给出「按应用共享声音」这个选项，
   * 就必须把它透传下去 —— 只给一个布尔开关的话，业务层就再也表达不了
   * 「只要那个游戏的声音」了。
   */
  audioMode?: AudioCaptureMode;
}

const INITIAL_STATE: SessionState = {
  connection: { state: 'idle', detail: '', rttMs: null },
  room: null,
  links: {},
  remoteStreams: {},
  remoteTracks: {},
  remoteSharing: {},
  sharing: false,
  captureLabel: null,
  hasAudio: false,
  appAudioEnabled: false,
  audioMode: null,
  audioFailure: null,
  micEnabled: false,
  micError: null,
  micSettings: null,
  logs: [],
};

export class ShareSession {
  readonly signaling: SignalingClient;
  readonly capture = new CaptureManager();
  readonly mic = new MicCapture();

  #mesh: MeshManager | null = null;
  #state: SessionState = INITIAL_STATE;
  #listeners = new Set<() => void>();
  #unsubscribe: Array<() => void> = [];
  #serverUrl = DEFAULT_SIGNALING_URL;
  /** 上一条连接状态日志，用于抑制重连风暴刷屏（见 #bindSignaling） */
  #lastConnLog = '';

  constructor() {
    this.signaling = new SignalingClient();
    this.capture.onSourceEnded(() => {
      this.pushLog('采集源已关闭，停止共享');
      this.stopShare('source-closed');
    });
    this.mic.onDeviceLost(() => {
      this.pushLog('麦克风设备已断开，已自动关闭');
      this.#stopMic('设备断开');
    });
    this.#bindSignaling();
  }

  /* ---------------- 订阅 ---------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getState = (): SessionState => this.#state;

  get mesh(): MeshManager | null {
    return this.#mesh;
  }

  get serverUrl(): string {
    return this.#serverUrl;
  }

  #patch(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[ShareSession] 订阅者抛出异常', err);
      }
    }
  }

  #patchRoom(updater: (room: NonNullable<SessionState['room']>) => SessionState['room']): void {
    const room = this.#state.room;
    if (!room) return;
    this.#patch({ room: updater(room) });
  }

  pushLog = (line: string): void => {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const next = [...this.#state.logs, `${stamp}  ${line}`];
    this.#patch({ logs: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next });
    console.log(`[${stamp}] ${line}`);
  };

  /* ---------------- 信令事件 ---------------- */

  #bindSignaling(): void {
    this.#unsubscribe = [
      this.signaling.on('state', (state, detail) => {
        this.#patch({
          connection: {
            state,
            detail: detail ?? '',
            // 断开后上一次的 RTT 已无意义，清掉避免 UI 显示陈旧数字
            rttMs: state === 'connected' ? this.#state.connection.rttMs : null,
          },
        });
        // Socket.IO 的 reconnection 是无限重试（1~5 秒一次）。服务器没起时
        // 失败原因每轮都一样，照单全记会让日志面板每秒多一条重复内容，
        // 真正有用的信息几秒钟就被挤出视野。只在「这条内容变了」时记一次。
        const line =
          state === 'connected'
            ? `已连接信令服务器 ${this.#serverUrl}`
            : state === 'connecting'
              ? `正在连接 ${this.#serverUrl} …`
              : state === 'disconnected'
                ? `与信令服务器断开：${detail || '未知原因'}`
                : null;
        if (line !== null && line !== this.#lastConnLog) {
          this.#lastConnLog = line;
          this.pushLog(line);
        }
        // 连上之后允许下一次断开重新记一条，否则「断开→重连→再断开」会静默
        if (state === 'connected') this.#lastConnLog = '';
      }),

      this.signaling.on('error', (err) => {
        this.pushLog(`[信令错误] ${err.code} ${err.message}`);
      }),

      this.signaling.on('heartbeat', (rttMs) => {
        this.#patch({ connection: { ...this.#state.connection, rttMs } });
      }),

      this.signaling.on('peerJoined', (peer) => {
        this.pushLog(`${peer.nickname} 加入房间`);
        this.#patchRoom((room) => {
          if (room.peers.some((p) => p.peerId === peer.peerId)) return room;
          return { ...room, peers: [...room.peers, peer] };
        });
        this.#syncMesh();
      }),

      this.signaling.on('peerLeft', (peerId, reason) => {
        const gone = this.#state.room?.peers.find((p) => p.peerId === peerId);
        this.pushLog(`${gone?.nickname ?? peerId} 离开房间（${reason}）`);
        this.#patchRoom((room) => ({ ...room, peers: room.peers.filter((p) => p.peerId !== peerId) }));
        this.#prunePeer(peerId);
        this.#syncMesh();
      }),

      this.signaling.on('peerUpdated', (peer) => {
        this.#patchRoom((room) => {
          const self = room.self.peerId === peer.peerId ? peer : room.self;
          const peers = room.peers.map((p) => (p.peerId === peer.peerId ? peer : p));
          return { ...room, self, peers };
        });
        // 这条广播里也带着共享状态（房主转移就走这里），一并同步。
        // 自己的状态由本地维护，不信服务端回灌的那一份。
        if (this.#state.room?.self.peerId !== peer.peerId) {
          this.#setRemoteSharing(peer.peerId, peer.sharing);
        }
      }),

      this.signaling.on('shareState', (state) => {
        this.#setRemoteSharing(state.peerId, state.sharing);
      }),

      // 观看者请求把「我 → 他」这一路提档。只动这一条链路，其他观看者不受影响。
      this.signaling.on('qualityRequest', (fromPeerId, payload) => {
        this.setQualityFor(fromPeerId, payload.level);
      }),
    ];
  }

  /* ---------------- 连接与房间 ---------------- */

  connect(url?: string): void {
    this.#serverUrl = url?.trim() || DEFAULT_SIGNALING_URL;
    this.signaling.connect(this.#serverUrl);
  }

  disconnect(): void {
    this.#teardownMesh();
    this.stopShare();
    // 离场就把麦克风释放掉：房间都不在了还占着录音设备，托盘上的
    // 录音指示灯一直亮着，用户会以为程序在偷听。
    this.#stopMic('断开连接');
    this.signaling.disconnect();
    this.#patch({ room: null, links: {}, remoteStreams: {}, remoteTracks: {}, remoteSharing: {} });
  }

  async createRoom(nickname: string): Promise<{ roomCode: string; self: PeerInfo; peers: PeerInfo[] }> {
    const data = await this.signaling.createRoom(nickname);
    this.#enterRoom(data.roomCode, data.self, data.peers);
    this.pushLog(`房间已创建：${data.roomCode}`);
    return data;
  }

  async joinRoom(
    roomCode: string,
    nickname: string,
  ): Promise<{ roomCode: string; self: PeerInfo; peers: PeerInfo[] }> {
    const data = await this.signaling.joinRoom(roomCode, nickname);
    this.#enterRoom(data.roomCode, data.self, data.peers);
    this.pushLog(`已加入房间：${data.roomCode}，当前 ${data.peers.length + 1} 人`);
    return data;
  }

  async leaveRoom(): Promise<void> {
    try {
      await this.signaling.leaveRoom();
    } finally {
      this.#teardownMesh();
      this.stopShare();
      this.#stopMic('离开房间');
      this.#patch({ room: null, links: {}, remoteStreams: {}, remoteTracks: {}, remoteSharing: {} });
      this.pushLog('已离开房间');
    }
  }

  /**
   * 进入房间时重建 Mesh。
   *
   * selfPeerId 必须等 create/join 的 ack 才知道，而 PeerLink 的
   * 「谁当主动方」要靠它判定，所以 MeshManager 只能在这个时点构造，
   * 不能提前建好再补 selfPeerId。
   */
  #enterRoom(roomCode: string, self: PeerInfo, peers: PeerInfo[]): void {
    this.#teardownMesh();

    // 服务端在建房 / 加入的 ack 里已经把成员连同 `sharing` 一起带回来了，
    // 这里必须照着初始化一遍。不读它的后果实测踩到过：**后加入的人看谁都是
    // 「未共享」** —— 对方明明正在推流、格子里的画面还在动，标签却说没共享，
    // 而且这要等对方手动切一次共享状态才会自愈。
    const remoteSharing: Record<string, boolean> = {};
    for (const peer of peers) {
      if (peer.sharing) remoteSharing[peer.peerId] = true;
    }

    this.#patch({
      room: { roomCode, self, peers },
      links: {},
      remoteStreams: {},
      remoteTracks: {},
      remoteSharing,
    });
    this.#syncMesh();
  }

  #syncMesh(): void {
    const room = this.#state.room;
    if (!room) return;

    if (!this.#mesh) {
      this.#mesh = new MeshManager({
        signaling: this.signaling,
        iceServers: buildIceServers(),
        selfPeerId: room.self.peerId,
        getSourceHeight: () => this.capture.sourceHeight,
        onLinkStateChange: (peerId, state, detail) => {
          // 对端已离开房间时，链路拆除过程中的 'closed' 回调会晚于 #prunePeer，
          // 照单收下就等于把刚删掉的条目又塞回 state —— UI 上会永远留着一个
          // 「已断开」的幽灵格子，而且它再也不会消失。
          // 成员列表是链路归属的唯一依据：不在列表里的对端，状态变化一律丢弃。
          if (!this.#isMember(peerId)) return;
          this.#patch({
            links: { ...this.#state.links, [peerId]: { state, detail: detail ?? '' } },
          });
        },
        onRemoteStream: (peerId, stream) => {
          this.#patch({ remoteStreams: { ...this.#state.remoteStreams, [peerId]: stream } });
        },
        onRemoteTracks: (peerId, tracks) => {
          // 同样按成员列表过滤：链路拆除后的收尾回调会把已经离开的人写回来
          if (!this.#isMember(peerId)) return;
          this.#patch({ remoteTracks: { ...this.#state.remoteTracks, [peerId]: tracks } });
        },
        onError: (peerId, err) => {
          this.pushLog(`[链路 ${peerId}] ${err.message}`);
        },
        log: (line) => this.pushLog(line),
      });
      this.#mesh.attach();

      // 允许先开麦 / 先开始共享再进房间：此时链路还不存在，等 Mesh 建好后补挂一次。
      // 三条轨分别判断，互不牵连（麦克风与共享的先后顺序是任意的）。
      this.#pushLocalTracksToMesh();
    }

    this.#mesh.syncPeers([room.self.peerId, ...room.peers.map((p) => p.peerId)]);
  }

  /** 把当前真实存在的本地轨补挂到 Mesh 上（进房 / 重建 Mesh 后用） */
  #pushLocalTracksToMesh(): void {
    const mesh = this.#mesh;
    if (!mesh) return;
    const video = this.capture.stream?.getVideoTracks()[0] ?? null;
    if (video) mesh.setLocalTrack('video', video);
    if (this.#state.appAudioEnabled) {
      const appAudio = this.capture.stream?.getAudioTracks()[0] ?? null;
      if (appAudio) mesh.setLocalTrack('appAudio', appAudio);
    }
    if (this.mic.live) mesh.setLocalTrack('voice', this.mic.track);
  }

  /**
   * 该 peerId 是否还在当前房间里。
   *
   * 用来挡住「链路拆除时的收尾回调」：那些回调发生在成员已被移除之后，
   * 若不拦截就会把已经删掉的状态重新写回来。
   */
  #isMember(peerId: string): boolean {
    const room = this.#state.room;
    if (!room) return false;
    return room.self.peerId === peerId || room.peers.some((p) => p.peerId === peerId);
  }

  /**
   * 记录「某位成员此刻是否在共享」。
   *
   * 表 false 的方式是**删掉这个键**，而不是存一个 false —— 这样
   * `remoteSharing[id]` 的真值判断和成员清理是同一件事，不会留下
   * 「键还在、值是 false」的中间态。
   *
   * 三个入口都汇到这里：进房时的成员快照（见 `#enterRoom`）、
   * `shareState` 广播、`peerUpdated`（房主转移会重新广播整个 PeerInfo）。
   */
  #setRemoteSharing(peerId: string, sharing: boolean): void {
    if (this.#state.room?.self.peerId === peerId) return;
    if (!this.#isMember(peerId)) return;
    const next = { ...this.#state.remoteSharing };
    if (sharing) next[peerId] = true;
    else delete next[peerId];
    this.#patch({ remoteSharing: next });
  }

  #prunePeer(peerId: string): void {
    const links = { ...this.#state.links };
    const remoteStreams = { ...this.#state.remoteStreams };
    const remoteTracks = { ...this.#state.remoteTracks };
    const remoteSharing = { ...this.#state.remoteSharing };
    delete links[peerId];
    delete remoteStreams[peerId];
    delete remoteTracks[peerId];
    delete remoteSharing[peerId];
    this.#patch({ links, remoteStreams, remoteTracks, remoteSharing });
  }

  #teardownMesh(): void {
    this.#mesh?.close();
    this.#mesh = null;
  }

  /* ---------------- 麦克风（Voice Track） ---------------- */

  /**
   * 开 / 关麦克风。与共享完全解耦：开关它不动画面，也不动应用声音。
   *
   * 开启失败时会**抛错**并且把原因留在 `state.micError` 里。刻意不做
   * 「失败就静音继续」那种降级 —— 用户以为自己在说话、对面什么都听不到，
   * 比直接报错难查得多。
   */
  async setMicEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.#stopMic('用户关闭');
      return;
    }
    if (this.mic.live) return;

    try {
      const track = await this.mic.start();
      // 先挂轨再报状态：反过来会出现「界面说开着、实际还没挂上」的窗口
      this.#mesh?.setLocalTrack('voice', track);
      const settings = this.mic.settings;
      this.#patch({ micEnabled: true, micError: null, micSettings: settings });
      this.pushLog(
        `麦克风已开启（回声消除=${yesNo(settings?.echoCancellation)}，` +
          `降噪=${yesNo(settings?.noiseSuppression)}，自动增益=${yesNo(settings?.autoGainControl)}）`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.mic.stop();
      this.#mesh?.setLocalTrack('voice', null);
      this.#patch({ micEnabled: false, micError: message, micSettings: null });
      this.pushLog(`麦克风开启失败：${message}`);
      throw err;
    }
  }

  /** 关麦的内部实现：真正释放设备。所有「非用户主动」的关闭路径也走这里。 */
  #stopMic(reason: string): void {
    if (!this.mic.live && !this.#state.micEnabled) return;
    this.mic.stop();
    this.#mesh?.setLocalTrack('voice', null);
    this.#patch({ micEnabled: false, micSettings: null });
    this.pushLog(`麦克风已关闭（${reason}）`);
  }

  /* ---------------- 应用声音（App Audio Track） ---------------- */

  /**
   * 单独开关应用声音，**不影响画面**。
   *
   * 实现上只做 `replaceTrack(null)`：不重新协商、不重新弹采集、不动 video 那条轨。
   *
   * ⚠️ 一个诚实的限制：关掉之后**采集并没有停**，只是不再往外发。
   * 原因是应用声音与画面是**同一次 `getDisplayMedia` 的产物**，
   * 想「单独重新采一路音频」在 Chromium 里做不到（没有只取音频的桌面捕获）。
   * 想彻底停止采集，只能停掉整个共享。这一点必须让用户知道 ——
   * 所以界面上说的是「关闭应用声音」，不是「停止采集声音」。
   */
  setAppAudioEnabled(enabled: boolean): void {
    if (enabled) {
      const track = this.capture.stream?.getAudioTracks()[0] ?? null;
      if (!track) {
        this.pushLog('这次共享没有可用的应用声音轨（采集时就没拿到），无法单独开启');
        // 不静默当成「开好了」：状态照实说是关着的
        if (this.#state.appAudioEnabled) this.#patch({ appAudioEnabled: false });
        return;
      }
      if (this.#state.appAudioEnabled) return;
      this.#mesh?.setLocalTrack('appAudio', track);
      this.#patch({ appAudioEnabled: true });
      this.pushLog('已开启应用声音（画面不受影响）');
      return;
    }

    if (!this.#state.appAudioEnabled) return;
    this.#mesh?.setLocalTrack('appAudio', null);
    this.#patch({ appAudioEnabled: false });
    this.pushLog('已关闭应用声音（画面继续共享）');
  }

  /**
   * 用户对「音频采集失败」做出了选择（继续无声共享）——收起告警。
   *
   * 只清 `audioFailure`，不动共享状态：画面与麦克风该怎么跑还怎么跑。
   * 换模式 / 停止共享这两个选项走的是各自完整的流程，不经过这里。
   */
  acknowledgeAudioFailure(): void {
    if (!this.#state.audioFailure) return;
    this.#patch({ audioFailure: null });
  }

  /* ---------------- 共享 ---------------- */

  async startShare(options: StartShareOptions = {}): Promise<void> {
    // 换源（或共享中改音频模式）的时序是「先采新，成了再换轨」：
    //
    // CaptureManager.startDisplay 内部在新采集**成功之后**才停掉旧采集（stop 旧 → adopt 新），
    // 失败时旧采集原封不动 —— 所以这里什么都不用先停。旧画面/旧声音会一直推到
    // 新轨挂上那一刻，中途不会黑一下；新采集失败则保留原共享，错误交给 UI 提示，
    // **绝不回滚成「未共享」** —— 任务书原话：「不要直接结束整个屏幕共享」。
    //
    // （旧轨的摘除动作在下面成功分支里做：startDisplay 返回时旧轨已 ended，
    // setLocalTrack 换上新轨的同时旧轨就从 sender 上离开了。）
    const wasSharing = this.#state.sharing;

    let stream: MediaStream;
    try {
      if (options.testPattern) {
        stream = this.capture.startTestPattern({
          label: options.label ?? 'TEST',
          width: options.width,
          height: options.height,
          fps: options.fps,
          toneHz: options.toneHz,
          toneGain: options.toneGain,
        });
      } else if (options.sourceId) {
        stream = await this.capture.startDisplay(options.sourceId, {
          withAudio: options.withAudio,
          audioMode: options.audioMode,
        });
      } else {
        throw new CaptureError('未指定采集源');
      }
    } catch (err) {
      if (wasSharing) {
        // 换源失败：旧采集毫发无损，状态一个字都不改，画面继续。
        this.pushLog(
          `切换共享源失败，已保留原共享：${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        this.pushLog(`开始共享失败：${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }

    const track = stream.getVideoTracks()[0] ?? null;
    const appAudio = stream.getAudioTracks()[0] ?? null;
    // 旧轨此刻已 ended（换源时 startDisplay 内部停掉了旧采集）；直接把新轨
    // replaceTrack 上去 —— mid 不变，不重新协商。
    this.#mesh?.setLocalTrack('video', track);
    this.#mesh?.setLocalTrack('appAudio', appAudio);
    if (!wasSharing) {
      this.signaling.setSharing(true, DEFAULT_QUALITY);
    }
    const failure = this.capture.audioFailure;
    this.#patch({
      sharing: true,
      captureLabel: this.capture.sourceLabel,
      hasAudio: appAudio !== null,
      appAudioEnabled: appAudio !== null,
      audioMode: this.capture.lastAudioMode,
      audioFailure: failure,
    });
    this.pushLog(
      `开始共享：${this.capture.sourceLabel ?? '未知源'}（${track?.getSettings().width ?? '?'}x${
        track?.getSettings().height ?? '?'
      }，源高 ${this.capture.sourceHeight ?? '?'}，${appAudio ? '含应用声音' : '无声音'}）`,
    );
    // 音频失败必须显式摆给用户（UI 读 state.audioFailure 弹三选项），
    // 不能只写一行日志就当没发生 —— 那等于静默修改了用户的选择。
    if (failure) {
      this.pushLog(`应用声音未采到，已降级为无声画面：${failure.message}`);
    }
  }

  /**
   * 停止共享，并让对端知道。
   *
   * 对端只能靠 `shareState` 判断你还在不在共享，漏发这条通知的话它会挂着一个
   * 永远收不到画面的「共享中」，而且在对端主动离开房间之前不会自愈。
   * （早先这里写的是 `reason === 'user'`，把 'source-closed' 一起漏掉了 ——
   * 用户关掉被共享的窗口后，对端就会永久停在「共享中」。）
   *
   * 换源不经过这里，见 startShare：它自己静默停旧源，避免中间闪一帧「未共享」。
   *
   * ⚠️ **只摘 video 与 appAudio，不碰 voice。** 停止共享不等于挂电话 ——
   * 语音通话与屏幕共享是两件独立的事，顺手把人家麦克风关掉是 bug。
   */
  stopShare(reason: 'user' | 'source-closed' = 'user'): void {
    if (!this.#state.sharing && !this.capture.stream) return;
    this.capture.stop();
    this.#mesh?.setLocalTrack('video', null);
    this.#mesh?.setLocalTrack('appAudio', null);
    this.signaling.setSharing(false);
    this.#patch({
      sharing: false,
      captureLabel: null,
      hasAudio: false,
      appAudioEnabled: false,
      audioMode: null,
      audioFailure: null,
    });
    this.pushLog(`已停止共享（${reason}）`);
  }

  /** 只调整「自己 → 指定观看者」这一条链路，其他人不受影响 */
  setQualityFor(peerId: string, level: QualityLevel): void {
    const ok = this.#mesh?.setQualityFor(peerId, level) ?? false;
    if (ok) {
      this.signaling.notifyQualityChanged(peerId, level);
      this.pushLog(`已为观看者 ${peerId} 调整画质 → ${level}`);
    }
  }

  /** 作为观看者，向某位发送方请求画质 */
  requestQualityFrom(peerId: string, level: QualityLevel): void {
    this.signaling.requestQuality(peerId, level);
  }

  /* ---------------- 只读派生 ---------------- */

  /**
   * 远端某位成员某条轨的轨道对象。
   *
   * 界面上要「只静音他的游戏声、留着他的语音」就必须走这里 ——
   * 从 `remoteStreams[peerId].getAudioTracks()` 按下标取是错的，
   * 下标顺序在轨道增删后会变。
   */
  remoteTrackOf(peerId: string, role: TrackRole): MediaStreamTrack | null {
    return this.#state.remoteTracks[peerId]?.[role] ?? null;
  }

  /** 彻底释放：解绑信令订阅、关闭链路、停止采集与麦克风 */
  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#teardownMesh();
    this.capture.stop();
    this.mic.stop();
    this.signaling.disconnect();
    this.#listeners.clear();
  }

  memberOf(peerId: string): PeerInfo | undefined {
    const room = this.#state.room;
    if (!room) return undefined;
    if (room.self.peerId === peerId) return room.self;
    return room.peers.find((p) => p.peerId === peerId);
  }

  static describeError(err: unknown): string {
    if (err instanceof SignalingError) return `${err.payload.code} ${err.message}`;
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

/** 把可选布尔渲染成日志里的「开 / 关 / 未知」 */
function yesNo(value: boolean | null | undefined): string {
  if (value === true) return '开';
  if (value === false) return '关';
  return '未知';
}
