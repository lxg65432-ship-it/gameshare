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
 * 判据是「Chromium 里能否真的拿到 srflx 候选」——不是看有没有报错。
 *
 * ⚠️ 2026-09-22 重要修正 —— 2026-09-16 那次实测是**在开着 VPN 的机器上做的，
 * 结论整体作废**。当时记下的「Google 节点实测可用，与『国内一定不可达』的成见
 * 不符」正是被 VPN 骗了：挂着 VPN 当然能解析 Google，而**普通国内用户连不上
 * google.com**，所以那个节点对目标用户是必然失效的。反向也成立 —— VPN 的全局
 * 路由与 DNS 劫持会让**国内节点**误报失败，于是测出「国内全挂、只有 Google 通」
 * 这种与真实用户环境完全相反的假象（2026-09-22 复跑冒烟时就是这么显示的）。
 * ⇒ **测 STUN 必须在关掉 VPN 的目标网络环境下做**；带 VPN 的机器测出来等于没测。
 *
 * ⚠️ 开 VPN 还有第二个副作用，与 DNS 无关：STUN 探到的 srflx 是**VPN 出口地址**，
 * 不是你真实的公网映射。对端往那个地址打洞可能不通，或者被迫绕 VPN 中转、
 * 延迟抬高。⇒ 联调 P2P 前先关 VPN。（Parsec 官方文档同样建议避免 VPN。）
 *
 * 三条值得记住的结论：
 *   · `stun.qq.com` 拿不到 srflx，已移除。列表里放不可达的节点不只是没用，
 *     还会拖慢 ICE 收集：每个失败目标都要等一轮超时。
 *   · `code=701` 的原文是「STUN host lookup received error」，是 DNS 解析失败，
 *     不是服务不可达。同一节点可能一边报 701 一边成功给出 srflx，
 *     所以不能拿「有没有报错」当判据。
 *   · **Google 节点保留**（2026-09-22 曾短暂移除，2026-09-23 加回）：本项目面向
 *     **全球用户**，海外网络下 Google 的 anycast 是最可靠的一档。
 *     代价是国内用户侧它会**稳定超时**（域名被污染），要多拖一轮 ICE 收集。
 *     这是「全球可用性 / 收集速度」的取舍 —— **别再按单机实测删它**：
 *     一台机器的结论只反映那台机器（2026-09-22 就是这么误删的），
 *     删掉等于砍了海外用户的主力节点。
 *
 * 增删节点前先跑 `npm run check:stun`，**并且关掉 VPN**，别凭印象改。
 * M8 接入自建 coturn 后，TURN 配置会从这里独立出来。
 */
export const DEFAULT_STUN_SERVERS: readonly string[] = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.l.google.com:19302',
];

/**
 * STUN 候选池 —— **只给 `npm run check:stun` 体检用，不要拿来当运行时列表**。
 *
 * 为什么不直接全部塞进 `DEFAULT_STUN_SERVERS`：ICE 会**同时尝试列表里的每一个**，
 * 而收集耗时由**最慢的那个**决定（MDN 原话：every server in the list will be
 * contacted and tried out；并明确建议避免列太多 URL）。所以每多一个死节点，
 * **每一条链路**都要陪它多等一轮超时 —— 放进运行时的只能是通过体检的少数几个。
 *
 * 来源：`heiher/natmap` issue #18 的社区维护清单（不是本项目实测结果）。
 * 加进来的地址**一律视为「待验证」**，只有 `check:stun` 拿到 srflx 才有资格进默认列表。
 *
 * 分类标注的意义：国内 IDC 的节点在无 VPN 环境下才有意义；国外那批反过来，
 * 通常只在**海外网络或挂 VPN** 时才通（VPN 测出来的结论对普通用户是反的，见上）。
 */
export const STUN_CANDIDATES: readonly string[] = [
  // —— 国内 IDC（无 VPN 环境下的优先复测对象）
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.douyucdn.cn:18000',
  'stun:stun.cdnbye.com:3478',
  'stun:stun.qq.com:3478',
  // —— 国内云厂商（TCP，声明与 STUN 协议兼容）
  'stun:turn.cloud-rtc.com:80',
  // —— 国外：无 VPN 一般不通，留着只为覆盖「有海外网络」的场景
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.nextcloud.com:3478',
  'stun:stun.radiojar.com:3478',
  'stun:stun.voipgate.com:3478',
  'stun:stun.sipnet.com:3478',
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
  /**
   * 凭证类型。M8 之前没有 TURN 所以没这个字段。
   *
   * Chromium 在有 `username` 时默认按 `password` 处理，但**显式写出来**更稳：
   * 一旦被误设成 `oauth`，失败表现是建链路时报「认证失败」，
   * 而那句话完全看不出是 `credentialType` 写错了。
   */
  credentialType?: 'password';
}

/**
 * 生成 RTCPeerConnection 的 iceServers 配置。
 *
 * 刻意用**选项对象**而不是位置参数：M8 之前它只有 STUN 一个可选来源，
 * 于是签名是 `(stunServers?, turn?)`。加 TURN 之后调用点写成
 * `buildIceServers(undefined, turn)` —— 那个 `undefined` 得翻回定义才看得懂在干嘛。
 * 位置参数在这里纯属省不了几个字符。
 *
 * `options.turn` 由信令服务下发的临时凭证（M8）。**没配就传 undefined** ——
 * 链路退回纯 STUN + host candidate，这正是 M8 之前的行为。
 *
 * ⚠️ TURN 的 `urls` 是**数组**（Cloudflare 会给 udp/tcp/tls 共四条路）。
 * 别图省事只取第一条：企业网络与校园网经常只放行 443/tcp，
 * 只留 3478/udp 等于在那些环境里白配 TURN。
 */
export function buildIceServers(options: {
  /** 覆盖默认 STUN 列表（`check:stun` 体检用）。不传用 DEFAULT_STUN_SERVERS。 */
  stunServers?: readonly string[];
  turn?: IceServerConfig;
} = {}): IceServerConfig[] {
  const stunServers = options.stunServers ?? DEFAULT_STUN_SERVERS;
  const servers: IceServerConfig[] = [];
  if (stunServers.length > 0) {
    servers.push({ urls: [...stunServers] });
  }
  const turn = options.turn;
  if (turn) {
    servers.push({
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential,
      ...(turn.credentialType === undefined ? {} : { credentialType: turn.credentialType }),
    });
  }
  return servers;
}
