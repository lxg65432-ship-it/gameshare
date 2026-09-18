/**
 * 内嵌宿主的导出面（Electron 主进程用）。
 *
 * 为什么不直接从 index.ts 导出：那个文件是**进程入口**，被 import 的一瞬间就会
 * loadConfig()、开始监听、注册 SIGINT/SIGTERM —— 当库引用会带着副作用跑起来。
 * 这里只给工厂函数与类型，由宿主决定何时监听、监听在哪个地址上。
 */
export { createSignalingServer } from './signaling-server';
export type {
  ListenResult,
  SignalingServerHandle,
  SignalingServerOptions,
} from './signaling-server';

export {
  buildUrl,
  formatAddressLines,
  formatHostForUrl,
  listAdvertisableAddresses,
  pickRecommended,
} from './network-addresses';
export type {
  AddressKind,
  AdvertisableAddress,
  AdvertisableAddresses,
} from './network-addresses';

export { DEFAULT_SIGNALING_HOST, loadConfig } from './config';
export type { ServerConfig } from './config';
