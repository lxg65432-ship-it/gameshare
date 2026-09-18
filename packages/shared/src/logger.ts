/**
 * 极简跨环境日志（Node 服务端 + Electron 渲染/主进程共用）。
 *
 * 默认输出到 console；调用 addLogSink() 后可把日志重定向到文件
 * （Electron 端在 M9 稳定性排查时会把日志落到 userData/logs）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  scope: string;
  /** ISO 时间戳 */
  time: string;
  args: unknown[];
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minWeight = LEVEL_WEIGHT.info;
const sinks: LogSink[] = [];

export function setLogLevel(level: LogLevel): void {
  minWeight = LEVEL_WEIGHT[level];
}

/**
 * 注册日志输出目标。一旦注册了至少一个 sink，
 * 默认的 console 输出会被关闭，避免同一条日志打印两遍。
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < minWeight) return;
  const record: LogRecord = { level, scope, time: timestamp(), args };

  if (sinks.length > 0) {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // 日志系统自身不能抛错影响主流程
      }
    }
    return;
  }

  const prefix = `${record.time} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (level === 'debug') console.log(prefix, ...args);
  else if (level === 'info') console.info(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.error(prefix, ...args);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}
