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
}

export interface EmbeddedServerOptions {
  port?: number;
  /** 启动时是否开启，与界面上的开关初值一致 */
  enabled?: boolean;
}

export class EmbeddedSignalingServer {
  readonly #port: number;
  #enabled: boolean;
  #handle: SignalingServerHandle | null = null;
  #status: EmbeddedServerStatus;
  #dualStack = false;
  #onChange: (status: EmbeddedServerStatus) => void = () => {};

  constructor(options: EmbeddedServerOptions = {}) {
    this.#port = options.port ?? DEFAULT_SIGNALING_PORT;
    this.#enabled = options.enabled ?? true;
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
    };
  }
}
