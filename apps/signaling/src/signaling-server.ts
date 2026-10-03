import { createServer, type Server as HttpServer } from 'node:http';

import {
  ClientEvent,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  ServerEvent,
  isQualityLevel,
  type AckResponse,
  type CreateRoomPayload,
  type ErrorPayload,
  type HeartbeatAckPayload,
  type HeartbeatPayload,
  type IceCandidatePayload,
  type JoinRoomPayload,
  type LeaveRoomAckData,
  type PeerJoinedPayload,
  type PeerLeftPayload,
  type PeerUpdatedPayload,
  type QualityChangedPayload,
  type QualityRequestPayload,
  type RoomCreatedPayload,
  type RoomJoinedPayload,
  type ShareStartedPayload,
  type ShareStatePayload,
  type ShareStoppedPayload,
  type SignalEnvelope,
  type TurnRelayPayload,
  type WebRtcAnswerPayload,
  type WebRtcOfferPayload,
} from '@game-share/protocol';
import { createLogger, type Logger } from '@game-share/shared';
import { Server, type Socket } from 'socket.io';

import { RoomManager } from './room-manager';
import { TurnCredentialProvider, TURN_CREDENTIAL_TTL_SEC } from './turn-credentials';

/** SDP 体积上限，防止客户端塞超大字符串耗尽内存 */
const MAX_SDP_LENGTH = 256 * 1024;
/** 单个 ICE candidate 字符串上限 */
const MAX_CANDIDATE_LENGTH = 4 * 1024;

export interface SignalingServerOptions {
  port: number;
  host: string;
  corsOrigins: string[] | '*';
  logger?: Logger;
  /** TURN 临时凭证的签发配置（M8）。不传 = 没有 TURN，走纯 P2P */
  turn?: { keyId: string; keySecret: string } | null;
  /** 注入用，测试时替换掉真实签发 */
  turnProvider?: TurnCredentialProvider;
}

export interface ListenResult {
  /** 实际生效的监听地址（可能与请求的不同：IPv6 不可用时会降级） */
  host: string;
  port: number;
  /** 是否同时接管 IPv4 与 IPv6 */
  dualStack: boolean;
  /** 降级原因，仅在请求双栈但系统不支持时出现 */
  fallbackReason?: string;
}

export interface SignalingServerHandle {
  readonly httpServer: HttpServer;
  readonly io: Server;
  readonly rooms: RoomManager;
  /**
   * TURN 凭证来源，未配置时为 null。
   *
   * 暴露出来是为了让 `/health` 报「本机到底有没有 TURN」——
   * 排障时最费时间的一句话就是「我明明配了 TURN 为什么没走中继」。
   */
  readonly turn: TurnCredentialProvider | null;
  /** 订阅 TURN 签发结果（成功/失败）。宿主用它刷新状态面板 */
  onTurnActivity(callback: (info: { ok: boolean; error: string }) => void): () => void;
  listen(): Promise<ListenResult>;
  close(): Promise<void>;
}

/** 这些错误码说明内核/网络栈不支持该地址族，而不是端口被占用 */
function isAddressFamilyUnavailable(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === 'EAFNOSUPPORT' ||
    err.code === 'EADDRNOTAVAIL' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'EPROTONOSUPPORT'
  );
}

type SocketAck<T> = ((response: AckResponse<T>) => void) | undefined;

function failure(
  code: ProtocolErrorCode,
  message: string,
): AckResponse<never> {
  return { ok: false, error: { code, message } };
}

export function createSignalingServer(options: SignalingServerOptions): SignalingServerHandle {
  const log = options.logger ?? createLogger('signaling');
  const rooms = new RoomManager();

  // TURN 凭证代理。没配就 null，客户端按纯 P2P 走（M8 之前的行为）。
  const turn =
    options.turnProvider ??
    (options.turn
      ? new TurnCredentialProvider({ ...options.turn, ttlSec: TURN_CREDENTIAL_TTL_SEC, logger: log })
      : null);

  if (turn) {
    log.info('TURN 已启用：进房时下发 Cloudflare 临时凭证（两端都在对称 NAT 时靠它兜底）');
  } else {
    log.info('TURN 未配置：本次按纯 P2P 运行，两端都在对称 NAT / CGNAT 时必然连不通');
  }

  /**
   * 取一份 TURN 凭证给客户端。
   *
   * **返回 undefined 而不是抛**：TURN 是兜底不是前提，取不到就让客户端
   * 走纯 P2P，别把整个建房流程搞失败（理由见 TurnCredentialProvider.get）。
   */
  async function resolveTurn(): Promise<TurnRelayPayload | undefined> {
    if (!turn) return undefined;
    const result = await turn.get();
    if (!result) return undefined;
    const server = result.iceServers[0];
    return {
      urls: Array.isArray(server.urls) ? [...server.urls] : [server.urls],
      username: server.username ?? '',
      credential: server.credential ?? '',
      // 漏掉这一行的话 credentialType 到客户端就成了 undefined，
      // 而客户端正靠它把「凭证类型不对」和「凭证本身无效」区分开。
      ...(server.credentialType === undefined
        ? {}
        : { credentialType: server.credentialType }),
      expiresAt: result.expiresAt,
    };
  }

  const httpServer = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'game-share-signaling',
          protocolVersion: PROTOCOL_VERSION,
          rooms: rooms.roomCount,
          peers: rooms.peerCount,
          uptimeSec: Math.round(process.uptime()),
          // TURN 的自述面板。lastError 必须在最前面 ——
          // 「配了 TURN 但签发失败」是最难自查的一类问题，
          // 页面收起时用户看不到日志，只能看这里。
          turn: turn
            ? {
                enabled: true,
                issued: turn.issuedCount,
                ttlSec: TURN_CREDENTIAL_TTL_SEC,
                lastError: turn.lastError || null,
              }
            : { enabled: false },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('game-share signaling server');
  });

  const io = new Server(httpServer, {
    cors: {
      origin: options.corsOrigins === '*' ? '*' : options.corsOrigins,
      methods: ['GET', 'POST'],
    },
    // 这是 socket.io 自身的连接保活；应用层 heartbeat 另算，
    // 用于在 UI 上给用户显示「到信令服务器的 RTT」
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 1e6,
  });

  function emitError(socket: Socket, code: ProtocolErrorCode, message: string): void {
    log.warn(`错误下发 peer=${socket.id} code=${code} msg=${message}`);
    socket.emit(ServerEvent.ProtocolError, { code, message } satisfies ErrorPayload);
  }

  /**
   * 定向信令转发（offer / answer / ice / quality-*）。
   *
   * 关键安全点：fromPeerId 由服务端在转发时注入，客户端报文里
   * 即使伪造了 fromPeerId 也会被覆盖 —— 接收端也只应采信这个字段。
   */
  function relayDirected<T extends { targetPeerId: string }>(
    socket: Socket,
    eventName: string,
    payload: T,
    validate?: (p: T) => string | null,
  ): void {
    const targetPeerId = (payload as { targetPeerId?: unknown } | undefined)?.targetPeerId;

    if (typeof targetPeerId !== 'string' || targetPeerId.length === 0) {
      emitError(socket, ProtocolErrorCode.InvalidPayload, `${eventName}: 缺少 targetPeerId`);
      return;
    }
    if (targetPeerId === socket.id) {
      emitError(socket, ProtocolErrorCode.InvalidPayload, `${eventName}: 不能向自己发送信令`);
      return;
    }
    if (!rooms.getRoomCode(socket.id)) {
      emitError(socket, ProtocolErrorCode.NotInRoom, `${eventName}: 当前连接不在房间中`);
      return;
    }
    if (!rooms.isSameRoom(socket.id, targetPeerId)) {
      emitError(socket, ProtocolErrorCode.TargetNotFound, `${eventName}: 目标成员不在同一房间`);
      return;
    }

    const invalidReason = validate?.(payload);
    if (invalidReason) {
      emitError(socket, ProtocolErrorCode.InvalidPayload, `${eventName}: ${invalidReason}`);
      return;
    }

    const envelope: SignalEnvelope<T> = { fromPeerId: socket.id, payload };
    io.to(targetPeerId).emit(eventName, envelope);
  }

  /** 广播给同房间内除自己外的所有人 */
  function broadcastToRoom<T>(socket: Socket, roomCode: string, eventName: string, payload: T): void {
    io.to(roomCode).except(socket.id).emit(eventName, payload);
  }

  function handleDeparture(roomCode: string, peerId: string, reason: string): void {
    const outcome = rooms.leaveRoom(peerId);
    if (!outcome) return;

    log.info(`成员离开 room=${roomCode} peer=${peerId} reason=${reason} 剩余=${outcome.others.length}`);

    io.to(roomCode).emit(ServerEvent.PeerLeft, {
      peerId,
      reason,
    } satisfies PeerLeftPayload);

    if (outcome.newHostPeerId) {
      const newHost = outcome.others.find((p) => p.peerId === outcome.newHostPeerId);
      if (newHost) {
        log.info(`房主转移 room=${roomCode} -> ${newHost.peerId}`);
        io.to(roomCode).emit(ServerEvent.PeerUpdated, {
          peer: newHost,
        } satisfies PeerUpdatedPayload);
      }
    }

    if (outcome.roomClosed) {
      log.info(`房间回收 room=${roomCode}（已无成员）`);
    }
  }

  io.on('connection', (socket) => {
    log.info(`连接建立 peer=${socket.id} addr=${socket.handshake.address}`);

    socket.on(ClientEvent.CreateRoom, (payload: CreateRoomPayload, ack?: SocketAck<RoomCreatedPayload>) => {
      const result = rooms.createRoom(socket.id, payload?.nickname);
      if (!result.ok) {
        ack?.(failure(result.error.code, result.error.message));
        return;
      }

      const { roomCode, self } = result.session;
      void socket.join(roomCode);
      log.info(`房间创建 room=${roomCode} host=${socket.id} 昵称=${self.nickname}`);

      // ack 要等 TURN 凭证就绪才发出去。慢的那几百毫秒只在**首次**发生
      //（之后走缓存），换来的是「一进房就带着完整 iceServers 建链路」——
      // 晚发就得重建链路，那比等一下更糟。
      void resolveTurn().then((turnRelay) => {
        ack?.({
          ok: true,
          data: { roomCode, self, peers: [], ...(turnRelay ? { turn: turnRelay } : {}) } satisfies RoomCreatedPayload,
        });
      });
    });

    socket.on(ClientEvent.JoinRoom, (payload: JoinRoomPayload, ack?: SocketAck<RoomJoinedPayload>) => {
      const result = rooms.joinRoom(payload?.roomCode, socket.id, payload?.nickname);
      if (!result.ok) {
        ack?.(failure(result.error.code, result.error.message));
        return;
      }

      const { roomCode, self, others } = result.session;
      void socket.join(roomCode);
      log.info(`加入房间 room=${roomCode} peer=${socket.id} 昵称=${self.nickname} 已有=${others.length}`);

      void resolveTurn().then((turnRelay) => {
        ack?.({
          ok: true,
          data: { roomCode, self, peers: others, ...(turnRelay ? { turn: turnRelay } : {}) } satisfies RoomJoinedPayload,
        });
      });

      broadcastToRoom(socket, roomCode, ServerEvent.PeerJoined, {
        peer: self,
      } satisfies PeerJoinedPayload);
    });

    socket.on(ClientEvent.LeaveRoom, (_payload, ack?: SocketAck<LeaveRoomAckData>) => {
      const roomCode = rooms.getRoomCode(socket.id);
      if (!roomCode) {
        ack?.(failure(ProtocolErrorCode.NotInRoom, '当前连接不在房间中'));
        return;
      }

      void socket.leave(roomCode);
      ack?.({ ok: true, data: { roomCode } satisfies LeaveRoomAckData });
      handleDeparture(roomCode, socket.id, 'leave');
    });

    socket.on(ClientEvent.WebRtcOffer, (payload: WebRtcOfferPayload) => {
      relayDirected(socket, ServerEvent.WebRtcOffer, payload, (p) => {
        if (typeof p.sdp !== 'string' || p.sdp.length === 0) return 'SDP 为空';
        if (p.sdp.length > MAX_SDP_LENGTH) return 'SDP 超出体积上限';
        return null;
      });
    });

    socket.on(ClientEvent.WebRtcAnswer, (payload: WebRtcAnswerPayload) => {
      relayDirected(socket, ServerEvent.WebRtcAnswer, payload, (p) => {
        if (typeof p.sdp !== 'string' || p.sdp.length === 0) return 'SDP 为空';
        if (p.sdp.length > MAX_SDP_LENGTH) return 'SDP 超出体积上限';
        return null;
      });
    });

    socket.on(ClientEvent.IceCandidate, (payload: IceCandidatePayload) => {
      relayDirected(socket, ServerEvent.IceCandidate, payload, (p) => {
        if (typeof p.candidate !== 'string') return 'candidate 必须是字符串';
        if (p.candidate.length > MAX_CANDIDATE_LENGTH) return 'candidate 超出体积上限';
        return null;
      });
    });

    socket.on(ClientEvent.ShareStarted, (payload: ShareStartedPayload) => {
      const roomCode = rooms.getRoomCode(socket.id);
      if (!roomCode) {
        emitError(socket, ProtocolErrorCode.NotInRoom, 'share-started: 当前连接不在房间中');
        return;
      }
      const quality = isQualityLevel(payload?.quality) ? payload.quality : undefined;
      const peer = rooms.setSharing(socket.id, true, quality);
      if (!peer) return;

      broadcastToRoom(socket, roomCode, ServerEvent.ShareStarted, {
        peerId: socket.id,
        sharing: true,
        quality: peer.shareQuality,
      } satisfies ShareStatePayload);
    });

    socket.on(ClientEvent.ShareStopped, (payload: ShareStoppedPayload) => {
      const roomCode = rooms.getRoomCode(socket.id);
      if (!roomCode) {
        emitError(socket, ProtocolErrorCode.NotInRoom, 'share-stopped: 当前连接不在房间中');
        return;
      }
      const peer = rooms.setSharing(socket.id, false);
      if (!peer) return;

      log.info(`停止共享 peer=${socket.id} reason=${payload?.reason ?? 'user'}`);
      broadcastToRoom(socket, roomCode, ServerEvent.ShareStopped, {
        peerId: socket.id,
        sharing: false,
      } satisfies ShareStatePayload);
    });

    // viewer 请求 sender 提高「指向自己这一路」的画质。
    // 服务端只转发，不介入画质决策 —— 实际编码参数由 sender 的 QualityManager 调整。
    socket.on(ClientEvent.QualityRequest, (payload: QualityRequestPayload) => {
      relayDirected(socket, ServerEvent.QualityRequest, payload, (p) =>
        isQualityLevel(p?.level) ? null : 'level 不是合法画质档位',
      );
      log.debug(`quality-request ${socket.id} -> ${payload?.targetPeerId} level=${payload?.level}`);
    });

    socket.on(ClientEvent.QualityChanged, (payload: QualityChangedPayload) => {
      relayDirected(socket, ServerEvent.QualityChanged, payload, (p) =>
        isQualityLevel(p?.level) ? null : 'level 不是合法画质档位',
      );
      log.debug(`quality-changed ${socket.id} -> ${payload?.targetPeerId} level=${payload?.level}`);
    });

    socket.on(ClientEvent.Heartbeat, (payload: HeartbeatPayload, ack?: SocketAck<HeartbeatAckPayload>) => {
      const sentAt = typeof payload?.sentAt === 'number' ? payload.sentAt : Date.now();
      ack?.({ ok: true, data: { sentAt, serverAt: Date.now() } });
    });

    socket.on('disconnect', (reason) => {
      log.info(`连接断开 peer=${socket.id} reason=${reason}`);
      const roomCode = rooms.getRoomCode(socket.id);
      if (roomCode) handleDeparture(roomCode, socket.id, `disconnect:${reason}`);
    });

    socket.on('error', (err: Error) => {
      log.error(`socket 错误 peer=${socket.id}`, err.message);
    });
  });

  return {
    httpServer,
    io,
    rooms,
    turn,
    onTurnActivity(callback) {
      // 没配 TURN 时订阅是合法的（退订即可），不必报错 ——
      // 宿主不该为了「有没有 TURN」写两套订阅逻辑。
      return turn ? turn.onActivity(callback) : () => undefined;
    },
    listen() {
      return new Promise<ListenResult>((resolve, reject) => {
        /**
         * 先按配置的地址绑；若请求的是双栈通配 '::' 而系统不支持 IPv6，
         * 降级到 '0.0.0.0' 继续跑，而不是直接启动失败——
         * IPv6 只是「更好的一条路」，不该成为服务起不来的理由。
         */
        const attempt = (host: string, allowFallback: boolean, fallbackReason?: string): void => {
          const onError = (err: NodeJS.ErrnoException): void => {
            httpServer.off('error', onError);
            if (allowFallback && isAddressFamilyUnavailable(err)) {
              log.warn(`监听 ${host} 失败（${err.code}），系统可能未启用 IPv6，降级为 0.0.0.0 仅 IPv4`);
              attempt('0.0.0.0', false, `${err.code}：${err.message}`);
              return;
            }
            reject(err);
          };

          httpServer.once('error', onError);
          httpServer.listen(options.port, host, () => {
            httpServer.off('error', onError);
            const address = httpServer.address();
            const actualPort =
              address && typeof address === 'object' ? address.port : options.port;
            resolve({
              host,
              port: actualPort,
              dualStack: host === '::' || host === '::0',
              ...(fallbackReason === undefined ? {} : { fallbackReason }),
            });
          });
        };

        attempt(options.host, true);
      });
    },
    close() {
      return new Promise((resolve) => {
        void io.close(() => resolve());
      });
    },
  };
}
