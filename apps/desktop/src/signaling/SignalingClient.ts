import {
  ClientEvent,
  DEFAULT_QUALITY,
  ProtocolErrorCode,
  ServerEvent,
  type AckResponse,
  type CreateRoomPayload,
  type ErrorPayload,
  type HeartbeatAckPayload,
  type IceCandidatePayload,
  type JoinRoomPayload,
  type LeaveRoomAckData,
  type PeerInfo,
  type PeerJoinedPayload,
  type PeerLeftPayload,
  type PeerUpdatedPayload,
  type QualityChangedPayload,
  type QualityChangedRequest,
  type QualityLevel,
  type QualityRequestPayload,
  type RoomCreatedPayload,
  type RoomJoinedPayload,
  type ShareStartedPayload,
  type ShareStatePayload,
  type ShareStoppedPayload,
  type SignalEnvelope,
  type WebRtcAnswerPayload,
  type WebRtcOfferPayload,
} from '@game-share/protocol';
import { HEARTBEAT_INTERVAL_MS } from '@game-share/shared';
import { io, type Socket } from 'socket.io-client';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** request() 的超时时间：ack 迟迟不回就当作失败，避免 UI 卡在 loading */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 把引擎层的连接错误翻译成「照着做就能修好」的提示。
 *
 * Socket.IO 的 `connect_error` 原文是 `xhr poll error` / `websocket error`
 * 这类运输层术语，看的人根本不知道它其实只有一个含义：请求压根没到服务器。
 *
 * 三种地址要分开说，因为「照着做」的动作完全不同：
 * - 隧道地址：那是给对面填的。本机填自己的隧道地址虽然也能绕回来，但隧道
 *   一旦关了（或对面填的时候你还没开），表现就是连不上 —— 原先这里一句
 *   「执行 npm run serve」既是误导，打包版用户也根本没有 npm 可用。
 * - 本机地址：动作是「把本机信令服务的开关打开」。
 * - 其他地址：动作是「确认对方开着服务、地址没抄错、防火墙放行」。
 */
function describeConnectError(err: Error, url: string): string {
  const raw = err.message || '(空)';
  const cause = /timeout/i.test(raw) ? '响应超时，多半是被防火墙拦了' : '连不上';
  const tail = `原始错误：${raw}`;

  if (/trycloudflare\.com/i.test(url)) {
    return (
      `连不上 ${url}：${cause}。这个隧道地址是「发给对方填」的，本机自己连请改用 ` +
      `http://localhost:8080。如果隧道已经关掉，重新打开左侧「异地访问」开关就能恢复。${tail}`
    );
  }

  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(url)) {
    return (
      `连不上 ${url}：${cause}。本机信令服务没在跑 —— 打开左侧「本机信令服务」的启用开关，` +
      `或先启动本项目再连。${tail}`
    );
  }

  return (
    `连不上 ${url}：${cause}。确认对方已经启动信令服务、地址没抄错，` +
    `跨机连接还要确认 Windows 防火墙已放行。${tail}`
  );
}

export interface SignalingEvents {
  state: (state: ConnectionState, detail?: string) => void;
  error: (error: ErrorPayload) => void;
  peerJoined: (peer: PeerInfo) => void;
  peerLeft: (peerId: string, reason: string) => void;
  peerUpdated: (peer: PeerInfo) => void;
  shareState: (state: ShareStatePayload) => void;
  /** 到信令服务器的应用层 RTT（毫秒） */
  heartbeat: (rttMs: number) => void;
  offer: (fromPeerId: string, payload: WebRtcOfferPayload) => void;
  answer: (fromPeerId: string, payload: WebRtcAnswerPayload) => void;
  iceCandidate: (fromPeerId: string, payload: IceCandidatePayload) => void;
  qualityRequest: (fromPeerId: string, payload: QualityRequestPayload) => void;
  qualityChanged: (fromPeerId: string, payload: QualityChangedPayload) => void;
}

export class SignalingError extends Error {
  readonly payload: ErrorPayload;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = 'SignalingError';
    this.payload = payload;
  }
}

export class SignalingClient {
  #socket: Socket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /* ---------------- 事件订阅 ---------------- */

  on<K extends keyof SignalingEvents>(event: K, handler: SignalingEvents[K]): () => void {
    const key = event as string;
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    const wrapped = handler as unknown as (...args: unknown[]) => void;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  #emit<K extends keyof SignalingEvents>(event: K, ...args: Parameters<SignalingEvents[K]>): void {
    const set = this.#listeners.get(event as string);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[SignalingClient] 事件处理器抛出异常 event=${String(event)}`, err);
      }
    }
  }

  /* ---------------- 连接 ---------------- */

  get connected(): boolean {
    return this.#socket?.connected ?? false;
  }

  connect(url: string): void {
    this.disconnect();
    this.#emit('state', 'connecting');

    const socket = io(url, {
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      reconnectionAttempts: Infinity,
    });

    this.#socket = socket;
    this.#bind(socket, url);
  }

  disconnect(): void {
    this.#stopHeartbeat();
    if (this.#socket) {
      this.#socket.removeAllListeners();
      this.#socket.disconnect();
      this.#socket = null;
    }
    this.#emit('state', 'idle');
  }

  #bind(socket: Socket, url: string): void {
    socket.on('connect', () => {
      this.#emit('state', 'connected');
      this.#startHeartbeat();
    });

    socket.on('disconnect', (reason: string) => {
      this.#stopHeartbeat();
      this.#emit('state', 'disconnected', reason);
    });

    socket.on('connect_error', (err: Error) => {
      this.#emit('state', 'disconnected', describeConnectError(err, url));
    });

    socket.on(ServerEvent.ProtocolError, (payload: ErrorPayload) => {
      this.#emit('error', payload);
    });

    socket.on(ServerEvent.PeerJoined, (p: PeerJoinedPayload) => this.#emit('peerJoined', p.peer));
    socket.on(ServerEvent.PeerLeft, (p: PeerLeftPayload) =>
      this.#emit('peerLeft', p.peerId, p.reason),
    );
    socket.on(ServerEvent.PeerUpdated, (p: PeerUpdatedPayload) => this.#emit('peerUpdated', p.peer));

    socket.on(ServerEvent.ShareStarted, (p: ShareStatePayload) => this.#emit('shareState', p));
    socket.on(ServerEvent.ShareStopped, (p: ShareStatePayload) => this.#emit('shareState', p));

    // 以下三种为 P2P 信令，M1 起由 PeerManager 消费。
    // fromPeerId 只采信服务端注入的值。
    socket.on(ServerEvent.WebRtcOffer, (env: SignalEnvelope<WebRtcOfferPayload>) =>
      this.#emit('offer', env.fromPeerId, env.payload),
    );
    socket.on(ServerEvent.WebRtcAnswer, (env: SignalEnvelope<WebRtcAnswerPayload>) =>
      this.#emit('answer', env.fromPeerId, env.payload),
    );
    socket.on(ServerEvent.IceCandidate, (env: SignalEnvelope<IceCandidatePayload>) =>
      this.#emit('iceCandidate', env.fromPeerId, env.payload),
    );
    socket.on(ServerEvent.QualityRequest, (env: SignalEnvelope<QualityRequestPayload>) =>
      this.#emit('qualityRequest', env.fromPeerId, env.payload),
    );
    socket.on(ServerEvent.QualityChanged, (env: SignalEnvelope<QualityChangedPayload>) =>
      this.#emit('qualityChanged', env.fromPeerId, env.payload),
    );
  }

  /* ---------------- 心跳 ---------------- */

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    void this.#beat();
    this.#heartbeatTimer = setInterval(() => void this.#beat(), HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  async #beat(): Promise<void> {
    const sentAt = Date.now();
    try {
      await this.#request<HeartbeatAckPayload>(ClientEvent.Heartbeat, { sentAt });
      this.#emit('heartbeat', Date.now() - sentAt);
    } catch {
      // 心跳失败无需额外处理：socket 自身的重连机制会触发 state 变更
    }
  }

  /* ---------------- 请求 ---------------- */

  #request<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.#socket;
      if (!socket?.connected) {
        reject(
          new SignalingError({
            code: ProtocolErrorCode.Internal,
            message: '尚未连接到信令服务器',
          }),
        );
        return;
      }

      socket.timeout(REQUEST_TIMEOUT_MS).emit(
        event,
        payload,
        (err: Error | null, res: AckResponse<T> | undefined) => {
          if (err) {
            reject(new SignalingError({ code: ProtocolErrorCode.Internal, message: `${event} 请求超时` }));
            return;
          }
          if (res?.ok) {
            resolve(res.data);
            return;
          }
          reject(
            new SignalingError(
              res?.error ?? { code: ProtocolErrorCode.Internal, message: '服务端返回了空响应' },
            ),
          );
        },
      );
    });
  }

  /* ---------------- 房间操作 ---------------- */

  createRoom(nickname: string): Promise<RoomCreatedPayload> {
    const payload: CreateRoomPayload = { nickname };
    return this.#request<RoomCreatedPayload>(ClientEvent.CreateRoom, payload);
  }

  joinRoom(roomCode: string, nickname: string): Promise<RoomJoinedPayload> {
    const payload: JoinRoomPayload = { roomCode, nickname };
    return this.#request<RoomJoinedPayload>(ClientEvent.JoinRoom, payload);
  }

  leaveRoom(): Promise<LeaveRoomAckData> {
    return this.#request<LeaveRoomAckData>(ClientEvent.LeaveRoom, {});
  }

  /* ---------------- P2P 信令发送（M1 起使用） ---------------- */

  sendOffer(targetPeerId: string, sdp: string): void {
    const payload: WebRtcOfferPayload = { targetPeerId, sdp, sdpType: 'offer' };
    this.#socket?.emit(ClientEvent.WebRtcOffer, payload);
  }

  sendAnswer(targetPeerId: string, sdp: string): void {
    const payload: WebRtcAnswerPayload = { targetPeerId, sdp, sdpType: 'answer' };
    this.#socket?.emit(ClientEvent.WebRtcAnswer, payload);
  }

  sendIceCandidate(targetPeerId: string, candidate: RTCIceCandidateInit): void {
    const payload: IceCandidatePayload = {
      targetPeerId,
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    };
    this.#socket?.emit(ClientEvent.IceCandidate, payload);
  }

  /* ---------------- 共享状态广播（M1 起使用） ---------------- */

  setSharing(sharing: boolean, quality: QualityLevel = DEFAULT_QUALITY): void {
    if (sharing) {
      const payload: ShareStartedPayload = { quality };
      this.#socket?.emit(ClientEvent.ShareStarted, payload);
    } else {
      const payload: ShareStoppedPayload = { reason: 'user' };
      this.#socket?.emit(ClientEvent.ShareStopped, payload);
    }
  }

  /** viewer 请求 sender 把「指向自己这一路」提到指定档位 */
  requestQuality(targetPeerId: string, level: QualityLevel): void {
    const payload: QualityRequestPayload = { targetPeerId, level };
    this.#socket?.emit(ClientEvent.QualityRequest, payload);
  }

  /** sender 回执，告知观看方实际生效的档位 */
  notifyQualityChanged(targetPeerId: string, level: QualityLevel): void {
    const payload: QualityChangedRequest = { targetPeerId, level };
    this.#socket?.emit(ClientEvent.QualityChanged, payload);
  }
}
