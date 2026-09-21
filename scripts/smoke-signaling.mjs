#!/usr/bin/env node
/**
 * M0 验收脚本。
 *
 * 不需要启动 Electron —— 直接拉起一个临时信令服务器，用 5 个
 * socket.io 客户端模拟玩家，把 M0 该验的链路全部跑一遍：
 *
 *   建房 / 进房 / 重复进房 / 房间不存在 / 房间满员
 *   信令转发 / fromPeerId 防伪造 / 跨房间拒绝
 *   房主离开后房间存活且转移 host / 成员断线清理 / 空房间回收
 *
 * 用法：npm run smoke
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 18080);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function connectClient() {
  const socket = io(BASE_URL, { transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接信令服务器超时')), 5_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function onceEvent(socket, event, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return res.json();
    } catch {
      // 服务器还没起来
    }
    await sleep(250);
  }
  throw new Error('等待信令服务器启动超时');
}

/* ------------------------------------------------------------------ *
 * 测试框架
 * ------------------------------------------------------------------ */

const results = [];
let stepIndex = 0;

async function step(name, fn) {
  stepIndex += 1;
  const label = String(stepIndex).padStart(2, '0');
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \u2713 ${label}. ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  \u2717 ${label}. ${name}`);
    console.log(`        ${err.message}`);
    if (process.env.SMOKE_VERBOSE) console.log(err.stack);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

// 用 node --import tsx <entry> 而不是 tsx CLI：
// tsx CLI 会把参数当 ESM specifier 去 import，Windows 绝对路径
// （盘符 + 反斜杠 + 中文）在这种解析下会失败。
const entry = path.join(ROOT, 'apps', 'signaling', 'src', 'index.ts');
const server = spawn(process.execPath, ['--import', 'tsx', entry], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

let sockets = [];

try {
  console.log('启动临时信令服务器 …');
  const health = await waitForHealth();
  console.log(
    `服务器就绪：协议 v${health.protocolVersion}，房间 ${health.rooms}，成员 ${health.peers}\n`,
  );

  // 9 个客户端：A 建房，B~H 加入到 8 人上限，I 用于验满员拒绝
  const NAMES = ['阿A', '阿B', '阿C', '阿D', '阿E', '阿F', '阿G', '阿H', '阿I'];
  const clients = await Promise.all(Array.from({ length: 9 }, connectClient));
  const [A, B, C, D, E, F, G, H, I] = clients;
  sockets = clients;

  let roomCode = '';

  await step('A 创建房间，返回合法 6 位房间码，自己为房主', async () => {
    const res = await emitAck(A, 'create-room', { nickname: '阿A' });
    assert.equal(res.ok, true, `建房间失败：${JSON.stringify(res)}`);
    roomCode = res.data.roomCode;
    assert.match(roomCode, /^[A-HJ-NP-Z2-9]{6}$/, `房间码格式异常：${roomCode}`);
    assert.equal(res.data.peers.length, 0);
    assert.equal(res.data.self.isHost, true);
  });

  await step('B 加入房间，拿到 A 作为已有成员，A 收到 peer-joined 广播', async () => {
    const peerJoinedAtA = onceEvent(A, 'peer-joined');
    const res = await emitAck(B, 'join-room', { roomCode, nickname: '阿B' });
    assert.equal(res.ok, true, `加入失败：${JSON.stringify(res)}`);
    assert.equal(res.data.peers.length, 1);
    assert.equal(res.data.peers[0].peerId, A.id);
    assert.equal(res.data.self.isHost, false);

    const joined = await peerJoinedAtA;
    assert.equal(joined.peer.peerId, B.id);
    assert.equal(joined.peer.nickname, '阿B');
  });

  await step('同一连接重复加入被拒（ALREADY_IN_ROOM）', async () => {
    const res = await emitAck(B, 'join-room', { roomCode, nickname: '阿B' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ALREADY_IN_ROOM');
  });

  await step('不存在的房间码被拒（ROOM_NOT_FOUND）', async () => {
    const res = await emitAck(C, 'join-room', { roomCode: 'ZZZZZZ', nickname: '阿C' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ROOM_NOT_FOUND');
  });

  await step('房间码格式非法时被拒（ROOM_NOT_FOUND）', async () => {
    const res = await emitAck(C, 'join-room', { roomCode: 'ABC', nickname: '阿C' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ROOM_NOT_FOUND');
  });

  await step('A 定向转发 offer，B 收到的 fromPeerId 由服务端注入', async () => {
    const got = onceEvent(B, 'webrtc-offer');
    A.emit('webrtc-offer', {
      targetPeerId: B.id,
      sdp: 'v=0 fake-sdp',
      sdpType: 'offer',
      fromPeerId: 'spoofed-peer-id',
    });
    const env = await got;
    assert.equal(env.fromPeerId, A.id, 'fromPeerId 被客户端伪造成功，存在安全缺陷');
    assert.equal(env.payload.sdp, 'v=0 fake-sdp');
  });

  await step('向非本房间成员发信令被拒（TARGET_NOT_FOUND）', async () => {
    const gotError = onceEvent(A, 'protocol-error');
    A.emit('webrtc-offer', { targetPeerId: E.id, sdp: 'v=0 x', sdpType: 'offer' });
    const err = await gotError;
    assert.equal(err.code, 'TARGET_NOT_FOUND');
  });

  await step('ICE candidate 定向转发正常', async () => {
    const got = onceEvent(A, 'ice-candidate');
    B.emit('ice-candidate', {
      targetPeerId: A.id,
      candidate: 'candidate:1 1 udp 2130706431 192.168.1.5 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    const env = await got;
    assert.equal(env.fromPeerId, B.id);
    assert.equal(env.payload.sdpMid, '0');
    assert.equal(env.payload.sdpMLineIndex, 0);
  });

  await step('C 加入后房间 3 人', async () => {
    const res = await emitAck(C, 'join-room', { roomCode, nickname: '阿C' });
    assert.equal(res.ok, true);
    assert.equal(res.data.peers.length, 2);
  });

  await step('D~H 依次加入，房间到达 8 人上限', async () => {
    // D 是第 4 人（已有 3 人），H 是第 8 人（已有 7 人）
    const rest = [D, E, F, G, H];
    for (let i = 0; i < rest.length; i++) {
      const res = await emitAck(rest[i], 'join-room', { roomCode, nickname: NAMES[3 + i] });
      assert.equal(res.ok, true, `第 ${4 + i} 人加入失败：${JSON.stringify(res)}`);
      assert.equal(res.data.peers.length, 3 + i);
    }
  });

  await step('I 加入被拒（ROOM_FULL，上限 8 人）', async () => {
    const res = await emitAck(I, 'join-room', { roomCode, nickname: '阿I' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ROOM_FULL');
  });

  await step('A（房主）离开：房间不销毁，房主移交给最早加入的 B', async () => {
    const peerLeftAtB = onceEvent(B, 'peer-left');
    const peerUpdatedAtB = onceEvent(B, 'peer-updated');

    const ack = await emitAck(A, 'leave-room', {});
    assert.equal(ack.ok, true);

    const left = await peerLeftAtB;
    assert.equal(left.peerId, A.id);

    const updated = await peerUpdatedAtB;
    assert.equal(updated.peer.peerId, B.id);
    assert.equal(updated.peer.isHost, true);
  });

  await step('A 离开后房间仍存活：C 仍能向 B 发信令', async () => {
    const got = onceEvent(B, 'webrtc-offer');
    C.emit('webrtc-offer', { targetPeerId: B.id, sdp: 'still-alive', sdpType: 'offer' });
    const env = await got;
    assert.equal(env.fromPeerId, C.id);
    assert.equal(env.payload.sdp, 'still-alive');
  });

  await step('停止共享广播正确', async () => {
    const got = onceEvent(C, 'share-stopped');
    B.emit('share-started', { quality: 'FOCUS' });
    await sleep(150);
    B.emit('share-stopped', { reason: 'user' });
    const state = await got;
    assert.equal(state.peerId, B.id);
    assert.equal(state.sharing, false);
  });

  await step('全体离开后空房间被回收', async () => {
    // A（房主）之前已离开；B~H 七人逐一退出
    for (const s of [B, C, D, E, F, G, H]) await emitAck(s, 'leave-room', {});
    await sleep(250);
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    assert.equal(body.rooms, 0, `期望 0 个房间，实际 ${body.rooms}`);
    assert.equal(body.peers, 0, `期望 0 个成员，实际 ${body.peers}`);
  });

  await step('异常断线（未主动 leave-room）也会清理成员并广播', async () => {
    const created = await emitAck(A, 'create-room', { nickname: '阿A' });
    const code2 = created.data.roomCode;
    const joined = await emitAck(B, 'join-room', { roomCode: code2, nickname: '阿B' });
    assert.equal(joined.ok, true);

    // socket.id 在 disconnect() 之后会被 Socket.IO 置为 undefined，
    // 必须在断开前先把 id 取出来。
    const aId = A.id;
    const peerLeftAtB = onceEvent(B, 'peer-left');
    A.disconnect();
    const left = await peerLeftAtB;
    assert.equal(left.peerId, aId);
    assert.match(left.reason, /disconnect/);
  });

  await step('心跳 ack 返回服务端时间戳', async () => {
    const sentAt = Date.now();
    const res = await emitAck(B, 'heartbeat', { sentAt });
    assert.equal(res.ok, true);
    assert.equal(res.data.sentAt, sentAt);
    assert.ok(res.data.serverAt >= sentAt - 1_000, '服务端时间戳异常');
  });
} catch (err) {
  console.error('\n验收脚本执行中断：', err);
} finally {
  for (const socket of sockets) {
    try {
      socket.disconnect();
    } catch {
      /* 忽略 */
    }
  }
  server.kill();
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(56)}`);
console.log(`M0 验收：${results.length - failed.length} / ${results.length} 项通过`);

if (failed.length > 0) {
  console.log('\n未通过：');
  for (const f of failed) console.log(`  · ${f.name}\n    ${f.err?.message ?? ''}`);
}

process.exit(failed.length === 0 ? 0 : 1);
