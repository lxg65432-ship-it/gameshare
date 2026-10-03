import {
  DEFAULT_SIGNALING_HOST,
  createSignalingServer,
  listAdvertisableAddresses,
  pickRecommended,
  type SignalingServerHandle,
} from '@game-share/signaling';
import { DEFAULT_SIGNALING_PORT, createLogger } from '@game-share/shared';

/**
 * 客户端内置的信令服务器。
 *
 * 存在的理由：V0.1 的使用场景是几个朋友约着一起看画面，让每个人去命令行
 * 起一个 Node 服务不现实。客户端启动时顺手把服务器带起来，等于「第一个人
 * 打开客户端就完成了部署」。独立跑 `npm run serve` 的能力完全保留。
 *
 * **端口被占用不算错误**：本机已经有一个服务器时（用户自己起的，或同一台
 * 机器上开的第二个客户端），后启动的一方放弃监听、照常当客户端用，并把
 * 原因写到界面上。这样「同一台机器开 2 个客户端互看」也能正常工作。
 *
 * 监听地址用双栈通配（'::'）而不是 '0.0.0.0'：后者只接管 IPv4，
 * 而 IPv6 是唯一一条不需要 NAT 映射就能被外网直连的路。IPv6 不可用时
 * 由 createSignalingServer 自动降级。对应地，首次启动 Windows 防火墙
 * 会弹窗问是否放行 —— 这属于使用层面，代码里解决不了，README 里有说明。
 */

export type EmbeddedServerState = 'running' | 'port-in-use' | 'failed' | 'stopped';

export interface EmbeddedServerStatus {
  /** 用户意图（界面上的开关），与下面 state 表示的「实际结果」分开 */
  enabled: boolean;
  state: EmbeddedServerState;
  port: number;
  /** 是否同时监听 IPv6；false 表示系统禁用了 IPv6，已降级为仅 IPv4 */
  dualStack: boolean;
  /** 本机自用地址 */
  localUrl: string;
  /** 局域网 IPv4，只有同一个路由器下的设备能连 */
  lanUrls: string[];
  /** 公网 IPv4，家宽一般没有 */
  publicV4Urls: string[];
  /** 公网 IPv6，跨网络首选（前提是路由器放行入站） */
  publicV6Urls: string[];
  /** 按优先级推荐给对方填的那一条；没有可用地址时为 null */
  recommendedUrl: string | null;
  /** 端口冲突 / 启动失败的原因，正常时为 null */
  detail: string | null;
  /**
   * TURN 中继是否已就绪（M8）。
   *
   * 三个值而不是布尔：
   * - `off`   本机没配凭据 ⇒ 纯 P2P，两端都在对称 NAT 时必然连不通
   * - `ready` 签发过、且没有失败记录
   * - `error` 配了但签发失败（`detail` 里是原因）
   *
   * 单开布尔不够：「从没试过」和「试过且失败」在布尔上都长得一样，
   * 而这两者对用户的意义完全相反。
   */
  turnState: 'off' | 'ready' | 'error';
  /** TURN 凭证累计签发次数，0 表示本次启动还没签发过 */
  turnIssued: number;
}

export interface EmbeddedServerOptions {
  port?: number;
  /** 启动时是否开启，与界面上的开关初值一致 */
  enabled?: boolean;
  /**
   * TURN 临时凭证的签发凭据（M8）。
   *
   * 刻意**只从环境变量读、界面上不给输入框**。`TURN_KEY_SECRET` 是**计费凭据**：
   * 谁能读到它，谁就能拿你的额度替别人中继。存成 `userData` 下的明文 JSON
   * （本项目其他配置的存法）意味着它躺在磁盘上等人拷贝；做成界面输入框则意味着
   * 它进得去也就出得来（还进剪贴板、进日志面板、进截图）。
   *
   * 环境变量是这件事的现有惯例 —— Cloudflare 官方也是 `wrangler secret put`，
   * 本项目 `tunnel.bat` 走的是同一路子。代价是「要用 TURN 得在启动前设两个变量」，
   * 这对「朋友间内部使用」是可接受的：真到需要它的场景（两端都在对称 NAT）
   * 的人本来就在折腾网络环境了。
   */
  turn?: { keyId: string; keySecret: string } | null;
}

export class EmbeddedSignalingServer {
  readonly #port: number;
  readonly #turn: { keyId: string; keySecret: string } | null;
  #enabled: boolean;
  #handle: SignalingServerHandle | null = null;
  #status: EmbeddedServerStatus;
  #dualStack = false;
  #onChange: (status: EmbeddedServerStatus) => void = () => {};
  #unsubscribeTurn: (() => void) | null = null;

  constructor(options: EmbeddedServerOptions = {}) {
    this.#port = options.port ?? DEFAULT_SIGNALING_PORT;
    this.#enabled = options.enabled ?? true;
    this.#turn = options.turn ?? null;
    this.#status = this.#compose('stopped', this.#port, null);
  }

  get status(): EmbeddedServerStatus {
    return this.#status;
  }

  /** 状态变化回调，主进程用它推给渲染进程 */
  onChange(callback: (status: EmbeddedServerStatus) => void): void {
    this.#onChange = callback;
  }

  async start(): Promise<EmbeddedServerStatus> {
    if (this.#status.state === 'running') return this.#status;

    const log = createLogger('signaling');

    const handle = createSignalingServer({
      port: this.#port,
      host: DEFAULT_SIGNALING_HOST,
      // 打包后的页面是 file://，Origin 是 null，只能放开来源
      corsOrigins: '*',
      logger: log,
      turn: this.#turn,
    });

    /**
     * TURN 签发结果一有变化就重发状态。
     *
     * 签发是**懒触发**的（有人进房才发生），所以启停那一刻拿不到任何结论。
     * 不订阅的话状态面板上的 TURN 会一直停在「配了 / 没配」，
     * 用户真正需要知道的是「试过了，失败原因是什么」。
     */
    this.#unsubscribeTurn = handle.onTurnActivity((info) => {
      if (!info.ok) {
        log.warn(`TURN 不可用，本次按纯 P2P：${info.error}`);
      }
      this.#refreshStatus();
    });

    try {
      const { port, dualStack, fallbackReason } = await handle.listen();
      this.#handle = handle;
      this.#dualStack = dualStack;
      log.info(`内置信令服务器已启动 :${port}（${dualStack ? '双栈' : '仅 IPv4'}）`);
      if (fallbackReason) {
        log.warn(`IPv6 不可用，已降级为仅 IPv4：${fallbackReason}`);
      }
      return this.#publish('running', port, null);
    } catch (err) {
      // 监听失败的 httpServer 已经不可用，必须丢弃重建，
      // 否则用户再点一次开关会拿到一个坏掉的句柄
      this.#unsubscribeTurn?.();
      this.#unsubscribeTurn = null;
      await handle.close().catch(() => undefined);
      this.#handle = null;

      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'EADDRINUSE') {
        return this.#publish(
          'port-in-use',
          this.#port,
          `端口 ${this.#port} 已被占用，本机应该已有一个信令服务器在跑`,
        );
      }
      return this.#publish('failed', this.#port, message);
    }
  }

  async stop(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    this.#dualStack = false;
    // 先退订再关：留着订阅的话，关闭过程中的签发回调会打进一个已死的 handle，
    // 顺手还会把状态又推一遍。
    this.#unsubscribeTurn?.();
    this.#unsubscribeTurn = null;
    if (handle) await handle.close().catch(() => undefined);
    this.#publish('stopped', this.#port, null);
  }

  /** 界面开关的唯一入口：把「意图」和「实际起没起来」分开记 */
  async setEnabled(enabled: boolean): Promise<EmbeddedServerStatus> {
    this.#enabled = enabled;
    if (enabled) return this.start();
    await this.stop();
    return this.#status;
  }

  #publish(
    state: EmbeddedServerState,
    port: number,
    detail: string | null,
  ): EmbeddedServerStatus {
    this.#status = this.#compose(state, port, detail);
    try {
      this.#onChange(this.#status);
    } catch {
      // 推送失败不能反过来影响服务器状态
    }
    return this.#status;
  }

  /**
   * 按当前状态重发一次（不改变启停状态）。
   *
   * 给「状态里某个字段变了但 state 没变」用 —— TURN 签发结果就是这样：
   * 它是懒触发的，启停全程都不变。
   */
  #refreshStatus(): void {
    this.#publish(this.#status.state, this.#status.port, this.#status.detail);
  }

  #compose(
    state: EmbeddedServerState,
    port: number,
    detail: string | null,
  ): EmbeddedServerStatus {
    const addresses = listAdvertisableAddresses(port);
    return {
      enabled: this.#enabled,
      state,
      port,
      dualStack: this.#dualStack,
      localUrl: `http://localhost:${port}`,
      lanUrls: addresses.lan.map((item) => item.url),
      publicV4Urls: addresses.publicV4.map((item) => item.url),
      publicV6Urls: addresses.publicV6.map((item) => item.url),
      recommendedUrl: pickRecommended(addresses)?.url ?? null,
      detail,
      turnState: this.#turnState(),
      turnIssued: this.#handle?.turn?.issuedCount ?? 0,
    };
  }

  /**
   * TURN 三态。
   *
   * 读的是**本机内嵌信令**那个 provider，不是对端的情况 —— 对端有没有 TURN
   * 只能从它自己那边知道，本机无从判断，也不该假装知道。
   */
  #turnState(): EmbeddedServerStatus['turnState'] {
    if (!this.#turn) return 'off';
    const provider = this.#handle?.turn;
    // 还没起服务 ⇒ 谈不上签发过，此刻按 ready 报（配了就是配了）
    if (!provider) return 'ready';
    if (provider.lastError) return 'error';
    return 'ready';
  }
}
