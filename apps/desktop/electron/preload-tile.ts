import { ipcRenderer } from 'electron';

/**
 * 小窗（拆分模式下的单路浮窗）专用 preload。
 *
 * **这个 preload 跑在 `contextIsolation: false` 的窗口里**（原因见 float-tiles.ts），
 * 所以它和页面同处一个 JS 上下文 —— 下面这些直接挂到 `window` 上就能被页面读到，
 * 不走 `contextBridge`。
 *
 * 为什么非关隔离不可：小窗要靠 MessagePort 收 `ImageBitmap`，
 * 而 `contextBridge` 只支持可序列化的值，DOM 对象（ImageBitmap / MessagePort）
 * 传不过去。安全性由「小窗只加载本地页面、nodeIntegration 关着」保证。
 */

export interface TilePortMessage {
  index: number;
  peerId: string;
  /**
   * 对端昵称。
   *
   * 身份跟通道一起过来，而不是只从 URL 参数读：同一个序号**换了人时页面不会重新导航**
   * （见 float-tiles.ts 的 connectTile），不这么送的话悬浮条会一直挂着上一个人的名字。
   */
  name: string;
}

export interface TileApi {
  /** 接收帧通道。返回取消订阅函数。**晚注册也能拿到已到达的通道**（见下） */
  onPort(callback: (port: MessagePort, meta: TilePortMessage) => void): () => void;
  /** 请求主窗口把这一路静音（声音在主窗口出，小窗只是开关） */
  toggleMute(peerId: string): void;
  /** 主窗口把这一路的静音状态推过来，保证按钮不会说反话 */
  onMuted(callback: (muted: boolean) => void): () => void;
  /** 拖动窗口。传的是目标左上角在屏幕上的坐标 */
  moveTo(x: number, y: number): void;
  resizeTo(width: number, height: number): void;
  /** 上报画面尺寸，帧泵按它缩放 */
  reportSize(width: number, height: number): void;
}

/**
 * 已经收到的通道缓存一份。
 *
 * 必须缓存：**主进程只在页面加载完成时建一次通道**，而 React 严格模式下
 * effect 会「挂载 → 卸载 → 再挂载」，第二次注册的监听器就再也等不到那条消息了。
 * 表现是「小窗一直是黑的，但什么都不报错」。
 */
const received: Array<{ port: MessagePort; meta: TilePortMessage }> = [];
const portListeners = new Set<(port: MessagePort, meta: TilePortMessage) => void>();
const mutedListeners = new Set<(muted: boolean) => void>();

ipcRenderer.on('float:tile-port', (event, meta: TilePortMessage) => {
  const port = (event as { ports?: MessagePort[] })?.ports?.[0];
  if (!port) return;
  const entry = { port, meta };
  received.push(entry);
  for (const listener of portListeners) listener(entry.port, entry.meta);
});

ipcRenderer.on('float:tile-muted', (_event, muted: boolean) => {
  for (const listener of mutedListeners) listener(muted === true);
});

const api: TileApi = {
  onPort(callback) {
    portListeners.add(callback);
    for (const entry of received) callback(entry.port, entry.meta);
    return () => {
      portListeners.delete(callback);
    };
  },
  toggleMute(peerId) {
    ipcRenderer.send('float:tile-toggle-mute', peerId);
  },
  onMuted(callback) {
    mutedListeners.add(callback);
    return () => {
      mutedListeners.delete(callback);
    };
  },
  moveTo(x, y) {
    ipcRenderer.send('float:tile-move-to', { x, y });
  },
  resizeTo(width, height) {
    ipcRenderer.send('float:tile-resize-to', { width, height });
  },
  reportSize(width, height) {
    ipcRenderer.send('float:tile-size', { width, height });
  },
};

(window as unknown as { gameShareTile: TileApi }).gameShareTile = api;

export type { TileApi as GameShareTileApi };
