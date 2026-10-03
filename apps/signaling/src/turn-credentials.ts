/**
 * Cloudflare Realtime TURN 的临时凭证代理。
 *
 * ## 为什么凭证必须在服务端签发
 *
 * TURN 的 key secret 是**长期凭据**，临时凭证（username/credential）才是发给客户端的。
 * 官方 gotchas 的安全清单第一条就是「Credentials generated server-side only」。
 * 客户端拿到 secret 就等于把账号的计费额度交出去了 —— 而本项目的信令是
 * **无鉴权**的（见 CONVENTIONS「信令无鉴权无限流」），任何能连上信令的人
 * 都能从客户端内存里把 secret 读出来。所以 secret 只允许出现在信令服务端的环境变量里。
 *
 * ## 这不是「本地 HMAC 签发」
 *
 * 直觉上会以为凭证是 `base64(HMAC-SHA1(secret, username))` 本地算出来的
 * （那是 coturn / TURN REST API 的老做法）。**Cloudflare 不是这样**：
 * 它要求把签发请求发到 `rtc.live.cloudflare.com`，由它返回。
 * 本地算出来的凭证一律无效。已核对 Cloudflare 官方 skills 仓库
 * `skills/cloudflare/references/turn/api.md`。
 *
 * ## 为什么这里不做成本兜底
 *
 * 官方 FAQ 明确：TURN **与 Realtime SFU / Stream 之间**的流量不计费，
 * 但**发往 TURN 客户端的出站流量计费**（$0.05/GB，1000 GB 免费 tier）。
 * 本项目走 P2P Mesh，**不用 Cloudflare SFU**，所以 relay 流量是要计费的。
 * 免费 tier 够朋友间用（见 ARCHITECTURE §6.5 的估算），但**不能当成无限量**，
 * 因此不做「随便发」——凭证有 TTL，且走缓存。
 */

import { createLogger, type Logger } from '@game-share/shared';
import type { IceServerConfig } from '@game-share/shared';

/** Cloudflare 的凭证签发端点。与管理面（api.cloudflare.com）不是同一个 host。 */
const CREDENTIALS_URL =
  'https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate';

/**
 * 凭证有效期（秒）。
 *
 * 上限是 172800（48 小时），超了 API 直接拒。本项目取 1 小时：
 * 一场游戏局足够长，而 TTL 越短越不容易「凭证过期但链路还在」被误判成网络故障。
 * 注意：**凭证过期不会立刻断链**，只在需要新分配（ICE 重开）时才失败 ——
 * 那种情况下 §6.3 的自愈会重试，届时缓存里的凭证也快到期了。
 */
export const TURN_CREDENTIAL_TTL_SEC = 3_600;

/** 提前多久判定缓存失效。留够一次网络往返 + 签发耗时。 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** 签发请求超时。慢于这个值就直接放弃，别让建房卡住。 */
const REQUEST_TIMEOUT_MS = 8_000;

export interface TurnCredentialOptions {
  /** Cloudflare TURN key 的 id（创建时返回的 uid） */
  keyId: string;
  /** Cloudflare TURN key 的 secret。**只在服务端**，绝不进客户端。 */
  keySecret: string;
  ttlSec?: number;
  logger?: Logger;
  /** 注入用。生产不传。 */
  fetchImpl?: typeof fetch;
}

export interface TurnCredentials {
  iceServers: IceServerConfig[];
  /** 这批凭证的到期时刻（epoch ms），供缓存判断 */
  expiresAt: number;
}

/**
 * 过滤掉 Chromium 禁用的端口。
 *
 * ⚠️ **官方给的那句 `urls.filter(u => !u.includes(':53'))` 是错的** ——
 * 它会把 `:5349`（TURN over TLS，绕防火墙的关键一条路）一起干掉。
 * 正确做法是**解析出端口再比大小**，不能拿子串去 `includes`。
 *
 * 端口 53 被禁的原理：Chromium 把它当 DNS 保留端口（防 DNS 泄漏）。
 * 但本项目**仍要过滤**：Electron 走的是同一个 Chromium 网络栈，
 * 官方那篇 gotchas 明写「browser clients」要滤，Electron 渲染层同理。
 * 代价只是少一条候选路，滤错的后果却是丢掉 TLS 443/5349 那两条。
 */
export function filterChromiumBlockedUrls(urls: readonly string[]): string[] {
  return urls.filter((url) => {
    // 形如 `turn:host:port?transport=udp`。**不能用 new URL 解析** ——
    // 标准 URL 会把 `turn:` 当成协议名，解析出来的协议是空的。
    const afterScheme = url.slice(url.indexOf(':') + 1);
    const queryAt = afterScheme.indexOf('?');
    const hostPort = queryAt < 0 ? afterScheme : afterScheme.slice(0, queryAt);
    const colonAt = hostPort.lastIndexOf(':');
    if (colonAt < 0) return true;
    const port = Number.parseInt(hostPort.slice(colonAt + 1), 10);
    // 解析不出端口 ⇒ 保留（宁可多试一条，不可静默丢）
    if (!Number.isFinite(port)) return true;
    return port !== 53;
  });
}

/**
 * 校验 Cloudflare 返回的 iceServers 形状。
 *
 * **为什么要严格校验**：响应是从**外部服务**收来的 JSON，
 * 字段缺失/类型错时如果直接透传，最终表现为 Chromium 在建链路时才报错，
 * 而错误信息通常是「认证失败」这种看不出源头的话。宁可在这里抛。
 */
function parseResponse(raw: unknown): TurnCredentials {
  const root = raw as { iceServers?: unknown; ttl?: unknown };
  const servers = root?.iceServers;
  if (typeof servers !== 'object' || servers === null) {
    throw new Error('响应里没有 iceServers');
  }
  const { urls, username, credential } = servers as Record<string, unknown>;

  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('响应里没有 username');
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new Error('响应里没有 credential');
  }
  const urlList = (Array.isArray(urls) ? urls : [urls]).filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (urlList.length === 0) {
    throw new Error('响应里 urls 为空');
  }

  const usable = filterChromiumBlockedUrls(urlList);
  if (usable.length === 0) {
    throw new Error(`过滤后没有可用地址：${urlList.join(' ')}`);
  }

  return {
    iceServers: [{ urls: usable, username, credential, credentialType: 'password' }],
    // 用本地时间推算，不信响应里的 ttl（它可能没给，或给了个别的意思）
    expiresAt: Date.now() + (TURN_CREDENTIAL_TTL_SEC + REFRESH_MARGIN_MS) * 1000,
  };
}

/**
 * TURN 凭证的缓存代理。
 *
 * 为什么要有缓存：签发是一次**跨网 HTTPS 往返**（到 Cloudflare），
 * 而建房/进房是用户感知延迟最敏感的地方。每来一个人就打一次 Cloudflare
 * 既慢又平白消耗它的配额。
 *
 * 用 `#inflight` 合并并发请求：4 个人同时进房时只签发一次。
 */
export class TurnCredentialProvider {
  readonly #keyId: string;
  readonly #keySecret: string;
  readonly #ttlSec: number;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  /** 签发结果订阅者。签发成功/失败各通知一次 */
  #subscribers = new Set<(info: { ok: boolean; error: string }) => void>();
  #cache: TurnCredentials | null = null;
  /**
   * 在飞的那次签发。类型带 `null` 是因为 catch 分支会把它变成 null ——
   * 但**那不影响并发合并**：后来的调用照样拿到同一个（null）结果，
   * 那正是想要的（一次失败不该让 4 个进房的人各打一次 Cloudflare）。
   */
  #inflight: Promise<TurnCredentials | null> | null = null;
  #issued = 0;
  #lastError = '';

  constructor(opts: TurnCredentialOptions) {
    this.#keyId = opts.keyId;
    this.#keySecret = opts.keySecret;
    this.#ttlSec = opts.ttlSec ?? TURN_CREDENTIAL_TTL_SEC;
    this.#log = opts.logger ?? createLogger('signaling');
    this.#fetch = opts.fetchImpl ?? fetch;

    if (this.#ttlSec > 172_800) {
      throw new Error(
        `TURN 凭证 TTL 不得超过 48 小时（172800 秒），收到 ${this.#ttlSec}。` +
          '这是 Cloudflare 的硬限制，超了签发请求会被直接拒绝。',
      );
    }
  }

  /** 签发次数（排障用：反复失败时能看出是不是在打 Cloudflare） */
  get issuedCount(): number {
    return this.#issued;
  }

  /** 最近一次签发失败的原因，空串表示还没失败过 */
  get lastError(): string {
    return this.#lastError;
  }

  /**
   * 订阅签发结果，返回退订函数。
   *
   * 为什么需要这个：签发是**懒触发**的 —— 只有有人进房才发生，可能远晚于
   * 服务启动。宿主若只在启停时刷新状态面板，收不到通知就意味着面板上的
   * TURN 状态永远是启动那一刻的样子（一个不会变但已经过期的读数）。
   *
   * 订阅式而不是构造函数回调：provider 可能由宿主注入（测试），
   * 那时构造期还没人知道要监听，回调参数会白丢。
   */
  onActivity(callback: (info: { ok: boolean; error: string }) => void): () => void {
    this.#subscribers.add(callback);
    return () => this.#subscribers.delete(callback);
  }

  #notify(info: { ok: boolean; error: string }): void {
    for (const callback of this.#subscribers) {
      // 一个订阅者抛错不许连累别的，也不许让签发结果本身变成失败
      try {
        callback(info);
      } catch (err) {
        this.#log.warn(
          `TURN 活动订阅者抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * 取一份可用凭证，必要时签发。
   *
   * **失败不抛异常** —— 返回 null 表示「本次没有 TURN」，调用方按纯 P2P 继续。
   * 理由：TURN 是**兜底**不是前提，它挂了不该让建房失败 ——
   * 大多数网络环境 P2P 本来就能通，为一个用不上的兜底把功能全禁掉是本末倒置。
   * 但失败必须**留在日志和诊断里**（绝不能静默），否则用户只会看到
   * 「明明配了 TURN 却还是连不上」。
   */
  async get(): Promise<TurnCredentials | null> {
    const cached = this.#cache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    // 已有一次在飞 ⇒ 复用它，别并发打 Cloudflare
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.#request()
      .then((result) => {
        this.#cache = result;
        this.#lastError = '';
        this.#log.info(
          `TURN 凭证已签发（${this.#ttlSec}s，地址 ${result.iceServers[0].urls.length} 条）`,
        );
        this.#notify({ ok: true, error: '' });
        return result;
      })
      .catch((err: unknown) => {
        this.#lastError = err instanceof Error ? err.message : String(err);
        this.#log.warn(`TURN 凭证签发失败，本次按纯 P2P 继续：${this.#lastError}`);
        this.#notify({ ok: false, error: this.#lastError });
        return null;
      })
      .finally(() => {
        this.#inflight = null;
      });

    return this.#inflight;
  }

  async #request(): Promise<TurnCredentials> {
    this.#issued += 1;
    const url = CREDENTIALS_URL.replace('{keyId}', encodeURIComponent(this.#keyId));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          // secret 只出现在这一行的请求头里，不写日志、不进响应体
          authorization: `Bearer ${this.#keySecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: this.#ttlSec }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 4xx/5xx 的响应体可能含敏感信息，只取状态码
        throw new Error(`签发端点返回 ${response.status}`);
      }
      return parseResponse(await response.json());
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`签发超时（${REQUEST_TIMEOUT_MS / 1000}s）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
