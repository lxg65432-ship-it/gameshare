import type { QualityLevel } from './quality';

/** 规格文档第 2 节：房间最多 4 人 */
export const MAX_PEERS_PER_ROOM = 4;

export const ROOM_CODE_LENGTH = 6;

/** 已剔除易混字符 I / O / 0 / 1，避免口头报房间码时读错 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const MAX_NICKNAME_LENGTH = 16;

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  const normalized = normalizeRoomCode(code);
  if (normalized.length !== ROOM_CODE_LENGTH) return false;
  return [...normalized].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

export interface PeerInfo {
  /** 即 Socket.IO 的 socket.id，服务端分配 */
  peerId: string;
  nickname: string;
  isHost: boolean;
  joinedAt: number;
  /** 是否正在共享画面 */
  sharing: boolean;
  /** 该成员对外推送的默认画质 */
  shareQuality: QualityLevel;
}

export interface RoomSnapshot {
  roomCode: string;
  hostPeerId: string;
  peers: PeerInfo[];
  createdAt: number;
}

/**
 * 清洗昵称：去首尾空白、截断长度、兜底默认值。
 * 服务端必须调用，不能信任客户端传上来的字符串。
 */
export function sanitizeNickname(raw: unknown, fallback = '玩家'): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return fallback;
  return [...trimmed].slice(0, MAX_NICKNAME_LENGTH).join('');
}
