import { BrowserWindow, MessageChannelMain, app, ipcMain, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 浮窗的「拆分模式」：把每一路远端画面拆成一个独立的小窗。
 *
 * 需求方的原话是「默认在一个窗口，切换模式四个窗口可分开各自拖动放到想放的位置」，
 * 并明确「窗数 = 总人数 − 1」（4 人房 → 3 个窗，以后人多了一样是 N-1）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要这么绕：**MediaStreamTrack 过不了进程边界**
 *
 * 最理想的实现是每个小窗自己拿到那一路的 track、用 `<video>` 直接播 —— 零成本。
 * 但实测（`scripts/_probe-track-xfer.cjs`）：
 *
 *     DataCloneError: Value at index 0 does not have a transferable type.
 *
 * `MediaStreamTrack` 与 `MediaStream` 都不是可转移对象（Chromium 只在实验特性里支持）。
 * 所以每个小窗**拿不到媒体对象**，只能由主窗口把画面「搬」过去：
 *
 *     video（主窗口里放着，出声音）→ drawImage 缩放到小窗尺寸
 *       → createImageBitmap → MessagePort 转移 → 小窗 canvas 绘制
 *
 * 成本实测（`scripts/_probe-frame-pipe.cjs`，3 路 720p@30fps 并发）：
 * 三路都满 30fps、端到端延迟 2~3ms、主渲染进程 CPU 从 0.8% 涨到 3.2%。
 * 这是「只能这么做」，不是「这么做更好」。
 *
 * 三个必须认下来的代价：
 * 1. **声音留在主窗口**（音轨同样过不去）。所以拆分后主窗口不能关也不能最小化，
 *    会被收成一条贴着屏幕底部的窄控制条 —— 它就是这台机器的「声音 + 房间码」。
 * 2. **小窗里是 canvas 画的**，不是 `<video>`：拖大不会糊（每帧都从全分辨率重新缩放），
 *    但 video 元素自带的能力（右键菜单、系统控制条）都没有，得自绘。
 * 3. **每个小窗一个渲染进程**，内存各一份。本机同时开 4 个客户端做测试时，
 *    窗口数会变成 4×4 —— 这是调试期的代价，产品用法下只多 2~3 个。
 *
 * ---------------------------------------------------------------------------
 * 顺序与生命周期
 *
 * 拆分是**浮窗模式的子模式**：只有浮窗模式开着才允许拆。退出浮窗时这里会被收起
 * （`closeAllTiles()`，由 window-mode.ts 调用），否则会留下一堆无主的小窗。
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

/**
 * 小窗默认宽度。第一次拆出来的样子，之后用用户拖出来的。
 *
 * 高度按 16:9 **现算**（见 `defaultBounds`），刻意不存一个高度常量：
 * 屏幕窄的时候宽度会被压低，高度必须跟着走 —— 存一个固定高度的话两者迟早对不上，
 * 画面会被拉变形（而「不拉变形、宁可留黑边」是这条功能的明确取舍）。
 */
const TILE_WIDTH = 360;

/** 小窗最小尺寸：再小就看不清谁在干什么了 */
const TILE_MIN_WIDTH = 160;
const TILE_MIN_HEIGHT = 90;

/** 主窗口被收成的控制条尺寸 */
const BAR_WIDTH = 620;
const BAR_HEIGHT = 76;
const BAR_MARGIN = 16;

/**
 * 收起态：整条控制条缩成贴右下角的一小块（自绘的「悬浮球」）。
 *
 * 控制条 620x76 压在屏幕底部中央，玩游戏时正挡视线，而拆分模式下它**不能关** ——
 * 画面与声音都还在这个窗口里出。所以给它一个收起来的形态。
 *
 * 尺寸取「够放房间码 + 一眼看得出是个控件」。**再小就成了一颗纯色圆点**：
 * 说不出它是什么，用户下次也找不到它，那还不如不收。
 */
const BALL_WIDTH = 152;
const BALL_HEIGHT = 40;
const BALL_MARGIN = 16;

export interface TilePeer {
  peerId: string;
  name: string;
  /** 本机是否已把这一路静音 —— 小窗上的按钮要跟它一致，否则会说反话 */
  muted?: boolean;
}

export interface TileInfo {
  index: number;
  peerId: string;
  name: string;
  width: number;
  height: number;
}

export interface FloatTilesStatus {
  /** 是否处于拆分模式 */
  enabled: boolean;
  /** 控制条是否已收起成小球（渲染层按它决定画哪一态） */
  barCollapsed: boolean;
  /** 当前实际开着的每一个小窗（顺序即屏上顺序，index 即"第几个小窗"） */
  tiles: TileInfo[];
}

interface Tile {
  index: number;
  peerId: string;
  name: string;
  muted: boolean;
  win: BrowserWindow;
  /** 端口要在这里留一份引用：主进程不留，GC 会把通道收掉 */
  port: Electron.MessagePortMain | null;
}

const tiles = new Map<number, Tile>();

let enabled = false;
let wanted: TilePeer[] = [];
let opacity = 1;
let hostWindow: BrowserWindow | null = null;

/** 主窗口被收成控制条之前的几何，退出拆分时还回去 */
let hostRestoreBounds: Electron.Rectangle | null = null;

/** 控制条是否处于收起态（小球） */
let barCollapsed = false;

/**
 * 收起**之前**那条控制条在哪。
 *
 * 展开要回到**用户自己挪到的位置**，不是回到底部居中 —— 他会把这条拖到不挡视线的
 * 地方（控制条上那个把手就是干这个的），展开时把它弹回屏幕底部正中等于把他刚做的事抹掉。
 */
let hostExpandedBounds: Electron.Rectangle | null = null;

/* ------------------------------------------------------------------ *
 * 小窗位置与尺寸的持久化
 *
 * 单独一个文件，不跟 window-mode 的 float-window.json 混在一起：
 * 那份是「主窗口的浮窗长什么样」，这份是「第 N 个小窗在哪」，
 * 生命周期和归属都不同。同样零依赖（apps/desktop 的 dependencies 要保持为空）。
 * ------------------------------------------------------------------ */

function configPath(): string {
  return path.join(app.getPath('userData'), 'float-tiles.json');
}

/** 按序号记：peerId 每次进房都是新的，记 peerId 等于每次都失效 */
function loadSaved(): Array<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as { slots?: unknown };
    if (!Array.isArray(parsed.slots)) return [];
    return parsed.slots.map((slot): { x: number; y: number; width: number; height: number } | null => {
      if (!slot || typeof slot !== 'object') return null;
      const b = slot as Record<string, unknown>;
      /**
       * 逐个取值再逐个判类型。
       *
       * 别把判断攒成一个 boolean 再 `ok ? {...} : null` —— 类型收窄不跟着布尔变量走，
       * `b.x` 在 TS 眼里仍是 unknown，赋值出去就报错（这里踩过）。
       */
      const { x, y, width, height } = b;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        width <= 0 ||
        height <= 0
      ) {
        return null;
      }
      return { x, y, width, height };
    });
  } catch {
    return [];
  }
}

/**
 * 小窗位置存档，按序号排。**只替换元素、从不整体替换**，所以是 `const`
 * （`rememberBounds` 里那句 `slots[index] = ...` 是改元素，不是换数组）。
 */
const slots: Array<{ x: number; y: number; width: number; height: number } | null> = loadSaved();
let saveTimer: NodeJS.Timeout | null = null;

function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(path.dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), `${JSON.stringify({ slots }, null, 2)}\n`, 'utf8');
    } catch {
      // 写不进去只影响「下次记不记得」，不该影响使用
    }
  }, 400);
}

/**
 * 存档的位置可能落在已经不存在的显示器上（外接屏拔了、分辨率变了）。
 * 那种情况下窗口会出现在看不见的地方，比丢掉位置更糟。
 */
function isOnSomeDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      b.x < area.x + area.width &&
      b.x + b.width > area.x &&
      b.y < area.y + area.height &&
      b.y + b.height > area.y
    );
  });
}

/** 默认摆法：贴着主屏右边缘从上往下排，全屏游戏时最不碍事的一侧 */
function defaultBounds(index: number): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(TILE_WIDTH, Math.max(TILE_MIN_WIDTH, workArea.width - 40));
  const height = Math.round((width * 9) / 16);
  const step = height + 10;
  return {
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16 + index * step,
    width,
    height,
  };
}

function resolveBounds(index: number): { x: number; y: number; width: number; height: number } {
  const saved = slots[index];
  if (saved && isOnSomeDisplay(saved)) return saved;
  return defaultBounds(index);
}

function rememberBounds(index: number, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const b = win.getBounds();
  slots[index] = { x: b.x, y: b.y, width: b.width, height: b.height };
  persistSoon();
}

/* ------------------------------------------------------------------ *
 * 与小窗页面之间的通道
 *
 * 一条小窗 = 一条独立的 MessageChannelMain。为什么不用 ipcRenderer.send：
 * **ImageBitmap 走不了结构化克隆的 IPC**，只有 MessagePort 的 transfer list 能零拷贝搬。
 * ------------------------------------------------------------------ */

function connectTile(tile: Tile): void {
  if (!hostWindow || hostWindow.isDestroyed() || tile.win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  tile.port = port1;

  /**
   * 通道的 meta 必须带上**对端身份**，不能只带序号。
   *
   * 小窗页面不知道「我现在是谁」—— 它的名字和「静音这一路」要用的 peerId 都来自
   * 建窗那一刻的 URL 参数，而**换人时不会重新导航**（见 syncTiles：重建窗口会闪）。
   * 身份就靠这条通道送过去：换人时 syncTiles 会重连通道，页面顺着这次重连拿到新身份。
   * 少了 name 的后果是「窗里换人了，悬浮条还挂着上一个人的名字」。
   */
  const meta = { index: tile.index, peerId: tile.peerId, name: tile.name };

  // 主窗口那侧是「帧泵」：拿到 port 就开始按源节奏往里灌画面
  hostWindow.webContents.postMessage('float:tile-port', meta, [port1]);
  // 小窗那侧拿到 port 就开始画，同时更新自己的身份
  tile.win.webContents.postMessage('float:tile-port', meta, [port2]);
}

function notifyHost(channel: string, payload: unknown): void {
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send(channel, payload);
}

function status(): FloatTilesStatus {
  return {
    enabled,
    /**
     * 控制条收起了没有。渲染层要靠它决定画「一条控制条」还是「一颗小球」——
     * 页面里没有别的来源能知道这件事（窗口尺寸在两种形态下都合法）。
     */
    barCollapsed,
    tiles: [...tiles.values()]
      .sort((a, b) => a.index - b.index)
      .map((tile) => {
        const b = tile.win.isDestroyed() ? null : tile.win.getBounds();
        return {
          index: tile.index,
          peerId: tile.peerId,
          name: tile.name,
          width: b?.width ?? 0,
          height: b?.height ?? 0,
        };
      }),
  };
}

/**
 * 拆分开关变化时的通知口，由 `window-mode.ts` 注册。
 *
 * 不能直接 import window-mode：那边已经 import 了本模块，互相引用会成环。
 */
let onTilesChanged: (() => void) | null = null;

export function setTilesChangeListener(fn: (() => void) | null): void {
  onTilesChanged = fn;
}

/**
 * 广播小窗状态。
 *
 * **只有这一个函数需要挂通知口** —— 小窗清单的每一种变化（开关、增删、被用户关掉）
 * 最后都会走到这里，所以在末尾回调一次就覆盖全了。
 */
function broadcast(): void {
  notifyHost('float:tiles-status', status());
  /**
   * 顺手让 window-mode 把 `float:status` 重播一次。
   *
   * 不这么做的话 `FloatWindowStatus.tilesEnabled` 会**停在「上一次浮窗状态变化时」
   * 那个值** —— 用户点了「拆成 3 个小窗」，浮窗状态里却还写着没拆。
   * 一个会说谎的状态字段比没有这个字段更糟（当初就是为了让界面少一次推导才加它的）。
   */
  if (onTilesChanged) onTilesChanged();
}

/* ------------------------------------------------------------------ *
 * 建窗 / 收窗
 * ------------------------------------------------------------------ */

function tileUrl(index: number, peer: TilePeer): string {
  // muted 走 URL 是给小窗的**初始**状态：它拿不到主窗口的内存状态，
  // 不带上就会先显示成「有声」再被推过来的 IPC 纠正，看起来像跳了一下
  const query = `floatTile=${index}&peer=${encodeURIComponent(peer.peerId)}&name=${encodeURIComponent(
    peer.name,
  )}&muted=${peer.muted ? 1 : 0}`;
  if (isDev && DEV_SERVER_URL) {
    const base = DEV_SERVER_URL.endsWith('/') ? DEV_SERVER_URL : `${DEV_SERVER_URL}/`;
    return `${base}?${query}`;
  }
  return query;
}

function createTile(index: number, peer: TilePeer): Tile {
  const bounds = resolveBounds(index);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: TILE_MIN_WIDTH,
    minHeight: TILE_MIN_HEIGHT,
    // 只留画面：不画标题栏，也不给系统边框（缩放由自绘手柄走 IPC 完成）。
    // 为什么不用 `transparent: true`：Windows 上透明窗口的 resize 有已知问题，
    // 而「能自由拖大小」是这个功能的硬指标（ARCHITECTURE.md 4.13 有记录）。
    frame: false,
    thickFrame: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#000000',
    title: `GameShare · ${peer.name}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload-tile.cjs'),
      /**
       * **必须关掉上下文隔离**。
       *
       * 小窗要靠 MessagePort 收 ImageBitmap，而 `contextBridge` 传不了 DOM 对象
       * （它只支持可序列化的值）—— 隔离开着的话，preload 拿到了 port 却交不出去。
       * 关掉之后 preload 与页面同处一个上下文，直接把 port 挂到 window 上即可。
       * 代价可控：小窗加载的是我们自己的本地页面，不含任何外部内容，
       * 也拿不到 Node（nodeIntegration 仍为 false）。
       */
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const tile: Tile = {
    index,
    peerId: peer.peerId,
    name: peer.name,
    muted: peer.muted === true,
    win,
    port: null,
  };

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    // 不可聚焦：碰它不会把焦点从游戏里抢走（与主浮窗同一条理由，见 window-mode.ts）
    win.setFocusable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setOpacity(opacity);
    win.showInactive();
  });

  // 页面每次加载完（含热更新重载）都要重建通道，否则帧泵还在往一个死端口灌
  win.webContents.on('did-finish-load', () => connectTile(tile));

  win.on('resize', () => {
    rememberBounds(index, win);
    // 帧泵按小窗的实际像素尺寸缩放，尺寸一变必须告诉主窗口，
    // 否则画面要么被拉伸要么留黑边
    if (!win.isDestroyed()) {
      const b = win.getBounds();
      notifyHost('float:tile-size', { index, width: b.width, height: b.height });
    }
  });
  win.on('move', () => rememberBounds(index, win));

  win.on('closed', () => {
    tiles.delete(index);
    broadcast();
  });

  if (isDev) {
    void win.loadURL(tileUrl(index, peer));
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: {
        floatTile: String(index),
        peer: peer.peerId,
        name: peer.name,
        muted: peer.muted ? '1' : '0',
      },
    });
  }

  return tile;
}

/**
 * 按渲染层报上来的对端列表对齐小窗。
 *
 * 顺序即位置：index 0 是第一个对端，以此类推。列表变短就关掉多余的，
 * 变长就补新的；同一位置上换了人（peerId 变了）不重建窗口 —— 那样会丢掉
 * 用户拖出来的位置，只把 peerId / 名字换掉并重连通道。
 */
function syncTiles(next: TilePeer[]): FloatTilesStatus {
  wanted = next;
  if (!enabled) return status();

  // 关掉超出的
  for (const [index, tile] of [...tiles.entries()]) {
    if (index >= next.length) {
      if (!tile.win.isDestroyed()) tile.win.destroy();
      tiles.delete(index);
    }
  }

  // 建缺的 / 更新换人的
  next.forEach((peer, index) => {
    const existing = tiles.get(index);
    if (!existing) {
      tiles.set(index, createTile(index, peer));
      return;
    }
    if (existing.peerId !== peer.peerId) {
      existing.peerId = peer.peerId;
      existing.name = peer.name;
      /**
       * 换人**不重建窗口**。
       *
       * 理由是「重建会闪一下」—— 用户看到的是一整格画面瞬间消失又出现。
       * 位置本身**不是**理由：`slots` 是按序号存的，重建也回得来。
       *
       * 但**页面不会自己知道换了人**（它不重新导航），所以新身份得靠重连通道带过去
       * （见 `connectTile` 的 meta）。通道本来就必须重接 —— 帧泵那头是按序号对应的。
       */
      connectTile(existing);
    }
    const muted = peer.muted === true;
    if (existing.muted !== muted) {
      existing.muted = muted;
      if (!existing.win.isDestroyed()) existing.win.webContents.send('float:tile-muted', muted);
    }
  });

  broadcast();
  return status();
}

/**
 * 浮窗模式那一档的最小尺寸，**必须与 window-mode.ts 的 `FLOAT_MIN_WIDTH/HEIGHT` 一致**。
 *
 * 刻意各存一份而不是从 window-mode 引过来：**那边已经 import 了本模块**，
 * 反向 import 会成环（同 `onTilesChanged` 那段注释的理由）。改一边要改另一边，
 * `npm run check:tiles` 里钉了一条断言盯着这两个数。
 */
const HOST_FLOAT_MIN_WIDTH = 260;
const HOST_FLOAT_MIN_HEIGHT = 150;

/** 控制条展开态的几何：贴底居中，窄屏时跟着收窄 */
function expandedBarBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(BAR_WIDTH, Math.max(320, workArea.width - 40));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + workArea.height - BAR_HEIGHT - BAR_MARGIN,
    width,
    height: BAR_HEIGHT,
  };
}

/**
 * 收起态的几何：贴屏幕**右下角**。
 *
 * 用 `workArea` 而不是屏幕 `bounds` —— 任务栏在底下，`bounds` 会让小球压到任务栏下面去。
 * 挑右下角是因为那是悬浮球的老位置，用户不用找。
 */
function ballBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - BALL_WIDTH - BALL_MARGIN,
    y: workArea.y + workArea.height - BALL_HEIGHT - BALL_MARGIN,
    width: BALL_WIDTH,
    height: BALL_HEIGHT,
  };
}

/** 主窗口收成一条窄控制条：它就是「声音 + 房间码 + 合并按钮」 */
function collapseHost(): void {
  const win = hostWindow;
  if (!win || win.isDestroyed()) return;
  if (!hostRestoreBounds) hostRestoreBounds = win.getBounds();

  barCollapsed = false;
  hostExpandedBounds = null;

  const bar = expandedBarBounds();

  /**
   * **先把下限放到这条控制条的高度，再落 bounds —— 顺序不能反。**
   *
   * 主窗口这时还带着浮窗那一档的下限（260x150，`enterFloat` 设的），
   * 于是 `height: BAR_HEIGHT`（76）会被**静默夹回 150**：窗口比设计的高一倍，
   * 控件垂直居中，控件下面空出一大块同色黑边 —— 看着像「这窗口坏了 / 拖不动」，
   * 实际是尺寸被夹住了（2026-09-17 实测截图：620x150，不是 620x76）。
   *
   * 夹的动作不报错、`getBounds()` 也只有主动去问才看得出来，所以上一批的
   * `check:tiles` 没接住它 —— 那一组的拆分是单独跑在空白页上的，
   * **从没在「浮窗已经开着」的窗口上拆过**，而这两档下限只在那种情形下才打架。
   *
   * 第十一批又加了第三档（小球 152x40），同一个坑要防三次：收起时 40 高会被 76 夹、
   * 152 宽会被 620 夹 —— 所以 `setBarCollapsed` 里也是「先 setMinimumSize 再 setBounds」。
   */
  win.setMinimumSize(bar.width, BAR_HEIGHT);
  win.setBounds(bar);
}

/**
 * 收起 / 展开那条控制条（界面上那颗「悬浮球」）。
 *
 * **三档最小尺寸在同一扇窗口上轮着来**：浮窗 260x150 → 控制条 620x76 → 小球 152x40。
 * 每次 `setBounds` 之前必须先把下限放到**这一档要的尺寸**，否则新尺寸会被上一档静默夹住
 * （小球要 40 高被 76 夹、要 152 宽被 620 夹），而夹的动作不报错、只有 `getBounds()` 看得出来。
 */
export function setBarCollapsed(next: boolean): FloatTilesStatus {
  const win = hostWindow;
  if (!win || win.isDestroyed() || !enabled) return status();
  if (next === barCollapsed) return status();

  barCollapsed = next;

  if (next) {
    hostExpandedBounds = win.getBounds();
    win.setMinimumSize(BALL_WIDTH, BALL_HEIGHT);
    win.setBounds(ballBounds());
  } else {
    const previous = hostExpandedBounds ?? expandedBarBounds();
    win.setMinimumSize(previous.width, BAR_HEIGHT);
    win.setBounds(previous);
    hostExpandedBounds = null;
  }

  broadcast();
  return status();
}

function restoreHost(): void {
  const win = hostWindow;
  if (!win || win.isDestroyed() || !hostRestoreBounds) return;
  // 下限还回浮窗那一档：合并之后窗口又该能被拖成任意浮窗尺寸了
  win.setMinimumSize(HOST_FLOAT_MIN_WIDTH, HOST_FLOAT_MIN_HEIGHT);
  win.setBounds(hostRestoreBounds);
  hostRestoreBounds = null;
  // 收起态是拆分模式里的东西，退出拆分时一并清掉（下次进来是展开的控制条）
  barCollapsed = false;
  hostExpandedBounds = null;
}

export function setTilesEnabled(next: boolean): FloatTilesStatus {
  if (next === enabled) return status();
  enabled = next;

  if (enabled) {
    collapseHost();
    syncTiles(wanted);
  } else {
    for (const tile of tiles.values()) {
      if (!tile.win.isDestroyed()) tile.win.destroy();
    }
    tiles.clear();
    restoreHost();
    broadcast();
  }

  return status();
}

/** 退出浮窗时调用：拆分是浮窗的子模式，浮窗没了小窗不能留 */
export function closeAllTiles(): void {
  if (!enabled && tiles.size === 0) return;
  enabled = false;
  for (const tile of tiles.values()) {
    if (!tile.win.isDestroyed()) tile.win.destroy();
  }
  tiles.clear();
  restoreHost();
  broadcast();
}

export function getTilesEnabled(): boolean {
  return enabled;
}

/** 主浮窗的 topmost 保活顺带把小窗也重断言一遍（它们同样是 topmost 带的成员） */
export function keepAliveTiles(): void {
  for (const tile of tiles.values()) {
    const win = tile.win;
    if (win.isDestroyed() || win.isMinimized() || !win.isVisible()) continue;
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

/** 透明度由浮窗统一管：小窗跟着一起变，不然一排小窗里有个别是实心的很怪 */
export function setTilesOpacity(value: number): void {
  opacity = value;
  for (const tile of tiles.values()) {
    if (!tile.win.isDestroyed()) tile.win.setOpacity(value);
  }
}

export function setTilesHostWindow(win: BrowserWindow): void {
  hostWindow = win;
  win.on('closed', () => {
    hostWindow = null;
    // 主窗口都没了，小窗不能留着 —— 否则进程退不掉（window-all-closed 不会触发）
    for (const tile of tiles.values()) {
      if (!tile.win.isDestroyed()) tile.win.destroy();
    }
    tiles.clear();
    enabled = false;
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function isHost(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return Boolean(hostWindow) && event.sender === hostWindow?.webContents;
}

export function registerFloatTilesHandlers(): void {
  ipcMain.handle('float:get-tiles-status', () => status());

  ipcMain.handle('float:set-tiles-enabled', (_event, value: unknown) =>
    setTilesEnabled(value === true),
  );

  // 收起 / 展开那条控制条（小球形态）。同样只认主窗口 —— 小窗手里也有 ipcRenderer
  ipcMain.handle('float:set-bar-collapsed', (event, value: unknown) => {
    if (!isHost(event)) return status();
    return setBarCollapsed(value === true);
  });

  ipcMain.handle('float:sync-tiles', (event, list: unknown) => {
    // 只认主窗口 —— 小窗也握着 ipcRenderer，不能让它改主窗口的状态
    if (!isHost(event)) return status();
    if (!Array.isArray(list)) return status();
    const peers: TilePeer[] = list
      .filter((item): item is TilePeer => {
        if (!item || typeof item !== 'object') return false;
        const p = item as Record<string, unknown>;
        return typeof p.peerId === 'string' && p.peerId.length > 0;
      })
      /**
       * `muted` **必须一起接住**。
       *
       * 早先这里只挑 peerId / name，把静音状态整个丢掉 —— 于是小窗上的按钮
       * 永远不跟着本机的实际状态走：用户在主窗口静音了某一路，小窗上仍写着「有声」；
       * 再点一下小窗的按钮，反而把这一路的声音放出来了（静音被「取消」）。
       */
      .map((item) => ({
        peerId: item.peerId,
        name: typeof item.name === 'string' ? item.name : item.peerId,
        muted: item.muted === true,
      }));
    return syncTiles(peers);
  });

  /* --------- 小窗自己的操作（拖动 / 缩放 / 静音） --------- */

  /**
   * 拖动与缩放走 IPC 而不是 `-webkit-app-region: drag`。
   *
   * 理由：小窗是 `setFocusable(false)` 的（不可激活），而系统的非客户区拖动 /
   * 边框缩放都会先把窗口激活 —— 一拖就把游戏搞失焦，等于把浮窗那轮好不容易
   * 修掉的毛病又请回来。自己算坐标再 `setBounds` 与激活无关，行为确定。
   */
  ipcMain.on('float:tile-move-to', (event, payload: unknown) => {
    const tile = [...tiles.values()].find((t) => t.win.webContents === event.sender);
    if (!tile || tile.win.isDestroyed()) return;
    if (!payload || typeof payload !== 'object') return;
    const { x, y, width, height } = payload as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof x !== 'number' || typeof y !== 'number') return;
    // 尺寸用渲染层锁定的值，不展开 getBounds() —— 与主窗口 float:move-to 同一条
    // 理由：非 100% 缩放屏上逐帧往返的取整误差会累积成「拖动时小窗变大」。
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      return;
    }
    tile.win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  });

  ipcMain.on('float:tile-resize-to', (event, payload: unknown) => {
    const tile = [...tiles.values()].find((t) => t.win.webContents === event.sender);
    if (!tile || tile.win.isDestroyed()) return;
    if (!payload || typeof payload !== 'object') return;
    const { width, height } = payload as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number') return;
    tile.win.setBounds({
      ...tile.win.getBounds(),
      width: Math.max(TILE_MIN_WIDTH, Math.round(width)),
      height: Math.max(TILE_MIN_HEIGHT, Math.round(height)),
    });
  });

  /**
   * 小窗上的「静音这一路」。
   *
   * 声音其实在**主窗口**里出（音轨过不去），所以小窗只是按个开关：
   * 把请求转给主窗口的渲染层，由它去切自己那个 `<video>.muted`。
   * 静音是纯本机状态、不发信令 —— 这条与单窗口时完全一致（ARCHITECTURE.md 4.10）。
   */
  ipcMain.on('float:tile-toggle-mute', (event, peerId: unknown) => {
    const tile = [...tiles.values()].find((t) => t.win.webContents === event.sender);
    if (!tile || typeof peerId !== 'string') return;
    notifyHost('float:tile-toggle-mute', peerId);
  });

  /** 小窗上报自己的画面尺寸，帧泵按它缩放 —— 免得拖大之后画面糊/留黑边 */
  ipcMain.on('float:tile-size', (event, payload: unknown) => {
    const tile = [...tiles.values()].find((t) => t.win.webContents === event.sender);
    if (!tile) return;
    if (!payload || typeof payload !== 'object') return;
    const { width, height } = payload as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number') return;
    notifyHost('float:tile-size', { index: tile.index, width, height });
  });

  app.on('before-quit', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        mkdirSync(path.dirname(configPath()), { recursive: true });
        writeFileSync(configPath(), `${JSON.stringify({ slots }, null, 2)}\n`, 'utf8');
      } catch {
        // 退出路径上不再报错
      }
    }
  });
}
