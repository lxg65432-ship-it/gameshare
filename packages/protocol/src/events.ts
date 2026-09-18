import type { QualityLevel } from './quality';
import type { PeerInfo } from './room';

/* ------------------------------------------------------------------ *
 * 事件名常量 —— 对应规格文档第 9 节「信令协议」
 * ------------------------------------------------------------------ */

/** 客户端 -> 服务端 */
export const ClientEvent = {
  CreateRoom: 'create-room',
  JoinRoom: 'join-room',
  LeaveRoom: 'leave-room',
  WebRtcOffer: 'webrtc-offer',
  WebRtcAnswer: 'webrtc-answer',
  IceCandidate: 'ice-candidate',
  ShareStarted: 'share-started',
  ShareStopped: 'share-stopped',
  QualityRequest: 'quality-request',
  QualityChanged: 'quality-changed',
  Heartbeat: 'heartbeat',
} as const;

export type ClientEventName = (typeof ClientEvent)[keyof typeof ClientEvent];

/** 服务端 -> 客户端 */
export const ServerEvent = {
  PeerJoined: 'peer-joined',
  PeerLeft: 'peer-left',
  PeerUpdated: 'peer-updated',
  WebRtcOffer: 'webrtc-offer',
  WebRtcAnswer: 'webrtc-answer',
  IceCandidate: 'ice-candidate',
  ShareStarted: 'share-started',
  ShareStopped: 'share-stopped',
  QualityRequest: 'quality-request',
  QualityChanged: 'quality-changed',
  HeartbeatAck: 'heartbeat-ack',
  /**
   * 协议级错误（房间不存在、目标不在房间等）。
   * 刻意不叫 'error'：Socket.IO 两端都基于 EventEmitter，
   * 'error' 是特殊事件名，会和连接层错误混在一起难以区分。
   */
  ProtocolError: 'protocol-error',
} as const;

export type ServerEventName = (typeof ServerEvent)[keyof typeof ServerEvent];

/* ------------------------------------------------------------------ *
 * 错误码
 * ------------------------------------------------------------------ */

export const ProtocolErrorCode = {
  RoomNotFound: 'ROOM_NOT_FOUND',
  RoomFull: 'ROOM_FULL',
  NotInRoom: 'NOT_IN_ROOM',
  AlreadyInRoom: 'ALREADY_IN_ROOM',
  InvalidPayload: 'INVALID_PAYLOAD',
  TargetNotFound: 'TARGET_NOT_FOUND',
  Internal: 'INTERNAL',
} as const;

export type ProtocolErrorCode =
  (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
}

/* ------------------------------------------------------------------ *
 * 请求-响应 ack
 *
 * create-room / join-room / leave-room 使用 Socket.IO 的 ack 回调返回
 * 明确成败，而不是「发事件 + 等服务端广播」。这类请求有唯一确定的
 * 结果，走 ack 可以避免客户端维护 requestId 关联表。
 * 广播类事件（peer-joined / peer-left / 信令转发）仍然走事件。
 * ------------------------------------------------------------------ */

export type AckResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorPayload };

/* ------------------------------------------------------------------ *
 * 房间相关 payload
 * ------------------------------------------------------------------ */

export interface CreateRoomPayload {
  nickname: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  nickname: string;
}

/** 离开房间时可附带原因，服务端会广播给同房间其他人 */
export interface LeaveRoomPayload {
  reason?: string;
}

export interface RoomCreatedPayload {
  roomCode: string;
  self: PeerInfo;
  /** 创建时房间为空，这里是空数组；保留字段让两端处理逻辑统一 */
  peers: PeerInfo[];
}

export interface RoomJoinedPayload {
  roomCode: string;
  self: PeerInfo;
  /** 已在房间内的其他成员 —— 加入方需要对他们逐个发起 offer */
  peers: PeerInfo[];
}

export interface LeaveRoomAckData {
  roomCode: string;
}

export interface PeerJoinedPayload {
  peer: PeerInfo;
}

export interface PeerLeftPayload {
  peerId: string;
  reason: string;
}

export interface PeerUpdatedPayload {
  peer: PeerInfo;
}

/* ------------------------------------------------------------------ *
 * 定向信令 —— offer / answer / ice
 *
 * 客户端发送时填 targetPeerId；服务端转发前注入 fromPeerId，
 * 客户端只信任服务端注入的 fromPeerId，不信任报文里自带的。
 * ------------------------------------------------------------------ */

export interface WebRtcOfferPayload {
  targetPeerId: string;
  sdp: string;
  sdpType: 'offer';
}

export interface WebRtcAnswerPayload {
  targetPeerId: string;
  sdp: string;
  sdpType: 'answer';
}

export interface IceCandidatePayload {
  targetPeerId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

/** 服务端转发上述三种信令时统一的信封格式 */
export interface SignalEnvelope<T> {
  fromPeerId: string;
  payload: T;
}

/* ------------------------------------------------------------------ *
 * 共享状态
 * ------------------------------------------------------------------ */

export interface ShareStartedPayload {
  quality: QualityLevel;
}

export interface ShareStoppedPayload {
  reason?: 'user' | 'source-closed' | 'error';
}

export interface ShareStatePayload {
  peerId: string;
  sharing: boolean;
  quality?: QualityLevel;
}

/* ------------------------------------------------------------------ *
 * 动态画质协商
 *
 * viewer 请求 sender 提高/降低「指向自己这一路」的画质。
 * sender 只调整 sender -> viewer 这一条链路，不影响其他观看者。
 * ------------------------------------------------------------------ */

export interface QualityRequestPayload {
  /** 被观看的发送方 */
  targetPeerId: string;
  level: QualityLevel;
}

/**
 * sender 主动回报画质变更。
 *
 * 发送方只需要填 targetPeerId 与 level；fromPeerId 由服务端注入，
 * 与 offer / answer / ice 的处理方式保持一致。
 */
export interface QualityChangedRequest {
  targetPeerId: string;
  level: QualityLevel;
}

export interface QualityChangedPayload extends QualityChangedRequest {
  /** 主动调整的一方（发送方），服务端注入 */
  fromPeerId: string;
}

/* ------------------------------------------------------------------ *
 * 心跳
 * ------------------------------------------------------------------ */

export interface HeartbeatPayload {
  /** 客户端本地时间戳，用于测到信令服务器的 RTT */
  sentAt: number;
}

export interface HeartbeatAckPayload {
  sentAt: number;
  serverAt: number;
}
