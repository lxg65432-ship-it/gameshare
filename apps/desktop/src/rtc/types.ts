/**
 * P2P 层公共类型。
 *
 * 刻意把「PeerLink 需要的信令能力」抽成接口而不是直接用 SignalingClient：
 * 链路逻辑不该和 Socket.IO 绑死，单测与验收脚本可以塞假实现进去。
 */

import { roleMap, type RoleMap } from '@game-share/protocol';

/** RTCPeerConnection 的连接状态，外加 'new' 便于 UI 统一渲染 */
export type LinkState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/**
 * 三条轨按角色组织的表。
 *
 * 类型本身定义在 `packages/protocol`（`RoleMap`），这里只是把它具体化成
 * 带轨道对象的版本 —— 这样协议包不用依赖 DOM 类型（服务端也要编译它）。
 */
export type LocalTracks = RoleMap<MediaStreamTrack | null>;
export type RemoteTracks = RoleMap<MediaStreamTrack | null>;

/**
 * 三条轨全空的初始表。
 *
 * 每次调用都返回**新对象** —— 绝不能做成共享的单例常量：
 * 这个对象是可变的（挂轨就是往里写），共享一份会让所有链路互相串轨。
 */
export function emptyLocalTracks(): LocalTracks {
  return roleMap<MediaStreamTrack | null>(null);
}

/** 同 `emptyLocalTracks`，语义上用于「远端轨道表」 */
export function emptyRemoteTracks(): RemoteTracks {
  return roleMap<MediaStreamTrack | null>(null);
}

export interface PeerSignaling {
  sendOffer(targetPeerId: string, sdp: string): void;
  sendAnswer(targetPeerId: string, sdp: string): void;
  sendIceCandidate(targetPeerId: string, candidate: RTCIceCandidateInit): void;
}

/** ICE 实际走通的路径 —— M8 判断 P2P / TURN 靠它 */
export interface RouteInfo {
  /** 本地候选类型：host / srflx / prflx / relay */
  localType: string;
  remoteType: string;
  protocol: string;
  /** true 表示这条链路真的经过 TURN 中继 */
  relay: boolean;
  currentRoundTripTime: number | null;
  availableOutgoingBitrate: number | null;
  localAddress: string | null;
  remoteAddress: string | null;
}

export interface VideoInbound {
  /** 解码出的帧数 —— 判断「画面真的通了」最硬的指标 */
  framesDecoded: number;
  framesDropped: number;
  framesPerSecond: number;
  keyFramesDecoded: number;
  bytesReceived: number;
  bitrateBps: number;
  packetsLost: number;
  jitter: number;
  frameWidth: number;
  frameHeight: number;
  codec: string | null;
}

export interface VideoOutbound {
  framesEncoded: number;
  framesPerSecond: number;
  bytesSent: number;
  bitrateBps: number;
  /** 编码受限原因：none / cpu / bandwidth / other */
  qualityLimitationReason: string;
  frameWidth: number;
  frameHeight: number;
  scaleResolutionDownBy: number;
  /** 当前实际生效的码率上限，用于验证 setParameters 是否真的落下去了 */
  targetBitrate: number | null;
  codec: string | null;
}

export interface LinkStats {
  inbound: VideoInbound | null;
  outbound: VideoOutbound | null;
  route: RouteInfo | null;
}
