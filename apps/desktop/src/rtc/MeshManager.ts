import { TRACK_ROLES, type TrackRole } from '@game-share/protocol';
import type { QualityLevel } from '@game-share/protocol';
import type { IceServerConfig } from '@game-share/shared';

import type { SignalingEvents } from '../signaling/SignalingClient';
import { PeerLink, type LinkDiagnostics } from './PeerLink';
import {
  emptyLocalTracks,
  type LinkState,
  type LocalTracks,
  type PeerSignaling,
  type RemoteTracks,
} from './types';

/**
 * 把「房间成员列表」翻译成「P2P 链路集合」。
 *
 * 关键点是同步的时机：A 通过 peer-joined 广播知道 B 来了，B 通过 join-room
 * 的 ack 拿到已有成员列表 —— 两条路径互不同步。若主动方在被动方建好链路
 * 之前就把 offer 发出去，那条 offer 会石沉大海，连接永远建不起来。
 * 所以这里对「未知 peer 的信令」一律先缓冲，链路建好后再补投。
 */

export interface MeshSignaling extends PeerSignaling {
  on<K extends keyof SignalingEvents>(event: K, handler: SignalingEvents[K]): () => void;
}

export interface MeshManagerOptions {
  signaling: MeshSignaling;
  iceServers: IceServerConfig[];
  selfPeerId: string;
  getSourceHeight?: () => number | null;
  onLinkStateChange?: (peerId: string, state: LinkState, detail?: string) => void;
  onRemoteStream?: (peerId: string, stream: MediaStream) => void;
  /** 远端三条轨按角色上报。接收侧要分别控制语音 / 应用声音时读这个 */
  onRemoteTracks?: (peerId: string, tracks: RemoteTracks) => void;
  onError?: (peerId: string, err: Error) => void;
  log?: (line: string) => void;
}

/** 缓冲上限：正常流程下每个 peer 最多攒几十个候选，超过说明对端行为异常 */
const MAX_BUFFERED_SIGNALS = 256;

type PendingSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export class MeshManager {
  #signaling: MeshSignaling;
  #iceServers: IceServerConfig[];
  #selfPeerId: string;
  #getSourceHeight: () => number | null;
  #onLinkStateChange: (peerId: string, state: LinkState, detail?: string) => void;
  #onRemoteStream: (peerId: string, stream: MediaStream) => void;
  #onRemoteTracks: (peerId: string, tracks: RemoteTracks) => void;
  #onError: (peerId: string, err: Error) => void;
  #log: (line: string) => void;

  #links = new Map<string, PeerLink>();
  #pending = new Map<string, PendingSignal[]>();
  #unsubscribe: Array<() => void> = [];
  /**
   * 三条本地轨，按角色存。
   *
   * **不要合并成一个「本地有没有东西」的布尔**：麦克风与共享是三件独立的事 ——
   * 停止共享绝不能顺手把麦克风也摘掉（用户还在说话），关麦也不该动画面。
   */
  #localTracks: LocalTracks = emptyLocalTracks();
  #attached = false;

  constructor(opts: MeshManagerOptions) {
    this.#signaling = opts.signaling;
    this.#iceServers = opts.iceServers;
    this.#selfPeerId = opts.selfPeerId;
    this.#getSourceHeight = opts.getSourceHeight ?? (() => null);
    this.#onLinkStateChange = opts.onLinkStateChange ?? (() => undefined);
    this.#onRemoteStream = opts.onRemoteStream ?? (() => undefined);
    this.#onRemoteTracks = opts.onRemoteTracks ?? (() => undefined);
    this.#onError = opts.onError ?? (() => undefined);
    this.#log = opts.log ?? (() => undefined);
  }

  /* ---------------- 信令订阅 ---------------- */

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;

    this.#unsubscribe = [
      this.#signaling.on('offer', (fromPeerId, payload) => {
        this.#route(fromPeerId, { kind: 'offer', sdp: payload.sdp });
      }),
      this.#signaling.on('answer', (fromPeerId, payload) => {
        this.#route(fromPeerId, { kind: 'answer', sdp: payload.sdp });
      }),
      this.#signaling.on('iceCandidate', (fromPeerId, payload) => {
        this.#route(fromPeerId, {
          kind: 'ice',
          candidate: {
            candidate: payload.candidate,
            sdpMid: payload.sdpMid,
            sdpMLineIndex: payload.sdpMLineIndex,
            usernameFragment: payload.usernameFragment ?? null,
          },
        });
      }),
    ];
  }

  detach(): void {
    this.#attached = false;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }

  #route(fromPeerId: string, signal: PendingSignal): void {
    // 只信任服务端注入的 fromPeerId；自己发给自己的报文直接丢掉
    if (!fromPeerId || fromPeerId === this.#selfPeerId) return;

    const link = this.#links.get(fromPeerId);
    if (!link) {
      const queue = this.#pending.get(fromPeerId) ?? [];
      if (queue.length >= MAX_BUFFERED_SIGNALS) {
        this.#log(`来自 ${fromPeerId} 的缓冲信令过多，丢弃最旧一条`);
        queue.shift();
      }
      queue.push(signal);
      this.#pending.set(fromPeerId, queue);
      return;
    }

    this.#deliver(link, signal);
  }

  #deliver(link: PeerLink, signal: PendingSignal): void {
    switch (signal.kind) {
      case 'offer':
        void link.handleOffer(signal.sdp);
        break;
      case 'answer':
        void link.handleAnswer(signal.sdp);
        break;
      case 'ice':
        void link.handleIceCandidate(signal.candidate);
        break;
    }
  }

  /* ---------------- 成员同步 ---------------- */

  /** 幂等：按目标成员集合增删链路，重复调用无副作用 */
  syncPeers(peerIds: readonly string[]): void {
    const wanted = new Set(peerIds.filter((id) => id && id !== this.#selfPeerId));

    for (const peerId of [...this.#links.keys()]) {
      if (!wanted.has(peerId)) this.removePeer(peerId);
    }
    for (const peerId of wanted) {
      if (!this.#links.has(peerId)) this.addPeer(peerId);
    }
  }

  addPeer(remotePeerId: string): PeerLink {
    const existing = this.#links.get(remotePeerId);
    if (existing) return existing;

    const link = new PeerLink({
      selfPeerId: this.#selfPeerId,
      remotePeerId,
      signaling: this.#signaling,
      iceServers: this.#iceServers,
      getSourceHeight: this.#getSourceHeight,
      onStateChange: (state, detail) => this.#onLinkStateChange(remotePeerId, state, detail),
      onRemoteStream: (stream) => this.#onRemoteStream(remotePeerId, stream),
      onRemoteTracks: (tracks) => this.#onRemoteTracks(remotePeerId, tracks),
      onError: (err) => this.#onError(remotePeerId, err),
      log: this.#log,
    });

    this.#links.set(remotePeerId, link);

    // 补投缓冲信令 —— 顺序不能变，offer 必须先于它的候选
    const queued = this.#pending.get(remotePeerId);
    if (queued) {
      this.#pending.delete(remotePeerId);
      this.#log(`补投 ${queued.length} 条缓冲信令 → ${remotePeerId}`);
      for (const signal of queued) this.#deliver(link, signal);
    }

    // 新链路建好后把三条本地轨一起补挂（麦克风可能早就在采了，
    // 共享也可能早就在推了 —— 两条路径的先后顺序是任意的）
    for (const role of TRACK_ROLES) {
      const track = this.#localTracks[role];
      if (track) void link.setLocalTrack(role, track);
    }

    return link;
  }

  removePeer(remotePeerId: string): void {
    const link = this.#links.get(remotePeerId);
    if (!link) return;
    this.#links.delete(remotePeerId);
    this.#pending.delete(remotePeerId);
    link.close();
  }

  /* ---------------- 本地媒体与画质 ---------------- */

  /**
   * 挂载 / 摘除**一条**角色的本地轨。
   *
   * 按角色单独调用，而不是一次给一整个对象：三条轨的所有权分属两处
   * （video / appAudio 归采集，voice 归麦克风），一次性覆盖会把另一处的
   * 状态抹掉 —— 「停止共享顺手静音」就是这么来的。
   */
  setLocalTrack(role: TrackRole, track: MediaStreamTrack | null): void {
    this.#localTracks[role] = track;
    for (const link of this.#links.values()) {
      void link.setLocalTrack(role, track);
    }
  }

  /** 只调整「自己 → 指定观看者」这一条链路 */
  setQualityFor(peerId: string, level: QualityLevel): boolean {
    const link = this.#links.get(peerId);
    if (!link) return false;
    void link.setQuality(level);
    return true;
  }

  getLink(peerId: string): PeerLink | undefined {
    return this.#links.get(peerId);
  }

  get links(): ReadonlyMap<string, PeerLink> {
    return this.#links;
  }

  get peerIds(): string[] {
    return [...this.#links.keys()];
  }

  getLocalTracks(): LocalTracks {
    return { ...this.#localTracks };
  }

  getLinkStates(): Record<string, LinkState> {
    const out: Record<string, LinkState> = {};
    for (const [peerId, link] of this.#links) out[peerId] = link.state;
    return out;
  }

  getDiagnostics(): Record<string, LinkDiagnostics> {
    const out: Record<string, LinkDiagnostics> = {};
    for (const [peerId, link] of this.#links) out[peerId] = link.getDiagnostics();
    return out;
  }

  close(): void {
    this.detach();
    for (const peerId of [...this.#links.keys()]) this.removePeer(peerId);
    this.#pending.clear();
    this.#localTracks = emptyLocalTracks();
  }
}
