/**
 * 信令地址的可用性判据（不只是「连不上 / 连上了」二分）。
 *
 * ## 为什么需要单独一层
 *
 * Socket.IO 的 `connect_error` 原文是 `xhr poll error` / `websocket error`，
 * 运输层术语，对用户没有任何信息量。更糟的是**两种完全不同的病因共用同一句话**：
 *
 * | 病因 | 该做什么 |
 * | --- | --- |
 * | 服务器没起 / 防火墙拦了 | 对方开服务、放行端口 |
 * | **对方隧道重启了，地址已经失效** | **让对方重新开隧道、给你新的邀请** |
 *
 * 第二种是 quick tunnel 的固有性质：**每次重启都换一个 `trycloudflare.com`
 * 随机地址**。之前发出的邀请全部作废，而用户看到的是同一个 `xhr poll error`，
 * 只能自己去猜、去重启、去改地址。本模块负责把这个区分做出来。
 *
 * ## 判据：主动探测，看对面是谁
 *
 * 不靠错误码、不靠耗时，靠**那个地址现在返回的是不是本应用**：
 *
 * - 拿到本应用的 `/health` JSON ⇒ 服务在，地址是好的（问题在别处）
 * - 拿到 Cloudflare 的错误页 ⇒ **隧道没了**（地址已失效）
 * - 什么都没有（超时 / 拒绝连接）⇒ 服务没起或被拦
 *
 * 关键在于「认得出对面是谁」：`trycloudflare.com` 在隧道不存在时返回的是
 * Cloudflare 自己的错误页（HTML 或 Cloudflare 状态的 JSON），
 * 里面**绝不会出现本应用的服务标识**，这比任何超时阈值都可靠。
 *
 * 纯函数、不碰网络 —— 网络那一层在 `probeSignalingAddress`（渲染层）。
 * 这样判据能被验收脚本直接测，且不必真起一个隧道。
 */

/** 本应用 `/health` 响应里的服务标识。与 signaling-server.ts 的字段必须一致。 */
export const SIGNALING_SERVICE_ID = 'game-share-signaling';

/** Cloudflare 隧道地址的域名形态。判「这是不是个隧道地址」用 */
const TUNNEL_HOST_PATTERN = /^[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/i;

/** Cloudflare 隧道不存在时错误页/响应里出现的标识 */
const CLOUDFLARE_ERROR_PATTERN = /cloudflare|error\s*code|1033|1016|530/i;

/** 判别结果 */
export type ServerReachability =
  /** 确认是对面本应用的服务在应答 */
  | 'alive'
  /** 确认是 Cloudflare 隧道的错误页 ⇒ 地址已失效，该找对方要新邀请 */
  | 'tunnel-gone'
  /** 什么都没应答（超时 / 拒绝连接）⇒ 服务没起或被拦 */
  | 'unreachable'
  /** 探测本身没做或失败了，不能下结论 */
  | 'unknown';

/**
 * 这个地址看起来是 Cloudflare quick tunnel 吗。
 *
 * 只看**主机名**，不解析 URL —— 这些地址是 `https://xxx.trycloudflare.com`
 * 形式的标准 URL，`new URL` 能用，但入参也可能带路径或缺协议
 * （用户手输时什么形状都有），宽松一点更省事。
 */
export function looksLikeTunnelUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return false;
  // 补协议再解析：`trycloudflare.com` 不带协议时 `new URL` 会当成路径
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const { hostname, port, protocol } = new URL(withProtocol);
    if (port !== '') return false;
    return protocol === 'https:' || protocol === 'http:'
      ? TUNNEL_HOST_PATTERN.test(hostname)
      : false;
  } catch {
    return false;
  }
}

/** 拿 URL 的主机名，失败返回空串 */
export function hostOf(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).hostname;
  } catch {
    return '';
  }
}

/**
 * 从一次 HTTP 探测的原始结果判「对面是谁」。
 *
 * 纯函数：只吃「状态码 + 响应体」，不做任何 I/O。
 * 这样验收脚本能穷举各种响应形状，不必真的架隧道。
 *
 * @param status HTTP 状态码；`0` 表示压根没应答（网络层失败）
 * @param body 响应体文本。可能是 JSON，也可能是 HTML 错误页
 */
export function classifyProbe(status: number, body: string): ServerReachability {
  const text = (body ?? '').trim();

  // 压根没应答。**别把它算成「隧道没了」** —— 那会让用户去要新邀请，
  // 而真实病因往往是对方服务没起。这两者的处置完全不同。
  if (status === 0) return 'unreachable';

  // 我们的服务在应答。认标识而不是认 200：有人把别的服务挂在同一个地址上
  // 也可能回 200，而那同样连不上。
  if (text.includes(SIGNALING_SERVICE_ID)) return 'alive';

  // 是 Cloudflare 的错误页 ⇒ 隧道不存在
  if (CLOUDFLARE_ERROR_PATTERN.test(text)) return 'tunnel-gone';

  // 其余（反向代理的 502/503、自定义 404 页…）不能确定是谁，
  // 宁可说「不确定」也别给错处方 —— 给错处方比不给更糟。
  return 'unknown';
}

/**
 * 把判别结果翻译成「照着做就能修好」的一句话。
 *
 * 为什么要按「谁是主机」分岔：同一个失败，主机和客人的动作**完全相反**
 * —— 主机去开隧道，客人只能请对方重发邀请。把这段说反的话，
 * 客人会去反复重启自己的客户端（完全无效），或者更糟：去折腾自己根本没开的隧道。
 */
export function describeReachability(
  reach: ServerReachability,
  url: string,
  opts: { isOwnTunnel: boolean },
): string {
  const host = hostOf(url) || url;

  switch (reach) {
    case 'alive':
      // 地址是好的但仍然连不上 —— 问题在信令协议层，不是地址
      return (
        `地址是好的（${host} 上的信令服务有应答），但连接仍失败。` +
        `这说明不是地址失效：确认对方的信令服务开关是开的、房间码没过期。`
      );

    case 'tunnel-gone':
      if (opts.isOwnTunnel) {
        return (
          `隧道地址 ${host} 已经失效了。Cloudflare 的临时隧道每次重启都会换一个新地址，` +
          `之前发出的邀请全部作废。打开左侧「异地访问」重新开隧道，然后把**新地址**的邀请重新发给对方。`
        );
      }
      return (
        `对方给的隧道地址 ${host} 已经失效了。Cloudflare 的临时隧道每次重启都会换一个新地址，` +
        `他重启之后你手上这个就作废了。**请让他重新开一次隧道，然后把新的邀请发给你** —— ` +
        `你自己这边不用改任何设置，重试多少次都没用。`
      );

    case 'unreachable':
      if (opts.isOwnTunnel) {
        return (
          `连不上 ${host}。隧道开关可能已经关掉了，或者 cloudflared 没在跑。` +
          `打开左侧「异地访问」开关重建隧道即可。`
        );
      }
      return (
        `连不上 ${host}，对方那边没有应答。可能是他的信令服务没开、地址抄错了，` +
        `或者防火墙拦了。**如果你确定这个地址是刚拿到的**，那就请他确认隧道还开着。`
      );

    case 'unknown':
    default:
      // 拿不准时**明说拿不准**，并给一条覆盖面最广的下一步。
      // 编一个确定的结论比承认不确定危险得多 —— 用户会照着错的下一步去操作。
      return (
        `${host} 有应答，但不确定是不是本应用的信令服务（` +
        `正常应该返回含 "${SIGNALING_SERVICE_ID}" 的信息）。` +
        `请确认地址没抄错、对方用的是 GameShare 的信令地址。`
      );
  }
}

/**
 * 合并原有错误描述与探测结果。
 *
 * 为什么要**合并**而不是替换：`connect_error` 的原文里有时带着有用的信息
 * （超时 vs 拒绝连接，见 `describeConnectError`）。直接丢掉它会让排障少一条线索。
 */
export function mergeWithTransportError(
  transportHint: string,
  reach: ServerReachability,
  url: string,
  opts: { isOwnTunnel: boolean },
): string {
  if (reach === 'unknown') return transportHint;
  const diagnosed = describeReachability(reach, url, opts);
  return `${diagnosed}\n${transportHint}`;
}
