import { MAX_PEERS_PER_ROOM, PROTOCOL_VERSION } from '@game-share/protocol';
import { createLogger, setLogLevel } from '@game-share/shared';

import { loadConfig } from './config';
import { formatAddressLines, listAdvertisableAddresses } from './network-addresses';
import { createSignalingServer } from './signaling-server';

const config = loadConfig();
setLogLevel(config.logLevel);

const log = createLogger('main');
const serverLog = createLogger('signaling');

const server = createSignalingServer({
  port: config.port,
  host: config.host,
  corsOrigins: config.corsOrigins,
  logger: serverLog,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`收到 ${signal}，正在关闭…`);
  try {
    await server.close();
    log.info('已关闭');
    process.exit(0);
  } catch (err) {
    log.error('关闭过程中出错', err);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { host, port, dualStack, fallbackReason } = await server.listen();
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

  log.info(`信令服务器已启动    http://${displayHost}:${port}`);
  log.info(`监听模式            ${dualStack ? '双栈（IPv4 + IPv6）' : '仅 IPv4'}`);
  if (fallbackReason) {
    log.warn(`IPv6 不可用，已降级为仅 IPv4：${fallbackReason}`);
  }
  log.info(`健康检查            http://${displayHost}:${port}/health`);
  log.info(`协议版本            v${PROTOCOL_VERSION}`);
  log.info(`房间上限            ${MAX_PEERS_PER_ROOM} 人（最多 6 条 P2P 链路）`);

  // 地址清单用 console 直接输出，不走 logger——带着级别前缀和时间戳反而难读，
  // 而这段是用户唯一需要照着抄的东西。
  const addresses = listAdvertisableAddresses(port);
  console.log('\n在另一台设备的「信令服务器」输入框里填其中之一：\n');
  console.log(formatAddressLines(addresses, port).join('\n'));
  console.log('');

  if (config.corsOrigins === '*') {
    log.warn('CORS 允许任意来源，仅适用于开发环境；部署时请设置 CORS_ORIGIN');
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', reason);
});

process.on('uncaughtException', (err) => {
  log.error('未捕获异常', err);
  void shutdown('uncaughtException');
});

main().catch((err) => {
  log.error('启动失败', err);
  process.exit(1);
});
