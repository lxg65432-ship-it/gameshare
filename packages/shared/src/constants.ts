/** 信令服务器默认监听端口 */
export const DEFAULT_SIGNALING_PORT = 8080;

/** 客户端默认连接地址（开发期本机） */
export const DEFAULT_SIGNALING_URL = `http://localhost:${DEFAULT_SIGNALING_PORT}`;

/** 应用层心跳间隔，用于 UI 展示到信令服务器的 RTT */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** 超过这个时间没收到心跳回应判定信令断连 */
export const HEARTBEAT_TIMEOUT_MS = 15_000;

/**
 * 公共 STUN 服务器。
 *
 * 这份列表是**实测结果**，不是照抄网上的常见清单。
 * 2026-09-16 在开发机（中国移动宽带）用 `npm run check:stun` 逐个验证过，
 * 判据是「Chromium 里能否真的拿到 srflx 候选」——不是看有没有报错。
 *
 * 三条值得记住的结论：
 *   · `stun.qq.com` 拿不到 srflx，已移除。列表里放不可达的节点不只是没用，
 *     还会拖慢 ICE 收集：每个失败目标都要等一轮超时。
 *   · `code=701` 的原文是「STUN host lookup received error」，是 DNS 解析失败，
 *     不是服务不可达。同一节点可能一边报 701 一边成功给出 srflx，
 *     所以不能拿「有没有报错」当判据。
 *   · Google 节点本次实测可用（端口是 19302，不是 3478），
 *     与「国内一定不可达」的成见不符，所以保留。
 *
 * 增删节点前先跑 `npm run check:stun`，别凭印象改。
 * M8 接入自建 coturn 后，TURN 配置会从这里独立出来。
 */
export const DEFAULT_STUN_SERVERS: readonly string[] = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.l.google.com:19302',
];

/**
 * ICE 服务器配置。
 *
 * 刻意不用 DOM 的 RTCIceServer 类型：本包同时被信令服务端（无 DOM lib）
 * 和渲染进程引用，依赖 DOM 类型会让服务端编译失败。
 * 这个结构是 RTCIceServer 的子集，可直接传给 RTCPeerConnection。
 */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * 生成 RTCPeerConnection 的 iceServers 配置。
 * M8 之前 turn 传 undefined，链路完全依赖 STUN + host candidate。
 */
export function buildIceServers(
  stunServers: readonly string[] = DEFAULT_STUN_SERVERS,
  turn?: IceServerConfig,
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (stunServers.length > 0) {
    servers.push({ urls: [...stunServers] });
  }
  if (turn) {
    servers.push({
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}
