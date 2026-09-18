import { randomInt } from 'node:crypto';

import {
  DEFAULT_QUALITY,
  MAX_PEERS_PER_ROOM,
  ProtocolErrorCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  sanitizeNickname,
  type PeerInfo,
  type QualityLevel,
} from '@game-share/protocol';

export interface Room {
  code: string;
  hostPeerId: string;
  createdAt: number;
  peers: Map<string, PeerInfo>;
}

export interface RoomError {
  code: ProtocolErrorCode;
  message: string;
}

export interface SessionResult {
  roomCode: string;
  self: PeerInfo;
  /** 房间内除自己以外的成员 */
  others: PeerInfo[];
}

export type RoomResult =
  | { ok: true; session: SessionResult }
  | { ok: false; error: RoomError };

export interface LeaveOutcome {
  roomCode: string;
  peerId: string;
  /** 该成员离开后房间里剩下的人 */
  others: PeerInfo[];
  /** 房主发生了转移时为新 host 的 id */
  newHostPeerId?: string;
  /** 房间已空并被回收 */
  roomClosed: boolean;
}

const MAX_ROOM_CODE_ATTEMPTS = 200;

/**
 * 内存态房间管理。第一版明确不引入数据库（规格文档第 12 节），
 * 服务端重启后房间全部丢失 —— 这是 V0.1 可接受的取舍。
 */
export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  /** peerId -> roomCode 反查表，避免每次遍历所有房间 */
  readonly #peerRoom = new Map<string, string>();

  get roomCount(): number {
    return this.#rooms.size;
  }

  get peerCount(): number {
    return this.#peerRoom.size;
  }

  #generateRoomCode(): string {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.#rooms.has(code)) return code;
    }
    throw new Error(`连续 ${MAX_ROOM_CODE_ATTEMPTS} 次未能生成唯一房间码，请检查房间数量`);
  }

  #createPeerInfo(peerId: string, rawNickname: unknown, isHost: boolean): PeerInfo {
    return {
      peerId,
      nickname: sanitizeNickname(rawNickname, `玩家${peerId.slice(0, 4)}`),
      isHost,
      joinedAt: Date.now(),
      sharing: false,
      shareQuality: DEFAULT_QUALITY,
    };
  }

  createRoom(peerId: string, rawNickname: unknown): RoomResult {
    if (this.#peerRoom.has(peerId)) {
      return {
        ok: false,
        error: {
          code: ProtocolErrorCode.AlreadyInRoom,
          message: '当前连接已在房间中，请先离开',
        },
      };
    }

    const code = this.#generateRoomCode();
    const self = this.#createPeerInfo(peerId, rawNickname, true);
    const room: Room = {
      code,
      hostPeerId: peerId,
      createdAt: Date.now(),
      peers: new Map([[peerId, self]]),
    };

    this.#rooms.set(code, room);
    this.#peerRoom.set(peerId, code);

    return { ok: true, session: { roomCode: code, self, others: [] } };
  }

  joinRoom(rawCode: string, peerId: string, rawNickname: unknown): RoomResult {
    if (this.#peerRoom.has(peerId)) {
      return {
        ok: false,
        error: {
          code: ProtocolErrorCode.AlreadyInRoom,
          message: '当前连接已在房间中，请先离开',
        },
      };
    }

    const code = normalizeRoomCode(String(rawCode ?? ''));
    if (!isValidRoomCode(code)) {
      return {
        ok: false,
        error: {
          code: ProtocolErrorCode.RoomNotFound,
          message: `房间码格式不正确，应为 ${ROOM_CODE_LENGTH} 位字符`,
        },
      };
    }

    const room = this.#rooms.get(code);
    if (!room) {
      return {
        ok: false,
        error: { code: ProtocolErrorCode.RoomNotFound, message: `房间 ${code} 不存在` },
      };
    }

    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      return {
        ok: false,
        error: {
          code: ProtocolErrorCode.RoomFull,
          message: `房间已满（上限 ${MAX_PEERS_PER_ROOM} 人）`,
        },
      };
    }

    const others = [...room.peers.values()];
    const self = this.#createPeerInfo(peerId, rawNickname, false);
    room.peers.set(peerId, self);
    this.#peerRoom.set(peerId, code);

    return { ok: true, session: { roomCode: code, self, others } };
  }

  /**
   * 成员离开。房主离开时把 host 移交给最早加入的剩余成员，
   * 房间本身不销毁 —— 对应规格文档「房主退出不导致整个房间立即失效」。
   */
  leaveRoom(peerId: string): LeaveOutcome | null {
    const code = this.#peerRoom.get(peerId);
    if (!code) return null;

    const room = this.#rooms.get(code);
    this.#peerRoom.delete(peerId);
    if (!room) return null;

    room.peers.delete(peerId);

    if (room.peers.size === 0) {
      this.#rooms.delete(code);
      return {
        roomCode: code,
        peerId,
        others: [],
        roomClosed: true,
      };
    }

    let newHostPeerId: string | undefined;
    if (room.hostPeerId === peerId || !room.peers.has(room.hostPeerId)) {
      const successor = [...room.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0]!;
      room.hostPeerId = successor.peerId;
      newHostPeerId = successor.peerId;
      for (const peer of room.peers.values()) {
        peer.isHost = peer.peerId === successor.peerId;
      }
    }

    return {
      roomCode: code,
      peerId,
      others: [...room.peers.values()],
      newHostPeerId,
      roomClosed: false,
    };
  }

  /** 更新成员的共享状态，返回更新后的 PeerInfo（不在房间则返回 null） */
  setSharing(peerId: string, sharing: boolean, quality?: QualityLevel): PeerInfo | null {
    const room = this.#getRoomOf(peerId);
    if (!room) return null;
    const peer = room.peers.get(peerId);
    if (!peer) return null;
    peer.sharing = sharing;
    if (quality) peer.shareQuality = quality;
    return peer;
  }

  /** 取同房间其他成员，用于校验信令转发目标是否合法 */
  getPeers(peerId: string): PeerInfo[] {
    const room = this.#getRoomOf(peerId);
    if (!room) return [];
    return [...room.peers.values()];
  }

  getRoomCode(peerId: string): string | undefined {
    return this.#peerRoom.get(peerId);
  }

  getRoom(code: string): Room | undefined {
    return this.#rooms.get(normalizeRoomCode(code));
  }

  /** 判断 source 与 target 是否同处一个房间 */
  isSameRoom(a: string, b: string): boolean {
    const roomA = this.#peerRoom.get(a);
    return roomA !== undefined && roomA === this.#peerRoom.get(b);
  }

  #getRoomOf(peerId: string): Room | undefined {
    const code = this.#peerRoom.get(peerId);
    return code ? this.#rooms.get(code) : undefined;
  }
}
