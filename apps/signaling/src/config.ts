import type { LogLevel } from '@game-share/shared';
import { DEFAULT_SIGNALING_PORT } from '@game-share/shared';

/**
 * 默认监听地址：双栈通配。
 *
 * 不能写 '0.0.0.0' —— 那**只**监听 IPv4。本机若拿到公网 IPv6，
 * 那是唯一一条不需要 NAT 映射就能被外网直连的路，绑 IPv4 等于把它堵死。
 * '::' 在 ipv6Only=false（Node 默认）下同时接管 IPv4 与 IPv6。
 * 若系统禁用了 IPv6，signaling-server 的 listen 会自动降级到 0.0.0.0。
 */
export const DEFAULT_SIGNALING_HOST = '::';

export interface ServerConfig {
  port: number;
  host: string;
  /** '*' 表示开发期允许任意来源；生产环境应填具体域名 */
  corsOrigins: string[] | '*';
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw && (VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return 'info';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portRaw = Number.parseInt(env.PORT ?? '', 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : DEFAULT_SIGNALING_PORT;

  const corsRaw = (env.CORS_ORIGIN ?? '*').trim();
  const corsOrigins: string[] | '*' =
    corsRaw === '*' || corsRaw === ''
      ? '*'
      : corsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  return {
    port,
    host: env.HOST?.trim() || DEFAULT_SIGNALING_HOST,
    corsOrigins,
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}
