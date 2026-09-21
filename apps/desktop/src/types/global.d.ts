/**
 * 与 apps/desktop/electron/preload.ts 中的结构保持一致。
 * preload 与 renderer 分属两个 tsconfig，无法直接共享类型文件。
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
   * 有它才谈得上「只共享这个应用的声音」：Chromium 的 `applicationLoopback:<pid>`
   * 只认进程 ID，而 source id 里只有窗口句柄。取不到就是 null，不猜一个顶上。
   */
  pid: number | null;
  /**
   * 窗口源是否处于「被我们强制无边框化」的状态（屏幕源恒 false）。
   *
   * 唯一事实源在主进程的内存 map（它才看得到真实样式），渲染层只据此
   * 决定按钮显示「无边框化」还是「还原」。
   */
  borderless: boolean;
}

/**
 * 音频采集模式。**业务层只表达这四种之一**，Chromium 的 device id 由主进程拼
 * （见 `electron/audio/device-ids.ts`）。
 *
 * 与 `electron/audio/types.ts` 保持一致 —— preload 与 renderer 分属两个 tsconfig。
 */
export type AudioCaptureMode = 'application' | 'system' | 'none' | 'loopback';

/**
 * 一次采集失败的完整信息（`capture:take-failure` 的返回）。
 *
 * `suggestion` 是**可选**的替代模式：调用方可以据此再问一次用户，
 * 但不能自己直接换过去 —— 那就是「静默降级」。
 */
export interface AudioCaptureFailure {
  message: string;
  failedMode: AudioCaptureMode | null;
  suggestion: AudioCaptureMode | null;
}

export interface AudioModeCapability {
  mode: AudioCaptureMode;
  /** 展示名。渲染层直接用这个，别再抄一份文案 */
  label: string;
  /** false = 调试 / 高级兼容，不该作为正常选项暴露给用户 */
  official: boolean;
  /** 静态前置条件是否满足；不代表运行时一定起得来 */
  available: boolean;
  reason: string | null;
}

export interface AudioCapabilities {
  platform: string;
  ffi: { available: boolean; detail: string };
  electron: string;
  modes: AudioModeCapability[];
}

/**
 * 内置信令服务器的状态。结构以 electron/embedded-server.ts 为准，
 * 这里按本文件的一贯做法单独声明（渲染进程不引入 signaling 包的类型，
 * 否则 Node 侧的 socket.io 会进入渲染进程的类型图）。
 */
export interface EmbeddedServerStatus {
  /** 用户意图（界面上的开关） */
  enabled: boolean;
  /** 实际结果 */
  state: 'running' | 'port-in-use' | 'failed' | 'stopped';
  port: number;
  /** 是否同时监听 IPv6；false 表示系统禁用了 IPv6，已降级为仅 IPv4 */
  dualStack: boolean;
  localUrl: string;
  /** 局域网 IPv4，只有同一个路由器下的设备能连 */
  lanUrls: string[];
  /** 公网 IPv4，家宽一般没有 */
  publicV4Urls: string[];
  /** 公网 IPv6，跨网络首选（前提是路由器放行入站） */
  publicV6Urls: string[];
  /** 按优先级推荐给对方填的那一条 */
  recommendedUrl: string | null;
  detail: string | null;
}

/**
 * 异地访问隧道的状态。结构以 electron/tunnel.ts 为准，
 * 按本文件的一贯做法单独声明。
 */
export interface TunnelStatus {
  /** 找得到 cloudflared.exe 才为 true；false 时界面应禁用开关并显示 detail */
  available: boolean;
  /** 用户意图（界面上的开关） */
  enabled: boolean;
  /** 实际结果 */
  state: 'stopped' | 'starting' | 'running' | 'failed';
  /** 公网地址，仅 state === 'running' 时有值 */
  url: string | null;
  detail: string | null;
}

/**
 * 浮窗模式状态。结构以 electron/window-mode.ts 为准，
 * 按本文件的一贯做法单独声明。
 */
export interface FloatWindowStatus {
  /** 是否处于浮窗模式（置顶 + 精简界面 + 可缩到很小） */
  enabled: boolean;
  /**
   * 是否处于**拆分**模式：每一路远端画面一个独立小窗（窗数 = 总人数 − 1）。
   * 只有浮窗模式开着时才可能为真 —— 拆分是浮窗的子模式。
   */
  tilesEnabled: boolean;
  /** 浮窗模式下的不透明度（minOpacity~1）。非浮窗模式下窗口恒为 1 */
  opacity: number;
  minOpacity: number;
  /** 全局快捷键在本进程是否注册成功。多开客户端时只有一个窗口能拿到 */
  hotkeyAvailable: boolean;
  hotkey: string;
}

/** 拆分模式下的一个小窗。结构以 electron/float-tiles.ts 为准 */
export interface FloatTileInfo {
  index: number;
  peerId: string;
  name: string;
  width: number;
  height: number;
}

export interface FloatTilesStatus {
  enabled: boolean;
  /** 控制条是否已收起成小球。界面按它决定画控制条还是画小球 */
  barCollapsed: boolean;
  tiles: FloatTileInfo[];
}

/**
 * 小窗页面独有的 API（`electron/preload-tile.ts`）。
 *
 * 主窗口没有这一份 —— 小窗是 `contextIsolation: false` 的窗口，
 * 靠自己收 MessagePort 画帧。类型这里单独声明，preload 与 renderer 分属两个 tsconfig。
 */
export interface GameShareTileApi {
  /**
   * 接收画面通道。
   *
   * meta 里带的是**当前**对端身份：同一个序号换了人时，主进程不会重新导航这个窗口，
   * 而是重连一条新通道并把新身份一起送过来 —— 所以名字和 peerId 都要跟着它更新。
   */
  onPort(
    callback: (port: MessagePort, meta: { index: number; peerId: string; name: string }) => void,
  ): () => void;
  /** 请求主窗口把这一路静音（声音在主窗口出，小窗只是个开关） */
  toggleMute(peerId: string): void;
  /** 主窗口把这一路的静音状态推过来，保证小窗上的按钮不会说反话 */
  onMuted(callback: (muted: boolean) => void): () => void;
  /**
   * 拖动窗口。传的是目标左上角在屏幕上的坐标，以及**按下那一刻锁定的客户区尺寸**。
   *
   * 尺寸必须跟着传：主进程将直接按它 setBounds，不再每帧展开 getBounds() ——
   * 非 100% 缩放屏上那个往返的取整误差会逐帧累积，用户看到的就是「拖动时浮窗变大」。
   */
  moveTo(x: number, y: number, width: number, height: number): void;
  resizeTo(width: number, height: number): void;
  /** 上报画面尺寸，帧泵按它缩放 */
  reportSize(width: number, height: number): void;
}

export interface GameShareApi {
  getAppInfo(): Promise<AppInfo>;
  /**
   * 复制文本到系统剪贴板（成功为 true）。
   *
   * **必须走这里，不要改用渲染层的 `navigator.clipboard`**：主进程的权限白名单
   * 会拒掉剪贴板写入权限（抛 `NotAllowedError: Write permission denied`），
   * 而放开白名单也救不了浮窗模式 —— 那是不可聚焦窗口，会改成抛
   * `Document is not focused`。主进程的 clipboard 模块两条约束都不受。
   * 实测见 `scripts/_probe-clipboard.cjs`。
   */
  clipboard: {
    writeText(text: string): Promise<boolean>;
  };
  capture: {
    listSources(): Promise<CaptureSourceInfo[]>;
    /**
     * 把「采哪个源、要不要声音、要哪一种声音」交给主进程。
     *
     * `audioMode` 是业务层唯一该表达的东西；Chromium 的 device id
     * （`loopbackWithoutChrome` / `applicationLoopback:<pid>`…）由主进程拼，
     * 渲染层不许碰那些字符串。
     * 只给 `withAudio` 时按 `true → system` / `false → none` 翻译。
     */
    selectSource(
      sourceId: string,
      options?: { withAudio?: boolean; audioMode?: AudioCaptureMode },
    ): Promise<{ ok: boolean }>;
    /** 取走主进程记下的采集失败原因（取走即清空），没有失败时为 null */
    takeFailure(): Promise<AudioCaptureFailure | null>;
    /** 四种音频模式在本机的可用性（含取不到的原因） */
    getAudioCapabilities(): Promise<AudioCapabilities>;
    /**
     * 强制无边框化 / 还原（toggle）。
     *
     * 业务失败不抛异常：原因写在返回的 message 里（游戏自己改回样式、
     * 句柄失效、FFI 不可用……），渲染层原样展示即可。
     */
    toggleBorderless(sourceId: string): Promise<{ applied: boolean; message: string }>;
    /** 无边框化能力（FFI 是否就绪），false 时界面不显示按钮 */
    getBorderlessStatus(): Promise<{ available: boolean; detail: string }>;
  };
  server: {
    getStatus(): Promise<EmbeddedServerStatus>;
    setEnabled(enabled: boolean): Promise<EmbeddedServerStatus>;
    onStatus(callback: (status: EmbeddedServerStatus) => void): () => void;
  };
  tunnel: {
    getStatus(): Promise<TunnelStatus>;
    setEnabled(enabled: boolean): Promise<TunnelStatus>;
    onStatus(callback: (status: TunnelStatus) => void): () => void;
  };
  windowMode: {
    getStatus(): Promise<FloatWindowStatus>;
    setEnabled(enabled: boolean): Promise<FloatWindowStatus>;
    /** 只在浮窗模式下生效；非浮窗模式窗口恒为不透明 */
    setOpacity(opacity: number): Promise<FloatWindowStatus>;
    onStatus(callback: (status: FloatWindowStatus) => void): () => void;
    /**
     * 拖动 / 缩放浮窗。传的是目标左上角在屏幕上的坐标 / 目标客户区尺寸。
     *
     * 浮窗是 `setFocusable(false)` 的窗口，系统那套「拖标题栏、拉边框」都不成立，
     * 只能由渲染层算好坐标交给主进程 `setBounds`（只在浮窗模式下受理）。
     *
     * moveTo 的尺寸是**按下那一刻锁定的值**，主进程直接按它落 setBounds ——
     * 拖动全程窗口尺寸恒定，不读 getBounds()（避免缩放屏上的逐帧取整漂移）。
     */
    moveTo(x: number, y: number, width: number, height: number): void;
    resizeTo(width: number, height: number): void;
  };
  /**
   * 常规模式的窗口按钮（顶栏右上角那三个）。
   *
   * 主窗口是 `frame: false` 的 —— 原生标题栏在浮窗模式下拖不动，索性整个去掉
   * （见 main.ts 里 frame 那段），所以这三个按钮由界面自己画。
   */
  windowControl: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    /** 双击拖动区（系统行为）也会最大化，所以图标要听主进程的回报 */
    onMaximized(callback: (maximized: boolean) => void): () => void;
  };
  /**
   * 浮窗的拆分模式（每一路画面一个独立小窗）。
   *
   * 这一组基本都在为「帧泵」服务：小窗拿不到轨道（`MediaStreamTrack` 过不了进程边界），
   * 画面得由主窗口用 `createImageBitmap` 缩放后、经 MessagePort 的 transfer list
   * 搬过去 —— `ipcRenderer` 的结构化克隆搬不了 `ImageBitmap`。
   */
  floatTiles: {
    getStatus(): Promise<FloatTilesStatus>;
    setEnabled(enabled: boolean): Promise<FloatTilesStatus>;
    /**
     * 收起 / 展开那条控制条（缩成贴右下角的小球）。
     *
     * 界面**不能自己先切**成小球：窗口尺寸是主进程改的，先切会有一帧
     * 「小球画在一条 620x76 的窗口里」。等 `onStatus` 把 `barCollapsed` 推回来再切。
     */
    setBarCollapsed(collapsed: boolean): Promise<FloatTilesStatus>;
    /**
     * 上报「每个对端开一个窗」。顺序即位置：index 0 是第一个对端。
     *
     * `muted` 是**本机对那一路的静音状态**，小窗上的按钮照着它显示 ——
     * 不带的话小窗会一直写着「有声」，点一下反而会放开用户已经静音的那一路。
     */
    syncPeers(
      peers: Array<{ peerId: string; name: string; muted?: boolean }>,
    ): Promise<FloatTilesStatus>;
    onStatus(callback: (status: FloatTilesStatus) => void): () => void;
    /** meta 里带序号与对端身份（`peerId` / `name`，换人后是新值） */
    onTilePort(
      callback: (port: MessagePort, meta: { index: number; peerId: string; name: string }) => void,
    ): () => void;
    onTileSize(callback: (info: { index: number; width: number; height: number }) => void): () => void;
    /** 小窗上按了「静音这一路」—— 真正切静音的是主窗口（声音在那儿出） */
    onToggleMuteRequest(callback: (peerId: string) => void): () => void;
  };
}

declare global {
  interface Window {
    gameShare?: GameShareApi;
    /** 只在拆分模式的小窗里存在（由 electron/preload-tile.ts 挂上） */
    gameShareTile?: GameShareTileApi;
  }
}
