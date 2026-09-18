import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { DEFAULT_SIGNALING_PORT } from '@game-share/shared';

/**
 * Cloudflare quick tunnel 的封装：把内置信令服务器暴露到公网。
 *
 * 存在的理由：内置信令只解决了「谁当服务器」，没解决「对方怎么连上来」。
 * 本机是双层 NAT，端口映射这条路已经排除；公网 IPv6 需要路由器放行入站，
 * 实测不通。可用的只剩隧道。而隧道原本要靠 `tunnel.bat` 单独起一个黑窗口、
 * 人肉从输出里挑地址再复制给对方 —— 这一步不消掉，就得靠语音指挥对方操作。
 *
 * **刻意默认关闭，且只由界面手动开启。** 隧道地址是公网可达的，而信令服务
 * 没有任何鉴权与限流，房间码是唯一防线。原先「用完即关」这条兜底，靠的是
 * 隧道必须手动起；如果改成随客户端常驻，这层保护就没了。所以这里的
 * `enabled` 初值恒为 false，并且界面必须提供显式的关闭入口。
 *
 * 关于 cloudflared 的输出（2026-09-17 实测，版本 2026.9.1）：
 *
 * - 日志参数是 `--output json`；写成 `--logformat` 会直接报错退出
 * - **所有日志走 stderr，stdout 完全为空** —— 只监听 stdout 会永远拿不到地址
 * - JSON 只有 `{level, message, time}`，**没有独立的 url 字段**：地址被包在
 *   `message` 的框线里、右侧还补了空格。所以必须正则提取，不能读字段
 * - 从启动到分配地址约 3 秒
 */

export type TunnelState = 'stopped' | 'starting' | 'running' | 'failed';

export interface TunnelStatus {
  /** 找得到 cloudflared.exe 才为 true；false 时界面应禁用开关并显示 detail */
  available: boolean;
  /** 用户意图（界面上的开关）。与 state 表示的「实际结果」分开记 */
  enabled: boolean;
  state: TunnelState;
  /** 公网地址，仅 state === 'running' 时有值 */
  url: string | null;
  /** 失败原因 / 不可用原因，正常时为 null */
  detail: string | null;
}

export interface TunnelOptions {
  /** 转发目标端口，默认与内置信令一致 */
  port?: number;
  /** 界面开关的初值。除非明确要自动开，否则别传 true */
  enabled?: boolean;
  /** 显式指定 cloudflared 路径（测试用） */
  executablePath?: string;
}

const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** 起隧道要等 Cloudflare 分配地址，实测 3 秒左右；给足余量，超时说明网络到不了 Cloudflare */
const START_TIMEOUT_MS = 40_000;

/**
 * 从一行日志里提取隧道地址。
 *
 * 先按 JSON 解析取 message，解析不了就直接拿原始行 —— 两种都跑正则。
 * 这样 `--output` 参数哪天变了或者被去掉，只要地址还在输出里就仍然能抓出来。
 */
export function extractTunnelUrl(line: string): string | null {
  let text = line;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object') {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string') text = message;
    }
  } catch {
    // 非 JSON 行：直接用原文
  }
  const hit = text.match(URL_PATTERN);
  return hit ? hit[0] : null;
}

/**
 * 定位 cloudflared.exe。
 *
 * 开发期在仓库根 `tools/` 下，打包后由 electron-builder 的 extraResources
 * 放进 `resources/`。两个位置都不是「相对 __dirname 往上数」能稳拿到的
 * —— 打包后主进程跑在 app.asar 里，所以必须靠 app.isPackaged 分叉。
 */
export function resolveCloudflaredPath(explicit?: string): string | null {
  const candidates: string[] = [];

  if (explicit) candidates.push(explicit);

  const fromEnv = process.env.GAMESHARE_CLOUDFLARED;
  if (fromEnv) candidates.push(fromEnv);

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'cloudflared.exe'));
  } else {
    // 开发期 app.getAppPath() 是 apps/desktop，往上两级才是仓库根
    candidates.push(path.join(app.getAppPath(), '..', '..', 'tools', 'cloudflared.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    } catch {
      // 路径非法（例如 env 里塞了奇怪字符）就跳过，继续试下一个
    }
  }
  return null;
}

export class TunnelManager {
  readonly #port: number;
  readonly #executable: string | null;
  #enabled: boolean;
  #status: TunnelStatus;
  #child: ChildProcess | null = null;
  #buffer = '';
  #timer: NodeJS.Timeout | null = null;
  #onChange: (status: TunnelStatus) => void = () => {};

  constructor(options: TunnelOptions = {}) {
    this.#port = options.port ?? DEFAULT_SIGNALING_PORT;
    this.#enabled = options.enabled ?? false;
    this.#executable = resolveCloudflaredPath(options.executablePath);
    this.#status = this.#compose('stopped', null, this.#executableMissingHint());
  }

  get status(): TunnelStatus {
    return this.#status;
  }

  /** 状态变化回调，主进程用它推给渲染进程 */
  onChange(callback: (status: TunnelStatus) => void): void {
    this.#onChange = callback;
  }

  async start(): Promise<TunnelStatus> {
    if (this.#status.state === 'running' || this.#status.state === 'starting') {
      return this.#status;
    }

    // 找不到可执行文件时不要碰 #enabled —— 那是用户意图，
    // 界面上的开关状态必须与用户点的一致，否则会被莫名其妙弹回去
    if (!this.#executable) {
      return this.#publish('failed', null, this.#executableMissingHint());
    }

    this.#buffer = '';
    this.#publish('starting', null, null);

    let child: ChildProcess;
    try {
      child = spawn(
        this.#executable,
        [
          'tunnel',
          '--no-autoupdate',
          // 地址被包在 message 的框线里，只有 json 格式才带引号边界，正则更稳
          '--output',
          'json',
          '--url',
          `http://localhost:${this.#port}`,
        ],
        // windowsHide：否则每次开隧道都会闪一个黑窗口
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      return this.#publish('failed', null, describeError(err));
    }

    this.#child = child;

    // **实测地址只出现在 stderr**。stdout 两个都挂上，是为了不依赖这个观察结果。
    child.stdout?.on('data', (chunk: Buffer) => this.#consume(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.#consume(chunk));

    child.on('error', (err) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#clearTimer();
      this.#publish('failed', null, `无法启动 cloudflared：${err.message}`);
    });

    child.on('exit', (code, signal) => {
      // 已经被 stop() 接管的话这里不再改状态，否则会覆盖掉 stopped
      if (this.#child !== child) return;
      this.#child = null;
      this.#clearTimer();
      this.#publish(
        'failed',
        null,
        `cloudflared 意外退出（code=${String(code)} signal=${String(signal)}）`,
      );
    });

    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#status.state !== 'starting') return;
      void this.stop();
      this.#publish(
        'failed',
        null,
        `隧道在 ${START_TIMEOUT_MS / 1000} 秒内没有拿到地址，已中止。检查这台机器能否访问 Cloudflare。`,
      );
    }, START_TIMEOUT_MS);

    return this.#status;
  }

  async stop(): Promise<void> {
    this.#clearTimer();
    this.#buffer = '';

    const child = this.#child;
    this.#child = null;
    this.#publish('stopped', null, null);

    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const pid = child.pid;
    try {
      child.kill();
    } catch {
      // 已经退出了
    }
    if (pid === undefined) return;

    // Windows 上 kill() 打的是主进程本身。cloudflared 是单进程程序，正常够了，
    // 但「用户点了关闭」不该留任何东西在后台继续暴露端口，所以补一道兜底。
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      setTimeout(() => {
        if (settled) return;
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } catch {
          // taskkill 本身失败就只能算了，进程多半已经没了
        }
        setTimeout(done, 700);
      }, 2000);
    });
  }

  /** 界面开关的唯一入口 */
  async setEnabled(enabled: boolean): Promise<TunnelStatus> {
    this.#enabled = enabled;
    if (enabled) return this.start();

    await this.stop();
    // stop() 里已经 publish 过，但那时 #enabled 还是旧值，这里重发一次把意图带上
    return this.#publish('stopped', null, this.#executableMissingHint());
  }

  #consume(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8');

    // 只对完整的行做解析，半行留到下一个 chunk —— 地址行被框线包着，
    // 拆在中间是不会被正则命中的
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) {
      const url = extractTunnelUrl(line);
      if (url && this.#status.state === 'starting') {
        this.#clearTimer();
        this.#publish('running', url, null);
        return;
      }
    }
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #executableMissingHint(): string | null {
    if (this.#executable) return null;
    return app.isPackaged
      ? '安装包里没有找到 cloudflared.exe，异地访问不可用。请重新安装完整版本。'
      : '未找到 tools/cloudflared.exe，异地访问不可用。可在仓库根运行 scripts/fetch-github-release.mjs 下载。';
  }

  #publish(state: TunnelState, url: string | null, detail: string | null): TunnelStatus {
    this.#status = this.#compose(state, url, detail);
    try {
      this.#onChange(this.#status);
    } catch {
      // 推送失败不能反过来影响隧道状态
    }
    return this.#status;
  }

  #compose(state: TunnelState, url: string | null, detail: string | null): TunnelStatus {
    return {
      available: this.#executable !== null,
      enabled: this.#enabled,
      state,
      url,
      detail: detail ?? this.#executableMissingHint(),
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
