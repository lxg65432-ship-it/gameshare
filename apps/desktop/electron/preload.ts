import { ipcRenderer } from 'electron';

import type { AudioCaptureFailure, AudioCaptureMode, AudioCapabilities } from './audio/types';
import type { EmbeddedServerStatus } from './embedded-server';
import type { FloatTilesStatus } from './float-tiles';
import type { TunnelStatus } from './tunnel';
import type { FloatWindowStatus } from './window-mode';

/**
 * 主进程 -> 渲染进程暴露的 API 面。
 *
 * **这一份是直接挂在 `window` 上的，不走 `contextBridge`**（与小窗的 preload-tile.ts 一致）：
 * 拆分模式的画面通道是 `MessagePort`，而 `MessagePort` **过不了 `contextBridge`** ——
 * 隔离打开时它交到页面手里会变成一个没有任何方法的普通对象，且**不报错**
 * （空对象是真值，判空照样过），于是帧泵每帧都静默失败、小窗全黑。
 * 实测见 `scripts/_probe-bridge-port.cjs`，成因写在 main.ts 的 webPreferences 上。
 * 所以主窗口的 `contextIsolation` 必须是 false —— 打开的话下面 `window.gameShare = api`
 * 会写进隔离世界，页面根本读不到。
 *
 * 这里的 AppInfo 结构必须与 apps/desktop/src/types/global.d.ts 保持一致
 * （preload 与 renderer 分属两个 tsconfig，无法共享类型文件）。
 * EmbeddedServerStatus 是 type-only 引入：preload 与主进程同属一个 tsconfig，
 * 可以直接复用，不必再抄一遍。
 */
export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  userDataPath: string;
  isDev: boolean;
}

export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  thumbnail: string | null;
  appIcon: string | null;
  /**
   * 窗口源所属进程的 PID（屏幕源为 null）。
   *
   * 有它才谈得上「只共享这个应用的声音」—— Chromium 的
   * `applicationLoopback:<pid>` 只认进程 ID，而源 id 里只有窗口句柄。
   * 取不到就是 null（窗口刚关掉 / FFI 不可用），**不猜一个顶上**：
   * 猜错的代价是「共享了另一个应用的声音」，看着像成功、实际张冠李戴。
   */
  pid: number | null;
}

/**
 * 拆分模式下的画面通道要缓存一份。
 *
 * 主进程只在「小窗页面加载完成」时建一次通道，而 React 严格模式下 effect 会走
 * 「挂载 → 卸载 → 再挂载」—— 第二次注册的监听器就再也等不到那条消息了，
 * 表现是「小窗一直黑着，但什么都不报错」。所以按 index 记下已到达的通道，
 * 晚注册的回调立刻补发一次。
 */
/** meta 里的 `name` 是「当前」对端昵称：同一个序号换了人时它跟通道一起刷新 */
type TilePortMeta = { index: number; peerId: string; name: string };

const tilePorts = new Map<number, { port: MessagePort; meta: TilePortMeta }>();
const tilePortListeners = new Set<(port: MessagePort, meta: TilePortMeta) => void>();

ipcRenderer.on('float:tile-port', (event, meta: TilePortMeta) => {
  const port = (event as { ports?: MessagePort[] })?.ports?.[0];
  if (!port) return;
  tilePorts.set(meta.index, { port, meta });
  for (const listener of tilePortListeners) listener(port, meta);
});

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:get-info') as Promise<AppInfo>,
  /**
   * 复制文本到系统剪贴板。
   *
   * **不要图省事改成渲染层的 `navigator.clipboard.writeText`** —— 这条路实测是坏的：
   *   1. 主进程 `main.ts` 的权限白名单只放行 `media` / `display-capture`，
   *      剪贴板写入要的权限会被 `callback(false)` 直接拒掉，抛
   *      `NotAllowedError: Write permission denied`，而调用方把它 catch 成一行日志
   *      ⇒ 按钮看着**完全没反应**（2026-09-17「复制 / 复制邀请」失效就是这个）；
   *   2. 把白名单放开也救不了浮窗模式：那边窗口是 `setFocusable(false)`，
   *      写入会改成抛 `NotAllowedError: Document is not focused`，
   *      而浮窗恰恰是最想复制房间码发给朋友的场景。
   * 主进程的 `clipboard` 模块既不看权限也不看窗口焦点，两种模式都能用。
   * 实测（四个场景的量法）见 `scripts/_probe-clipboard.cjs`。
   */
  clipboard: {
    /** 写入成功返回 true。主进程只接受非空字符串 */
    writeText: (text: string): Promise<boolean> =>
      ipcRenderer.invoke('clipboard:write-text', text) as Promise<boolean>,
  },
  capture: {
    listSources: (): Promise<CaptureSourceInfo[]> =>
      ipcRenderer.invoke('capture:list-sources') as Promise<CaptureSourceInfo[]>,
    /**
     * 把「这次采哪个源、要不要声音、要哪一种声音」交给主进程。
     *
     * `getDisplayMedia` 的 request handler 拿不到调用方的约束，只能靠这里传过去的值；
     * **两边必须一致**：渲染层请求了 audio 而主进程没给（或反过来），Chromium 会让
     * 整次采集失败。
     *
     * `audioMode` 是**业务层唯一该表达的东西**（application / system / none，
     * 外加显式开启的 loopback）；Chromium 的 device id 由主进程的
     * `audio/strategies.ts` 拼，渲染层不许碰那些字符串。
     * 只给 `withAudio` 时按 `true → system` / `false → none` 翻译（老界面的布尔开关）。
     */
    selectSource: (
      sourceId: string,
      options?: { withAudio?: boolean; audioMode?: AudioCaptureMode },
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('capture:select-source', sourceId, options) as Promise<{ ok: boolean }>,
    /**
     * 取走主进程记下的采集失败原因（取走即清空）。
     *
     * getDisplayMedia 自己抛的错只有 NotAllowedError 这种笼统结果，
     * 「为什么没采到」只有主进程那一侧知道。
     *
     * 返回结构里 `suggestion` 是**可选**的替代模式 —— 调用方可以据此再问用户一次，
     * 但不要自己直接换过去（那就成了静默降级）。
     */
    takeFailure: (): Promise<AudioCaptureFailure | null> =>
      ipcRenderer.invoke('capture:take-failure') as Promise<AudioCaptureFailure | null>,
    /** 四种音频模式在本机的可用性（含取不到的原因），给界面与验收脚本用 */
    getAudioCapabilities: (): Promise<AudioCapabilities> =>
      ipcRenderer.invoke('capture:get-audio-capabilities') as Promise<AudioCapabilities>,
  },
  server: {
    getStatus: (): Promise<EmbeddedServerStatus> =>
      ipcRenderer.invoke('server:get-status') as Promise<EmbeddedServerStatus>,
    setEnabled: (enabled: boolean): Promise<EmbeddedServerStatus> =>
      ipcRenderer.invoke('server:set-enabled', enabled) as Promise<EmbeddedServerStatus>,
    /** 返回取消订阅函数 —— 组件卸载时必须调用，否则热更新会残留多个监听 */
    onStatus: (callback: (status: EmbeddedServerStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: EmbeddedServerStatus): void => callback(status);
      ipcRenderer.on('server:status', handler);
      return () => ipcRenderer.off('server:status', handler);
    },
  },
  tunnel: {
    getStatus: (): Promise<TunnelStatus> =>
      ipcRenderer.invoke('tunnel:get-status') as Promise<TunnelStatus>,
    setEnabled: (enabled: boolean): Promise<TunnelStatus> =>
      ipcRenderer.invoke('tunnel:set-enabled', enabled) as Promise<TunnelStatus>,
    onStatus: (callback: (status: TunnelStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: TunnelStatus): void => callback(status);
      ipcRenderer.on('tunnel:status', handler);
      return () => ipcRenderer.off('tunnel:status', handler);
    },
  },
  /**
   * 浮窗模式（置顶 + 精简界面 + 可缩到很小 + 可调透明度）。
   *
   * 命名用 windowMode 而不是 window：渲染层里 `window` 是全局对象，
   * 叫 `gameShare.window` 容易被误读成「拿到了宿主窗口句柄」。
   */
  windowMode: {
    getStatus: (): Promise<FloatWindowStatus> =>
      ipcRenderer.invoke('float:get-status') as Promise<FloatWindowStatus>,
    setEnabled: (enabled: boolean): Promise<FloatWindowStatus> =>
      ipcRenderer.invoke('float:set-enabled', enabled) as Promise<FloatWindowStatus>,
    /** 只在浮窗模式下生效；非浮窗模式窗口恒为不透明 */
    setOpacity: (opacity: number): Promise<FloatWindowStatus> =>
      ipcRenderer.invoke('float:set-opacity', opacity) as Promise<FloatWindowStatus>,
    onStatus: (callback: (status: FloatWindowStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: FloatWindowStatus): void => callback(status);
      ipcRenderer.on('float:status', handler);
      return () => ipcRenderer.off('float:status', handler);
    },
    /**
     * 拖动 / 缩放浮窗（渲染层自绘）。
     *
     * 浮窗模式下窗口是 `setFocusable(false)` 的，系统那套「拖标题栏、拉边框」都会先
     * 激活窗口 —— 非激活窗口上不成立，用户看到的就是「浮窗拖不动」。所以坐标由渲染层
     * 自己算、这里只负责交给主进程 `setBounds`（主进程那边还卡了最小尺寸）。
     */
    moveTo: (x: number, y: number, width: number, height: number): void => {
      ipcRenderer.send('float:move-to', { x, y, width, height });
    },
    resizeTo: (width: number, height: number): void => {
      ipcRenderer.send('float:resize-to', { width, height });
    },
  },
  /**
   * 常规模式的窗口按钮（顶栏右上角那三个）。
   *
   * 主窗口是 `frame: false` 的（见 main.ts 里 frame 那段：原生标题栏在浮窗模式下
   * 拖不动，整个去掉了），所以最小化 / 最大化 / 关闭只能由界面自己画、自己发。
   */
  windowControl: {
    minimize: (): void => {
      ipcRenderer.send('win:minimize');
    },
    toggleMaximize: (): void => {
      ipcRenderer.send('win:toggle-maximize');
    },
    close: (): void => {
      ipcRenderer.send('win:close');
    },
    /**
     * 最大化状态。**必须听主进程的回报**：双击拖动区也会最大化（系统行为，
     * 不经过我们的按钮），自己记的话图标立刻说反话。
     */
    onMaximized: (callback: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: unknown, maximized: boolean): void => callback(maximized);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },
  /**
   * 浮窗的**拆分模式**：每一路远端画面一个独立小窗（窗数 = 总人数 − 1）。
   *
   * 这一组 API 基本都在为「帧泵」服务。小窗拿不到轨道（`MediaStreamTrack`
   * 过不了进程边界），所以画面得由主窗口搬过去 —— `onTilePort` 拿到的就是主进程
   * 为每个小窗建好的 MessagePort，**`ImageBitmap` 只有走它的 transfer list
   * 才能零拷贝过去**，`ipcRenderer.send` 的结构化克隆搬不了 DOM 对象。
   */
  floatTiles: {
    getStatus: (): Promise<FloatTilesStatus> =>
      ipcRenderer.invoke('float:get-tiles-status') as Promise<FloatTilesStatus>,
    setEnabled: (enabled: boolean): Promise<FloatTilesStatus> =>
      ipcRenderer.invoke('float:set-tiles-enabled', enabled) as Promise<FloatTilesStatus>,
    /**
     * 收起 / 展开那条控制条（缩成贴右下角的小球）。
     *
     * 窗口尺寸是主进程改的，所以渲染层这次调用之后要等 `float:tiles-status`
     * 把 `barCollapsed` 推回来才切界面 —— 别自己先切成小球，那样窗口还没缩，
     * 会出现「小球画在一条 620x76 的窗口里」的一帧。
     */
    setBarCollapsed: (collapsed: boolean): Promise<FloatTilesStatus> =>
      ipcRenderer.invoke('float:set-bar-collapsed', collapsed) as Promise<FloatTilesStatus>,
    /**
     * 上报「对端有谁、各开一个窗」。顺序即位置：index 0 是第一个对端。
     *
     * `muted` 必须一起带上：小窗上的静音按钮要跟本机的实际状态一致，
     * 漏了它小窗会一直显示「有声」，用户点一下反而把已经静音的这路放开。
     */
    syncPeers: (
      peers: Array<{ peerId: string; name: string; muted?: boolean }>,
    ): Promise<FloatTilesStatus> =>
      ipcRenderer.invoke('float:sync-tiles', peers) as Promise<FloatTilesStatus>,
    onStatus: (callback: (status: FloatTilesStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: FloatTilesStatus): void => callback(status);
      ipcRenderer.on('float:tiles-status', handler);
      return () => ipcRenderer.off('float:tiles-status', handler);
    },
    /**
     * 每条通道对应一个小窗，meta 里带序号与对端身份（`peerId` / `name`）。
     *
     * **晚注册也会收到已经到达的通道**（在上面缓存、在这里补发）——
     * 小窗重载、React 严格模式双挂载都靠这条兜住。
     */
    onTilePort: (
      callback: (port: MessagePort, meta: { index: number; peerId: string; name: string }) => void,
    ): (() => void) => {
      tilePortListeners.add(callback);
      for (const entry of tilePorts.values()) callback(entry.port, entry.meta);
      return () => {
        tilePortListeners.delete(callback);
      };
    },
    /** 小窗尺寸变化 —— 帧泵按它缩放，否则画面会被拉伸或留黑边 */
    onTileSize: (
      callback: (info: { index: number; width: number; height: number }) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        info: { index: number; width: number; height: number },
      ): void => callback(info);
      ipcRenderer.on('float:tile-size', handler);
      return () => ipcRenderer.off('float:tile-size', handler);
    },
    /**
     * 小窗上按了「静音这一路」。
     *
     * 声音其实在**主窗口**里出（音轨过不去小窗），所以小窗只是个开关，
     * 真正切 `<video>.muted` 的是这里收到请求之后的主窗口。
     */
    onToggleMuteRequest: (callback: (peerId: string) => void): (() => void) => {
      const handler = (_event: unknown, peerId: string): void => callback(peerId);
      ipcRenderer.on('float:tile-toggle-mute', handler);
      return () => ipcRenderer.off('float:tile-toggle-mute', handler);
    },
  },
};

export type GameShareApi = typeof api;

/**
 * 直接挂到 `window` 上，**不用 `contextBridge`**（理由见文件头）。
 * 主窗口的 `contextIsolation` 必须是 false，否则这句写进的是隔离世界，页面读不到。
 */
(window as unknown as { gameShare: GameShareApi }).gameShare = api;
