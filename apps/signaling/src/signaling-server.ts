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
  type WebRtcAnswerPayload,
  type WebRtcOfferPayload,
} from '@game-share/protocol';
import { createLogger, type Logger } from '@game-share/shared';
import { Server, type Socket } from 'socket.io';

import { RoomManager } from './room-manager';

/** SDP 体积上限，防止客户端塞超大字符串耗尽内存 */
const MAX_SDP_LENGTH = 256 * 1024;
/** 单个 ICE candidate 字符串上限 */
const MAX_CANDIDATE_LENGTH = 4 * 1024;

export interface SignalingServerOptions {
  port: number;
  host: string;
  corsOrigins: string[] | '*';
  logger?: Logger;
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

      ack?.({
        ok: true,
        data: { roomCode, self, peers: [] } satisfies RoomCreatedPayload,
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

      ack?.({
        ok: true,
        data: { roomCode, self, peers: others } satisfies RoomJoinedPayload,
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
