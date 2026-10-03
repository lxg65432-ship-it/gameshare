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
  /**
   * TURN 凭证配置。**没配就是没有 TURN**（纯 P2P，M8 之前的行为）。
   *
   * 两个字段必须**成对**出现：只给一个说明配置写了一半，
   * 那时候静默当「没配」会让排障的人以为程序坏了。
   */
  turn: { keyId: string; keySecret: string } | null;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw && (VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return 'info';
}

function parseTurn(
  env: NodeJS.ProcessEnv,
): { keyId: string; keySecret: string } | null {
  const keyId = (env.TURN_KEY_ID ?? '').trim();
  const keySecret = (env.TURN_KEY_SECRET ?? '').trim();
  if (!keyId && !keySecret) return null;

  if (!keyId || !keySecret) {
    // 不 throw：信令服务不该因为 TURN 配置写错就起不来（它还能干别的），
    // 但**必须喊出来** —— 静默降级会让人以为配好了。
    console.warn(
      '[config] TURN 配置不完整：TURN_KEY_ID 与 TURN_KEY_SECRET 必须成对出现。' +
        '本次按「无 TURN」启动。',
    );
    return null;
  }
  return { keyId, keySecret };
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
    turn: parseTurn(env),
  };
}
