import { BrowserWindow, app, globalShortcut, ipcMain, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  closeAllTiles,
  getTilesEnabled,
  keepAliveTiles,
  setTilesChangeListener,
  setTilesOpacity,
} from './float-tiles';

/**
 * 拆分开关一变，浮窗状态里的 `tilesEnabled` 也跟着变了，必须重播一次。
 *
 * 注册放在**模块顶层**而不是 `registerWindowModeHandlers` 里：模块只加载一次，
 * 这里注册一次就够；而且 `broadcast` 就在下面几十行，两者是一件事，
 * 没必要让它们隔着几百行互相找。
 *
 * （`broadcast` 是函数声明，提升过，所以这个箭头函数之后才执行也没问题。）
 */
setTilesChangeListener(() => broadcast());

/**
 * 浮窗模式。
 *
 * 场景是「全屏玩游戏，同时瞄一眼好友的画面」。它和普通的「置顶」不是一回事，
 * 一次要动五样东西，所以做成了一个整体状态而不是几个独立开关。
 *
 * 它有两种**形态**：
 * - **合并（默认）**：所有画面摆在这一个窗口里，窗口可缩可拖、可调透明度。
 * - **拆分**：每一路画面变成一个独立的小窗，各自拖动、各自缩放、各自置顶
 *   （窗数 = 总人数 − 1）。实现在 `float-tiles.ts`，拆分是浮窗的子模式 ——
 *   退出浮窗时小窗会被一起收掉。
 *
 * 下面五条是「浮窗」这个状态本身要动的东西：
 *
 * 1. **放开窗口最小尺寸**。常规模式写着 `minWidth: 1024, minHeight: 640`
 *    （`main.ts` 创建窗口时定的），浮窗要缩到几百像素 —— 不临时放宽就压不下去。
 * 2. **进出时换一套窗口几何**。进浮窗记住当前 bounds 并换成浮窗尺寸，
 *    退出时原样还回去；否则用户用完浮窗，主窗口就永远停在那个小尺寸上了。
 * 3. **真置顶**。`setAlwaysOnTop(_, 'screen-saver')` 落到 `HWND_TOPMOST`
 *    （`level` 参数在 Windows 上同样有效，`pop-up-menu` 及以上会显示在任务栏之上），
 *    另外配一个 300ms 的保活，防止别的 topmost 角色把浮窗挤到下面 ——
 *    **最常见的那个「别的角色」就是游戏自己**（不少游戏全屏时也给自己设 topmost，
 *    它一被激活就把浮窗压到带内下方，用户看到的就是「点回游戏，浮窗掉下去了」）。
 *    **盖得住无边框 / 合成型全屏，盖不住独占全屏（DXGI FSE）** —— 那种模式下 DWM
 *    让出合成权，任何普通窗口都盖不住。Steam / Discord 的 overlay 能显示在独占全屏上，
 *    靠的是往游戏进程里注入 DLL —— 我们不做注入，且会撞反作弊（见 ARCHITECTURE.md 4.13）。
 *    已用 `npm run check:topmost` 验过前两档，含「游戏也置顶」的同带竞争场景。
 * 4. **透明度**。**只能用 `win.setOpacity()`，不能用 `transparent: true`。**
 *    后者在 Windows 上会跟「自由缩放」打架（透明窗口的 resize 有已知问题），
 *    而自由缩放正是这个功能的第二诉求。代价是画面本身也会一起变淡，这是明说的取舍。
 * 5. **绝不抢游戏的焦点**。浮窗模式下把窗口设成 `setFocusable(false)`，
 *    也就是一个「点它也不会被激活」的窗口。实测：可聚焦时一次 `focus()` 就能把
 *    焦点从游戏里夺走，游戏随即收不到键鼠（多数单机还会弹暂停），
 *    用户看到的就是「调出浮窗之后游戏不能操控了」；设成不可聚焦之后同一个调用抢不动。
 *    **退出浮窗时必须恢复 `setFocusable(true)`**，否则常规界面再也拿不到焦点。
 *    连带影响：不可激活的窗口通常也不再出现在任务栏 / Alt+Tab 里，
 *    浮窗期间任务栏图标消失属正常（这条没单独实测）。
 *
 * 快捷键必须全局：全屏游戏里鼠标在游戏里，点不到我们的界面；窗口级快捷键
 * 在窗口不聚焦时也收不到按键。多开客户端时同一个快捷键只有**第一个**实例能注册成功
 * （系统只允许一个），所以把 `hotkeyAvailable` 一并报给界面 —— 没抢到的那个窗口
 * 至少还能用界面上的开关，而且要如实告诉用户为什么快捷键没反应。
 */

const HOTKEY = 'Control+Alt+G';

/** 浮窗模式下的最小尺寸：1 格画面时也够看 */
const FLOAT_MIN_WIDTH = 260;
const FLOAT_MIN_HEIGHT = 150;

/** 常规模式的最小尺寸，必须与 main.ts 里创建窗口时写的一致 */
const NORMAL_MIN_WIDTH = 1024;
const NORMAL_MIN_HEIGHT = 640;

/** 第一次进浮窗时的默认尺寸（16:9），之后用用户自己拖出来的尺寸 */
const DEFAULT_FLOAT_WIDTH = 520;

/** 默认落点距屏幕右下角的留白 */
const DEFAULT_FLOAT_MARGIN = 24;

export const MIN_OPACITY = 0.3;
export const MAX_OPACITY = 1;

export interface FloatWindowStatus {
  /** 是否处于浮窗模式 */
  enabled: boolean;
  /**
   * 是否处于**拆分**模式（每一路画面一个独立小窗，见 `float-tiles.ts`）。
   * 只有浮窗模式开着时才可能为真 —— 拆分是浮窗的子模式。
   */
  tilesEnabled: boolean;
  /** 浮窗模式下的不透明度（0.3~1）。非浮窗模式下窗口恒为 1 */
  opacity: number;
  minOpacity: number;
  /** 全局快捷键在本进程是否注册成功（多开时会有一个抢不到） */
  hotkeyAvailable: boolean;
  hotkey: string;
}

interface FloatBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Persisted {
  opacity: number;
  /** 用户上一次拖出来的浮窗位置与尺寸 */
  bounds: FloatBounds | null;
}

const DEFAULT_PERSISTED: Persisted = { opacity: 0.9, bounds: null };

let enabled = false;
let opacity = DEFAULT_PERSISTED.opacity;
let hotkeyAvailable = false;

/** 进入浮窗前的窗口几何，退出时还回去；只在浮窗期间有值 */
let restoreBounds: FloatBounds | null = null;
let restoreMaximized = false;

/** 用户拖出来的浮窗几何，退出浮窗时写回磁盘 */
let floatBounds: FloatBounds | null = null;

let persisted: Persisted | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/* ------------------------------------------------------------------ *
 * 持久化
 *
 * 写在 userData 下的一个 JSON 里，不引任何依赖（`apps/desktop` 的
 * dependencies 要保持为空，见 MEMORY.md 代码约定）。
 * **多开客户端时几个实例共用同一份** —— 浮窗尺寸本来就该是「这台机器上
 * 的小窗长什么样」，共用是符合直觉的，代价是几个实例会互相覆盖。
 * ------------------------------------------------------------------ */

function configPath(): string {
  return path.join(app.getPath('userData'), 'float-window.json');
}

function loadPersisted(): Persisted {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      opacity:
        typeof parsed.opacity === 'number' && Number.isFinite(parsed.opacity)
          ? clampOpacity(parsed.opacity)
          : DEFAULT_PERSISTED.opacity,
      bounds: isBounds(parsed.bounds) ? parsed.bounds : null,
    };
  } catch {
    // 首次运行 / 文件被删 / 内容坏了 —— 都退回默认值，不值得报错打扰用户
    return { ...DEFAULT_PERSISTED };
  }
}

function getPersisted(): Persisted {
  persisted ??= loadPersisted();
  return persisted;
}

function isBounds(value: unknown): value is FloatBounds {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.x === 'number' &&
    typeof b.y === 'number' &&
    typeof b.width === 'number' &&
    typeof b.height === 'number' &&
    b.width > 0 &&
    b.height > 0
  );
}

function persistNow(): void {
  const next: Persisted = { opacity, bounds: floatBounds };
  persisted = next;
  try {
    mkdirSync(path.dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // 写不进去也不该影响使用（只影响「下次还记不记得」）
  }
}

/** 拖动/缩放窗口时会连续触发，攒一下再写盘 */
function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 400);
}

/* ------------------------------------------------------------------ *
 * 窗口几何
 * ------------------------------------------------------------------ */

function clampOpacity(value: number): number {
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value));
}

/**
 * 保存下来的浮窗位置可能落在已经不存在的显示器上（外接屏拔了、分辨率变了）。
 * 那种情况下窗口会出现在看不见的地方，比丢掉位置更糟，所以校验一下。
 */
function isOnSomeDisplay(bounds: FloatBounds): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

/** 默认贴右下角：全屏游戏时最不碍事的位置，也是用户拖过一次后最常放的地方 */
function defaultFloatBounds(): FloatBounds {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(DEFAULT_FLOAT_WIDTH, workArea.width);
  const height = Math.round((width * 9) / 16);
  return {
    x: workArea.x + workArea.width - width - DEFAULT_FLOAT_MARGIN,
    y: workArea.y + workArea.height - height - DEFAULT_FLOAT_MARGIN,
    width,
    height,
  };
}

function resolveFloatBounds(): FloatBounds {
  const saved = getPersisted().bounds;
  if (saved && isOnSomeDisplay(saved)) return saved;
  return defaultFloatBounds();
}

/**
 * 主窗口的引用。
 *
 * **不能再用 `getAllWindows()[0]`。** 拆分模式会额外开出若干个小窗，
 * 数组首位完全可能是其中一个 —— 那样 `enterFloat` / `exitFloat` 就会去动错窗口，
 * 用户按一下快捷键的结果是「某个小窗被放大成工作区尺寸」。
 * 所以由 `main.ts` 在创建主窗口时显式注册进来。
 */
let hostWindow: BrowserWindow | null = null;

export function setPrimaryWindow(win: BrowserWindow): void {
  hostWindow = win;
  win.on('closed', () => {
    if (hostWindow === win) hostWindow = null;
  });
}

/** 本项目只有这一个「主」窗口；小窗不算，它们由 float-tiles.ts 自己管 */
function primaryWindow(): BrowserWindow | null {
  return hostWindow && !hostWindow.isDestroyed() ? hostWindow : null;
}

/* ------------------------------------------------------------------ *
 * 状态应用
 * ------------------------------------------------------------------ */

function applyAlwaysOnTop(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setAlwaysOnTop(enabled, 'screen-saver');
  }
}

/**
 * topmost 保活的间隔。
 *
 * **300ms 不是拍的。** 2026-09-17 实测（`npm run check:topmost` 的同带竞争组）：
 * 游戏自己也置顶时，两者同处 topmost 带，而**游戏一被激活**（就是用户点回游戏那一下）
 * 就会把自己抬到带内最上面 —— 浮窗被压下去。1.5 秒的保活意味着「掉下去 → 抬回来」
 * 中间有肉眼可见的一秒多；300ms 时用户察觉不到。再快没有意义，反而增加消息量。
 */
const TOPMOST_KEEPALIVE_MS = 300;
let keepAliveTimer: NodeJS.Timeout | null = null;

/**
 * 重断言置顶 —— 把浮窗夺回 topmost 带的最上面。
 *
 * 为什么需要：Windows 的 topmost 是一个**带**，带内谁在上面取决于谁最后一次
 * `SetWindowPos`。而**不少游戏自己也置顶**，它拿回前台时会顺手把自己抬到带内最上面，
 * 我们的浮窗就被压下去了。所以定期把自己夺回来。
 *
 * 用 `setAlwaysOnTop(true, 'screen-saver')` 而不是 `showInactive()`：实测四种
 * 「抬回来」的招里，重断言 / `moveTop()` / 「先关再开」这三种都有效，
 * **只有 `showInactive()` 抬不动**（它只负责显隐，不碰 z-order）。
 * 三种有效的招都不会把焦点从游戏里抢走（同样实测过）。
 *
 * 跳过条件：已销毁、已最小化、或不可见。
 * **注意别再拿 `isFocused()` 当「用户正在操作」的判据** —— 浮窗模式下窗口是
 * `setFocusable(false)` 的，`isFocused()` 恒为 false（见文件头第 5 条）。
 */
function startTopmostKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    const win = primaryWindow();
    if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) {
      // 主窗口不可用也要继续 —— 拆分模式下真正在看的是小窗，它们同样在 topmost 带里
      keepAliveTiles();
      return;
    }
    win.setAlwaysOnTop(true, 'screen-saver');
    // 小窗和主浮窗处于同一个 topmost 带，照样会被游戏挤下去，一起重断言
    keepAliveTiles();
  }, TOPMOST_KEEPALIVE_MS);
}

function stopTopmostKeepAlive(): void {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/**
 * 非浮窗模式恒为 1 —— 用户设的不透明度是「浮窗的」属性，
 * 退出浮窗不该让正常窗口也变成半透明。
 *
 * 小窗也在这里同步：它们虽然在 `getAllWindows()` 里能一起设到，
 * 但 `float-tiles` 内部要记住当前值，**新建的小窗才能在出生那一刻就带上正确的透明度**
 * （否则会先实心闪一下再变淡）。
 */
function applyOpacity(): void {
  const value = enabled ? opacity : 1;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setOpacity(value);
  }
  setTilesOpacity(value);
}

function status(): FloatWindowStatus {
  return {
    enabled,
    tilesEnabled: getTilesEnabled(),
    opacity,
    minOpacity: MIN_OPACITY,
    hotkeyAvailable,
    hotkey: HOTKEY,
  };
}

function broadcast(): void {
  const payload = status();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('float:status', payload);
  }
}

function enterFloat(win: BrowserWindow): void {
  // 第一步就放开「可聚焦」：变成不可激活的窗口，之后不管怎么动它都夺不走游戏的焦点。
  // 这是「游戏不能被操控」的根治手段 —— 实测（check:topmost 的焦点保护组）：
  // 可聚焦时一次 `focus()` 就能把焦点从游戏抢走（游戏随即收不到键鼠，多数单机还会弹暂停），
  // 设成不可聚焦之后同一个调用抢不动。
  win.setFocusable(false);

  // 最小化的窗口 setBounds 是无效的（尺寸会落回还原尺寸），先还原。
  // 用 showInactive 而不是 restore：后者会连带激活窗口，把焦点从游戏抢走。
  // check:topmost 验过 showInactive 能还原最小化窗口、且还原后置顶还在。
  if (win.isMinimized()) win.showInactive();

  restoreMaximized = win.isMaximized();
  // 最大化的窗口直接 setBounds 是无效的，得先还原
  if (restoreMaximized) win.unmaximize();
  restoreBounds = win.getBounds();

  // 顺序不能反：先放宽下限，小尺寸才落得下去
  win.setMinimumSize(FLOAT_MIN_WIDTH, FLOAT_MIN_HEIGHT);
  win.setBounds(resolveFloatBounds());
}

function exitFloat(win: BrowserWindow): void {
  // 恢复可聚焦**必须做**：否则回到常规模式后窗口永远拿不到焦点，
  // 房间码输不进去、按钮点了没反应 —— 比不置顶严重得多。
  win.setFocusable(true);

  // 顺序同样不能反：先把下限还回常规档，否则大尺寸会被浮窗的下限卡住
  win.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);
  if (restoreBounds) {
    win.setBounds(restoreBounds);
    restoreBounds = null;
  }
  if (restoreMaximized) {
    win.maximize();
    restoreMaximized = false;
  }
}

export function setFloatEnabled(next: boolean): FloatWindowStatus {
  if (next === enabled) return status();
  enabled = next;

  const win = primaryWindow();
  if (win) {
    if (enabled) {
      enterFloat(win);
    } else {
      /**
       * 顺序不能反：**先收小窗，再恢复主窗口几何**。
       *
       * 拆分模式把主窗口收成了一条贴底的控制条（那是 float-tiles 自己记的 bounds），
       * 而 exitFloat 记的是「进浮窗之前」的常规几何 —— 两套记录各管各的，
       * 但必须先让 float-tiles 把小窗清干净，否则会留下一堆无主的小窗：
       * 它们既是 topmost 又不可聚焦，用户只能去任务管理器里杀进程。
       */
      closeAllTiles();
      exitFloat(win);
    }
  }

  if (enabled) startTopmostKeepAlive();
  else stopTopmostKeepAlive();

  applyAlwaysOnTop();
  applyOpacity();
  broadcast();
  if (!enabled) persistNow();
  return status();
}

/**
 * 全局快捷键的语义。
 *
 * 有一条特例：浮窗模式下窗口**被最小化**时，这一下的意思是「把浮窗叫回来」，
 * 不是「退出浮窗模式」—— 否则用户按了快捷键什么都没发生，只会以为软件坏了。
 * （`setFloatEnabled` 开头那句 `next === enabled` 会直接早退，所以这条必须在它之前拦。）
 *
 * 唤回只能用 `showInactive()`：还原但不激活。换成 `restore()` 会激活窗口，
 * 把焦点从游戏里抢走 —— 等于一按快捷键游戏就失焦。
 * `npm run check:topmost` 验过它能还原最小化窗口、且还原后置顶还在。
 */
export function toggleFloat(): void {
  const win = primaryWindow();

  if (enabled && win && win.isMinimized()) {
    win.showInactive();
    applyAlwaysOnTop();
    return;
  }

  setFloatEnabled(!enabled);
}

export function setFloatOpacity(value: number): FloatWindowStatus {
  if (!Number.isFinite(value)) return status();
  const next = clampOpacity(value);
  if (next === opacity) return status();
  opacity = next;
  applyOpacity();
  broadcast();
  persistSoon();
  return status();
}

export function registerWindowModeHandlers(): void {
  ipcMain.handle('float:get-status', () => status());
  ipcMain.handle('float:set-enabled', (_event, value: unknown) => setFloatEnabled(value === true));
  ipcMain.handle('float:set-opacity', (_event, value: unknown) =>
    setFloatOpacity(typeof value === 'number' ? value : Number.NaN),
  );

  /* ------------------------------------------------------------------ *
   * 浮窗自己的拖动与缩放（渲染层自绘，走 IPC 落 setBounds）
   *
   * 为什么不能靠系统那套：浮窗模式下窗口是 `setFocusable(false)` 的，
   * 而**标题栏拖动 / 边框缩放都会先把窗口激活** —— 非激活窗口上这两条路都不成立，
   * 表现就是「浮窗拖不动」（2026-09-17 实测踩到；拆分模式那条控制条是同一个窗口，
   * 一起拖不动）。自己算屏幕坐标再 `setBounds` 与激活无关，行为确定 ——
   * 自绘的小窗（FloatTile）用的是同一套做法。
   *
   * **只在浮窗模式下受理**：常规模式窗口有原生边框、拖得动，不需要也不该让渲染层
   * 去搬它。这也顺带把「谁有权搬窗口」收在浮窗这一个状态里。
   * ------------------------------------------------------------------ */

  const isHostSender = (event: Electron.IpcMainEvent): boolean =>
    Boolean(hostWindow) && event.sender === hostWindow?.webContents;

  ipcMain.on('float:move-to', (event, payload: unknown) => {
    if (!enabled || !isHostSender(event)) return;
    const win = primaryWindow();
    if (!win || win.isDestroyed()) return;
    if (!payload || typeof payload !== 'object') return;
    const { x, y, width, height } = payload as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      return;
    }
    /**
     * 尺寸用渲染层按下时锁定的值，**绝不展开 getBounds()**。
     *
     * 曾经的实现是 `setBounds({ ...win.getBounds(), x, y })` —— 每帧把「当前读到
     * 的尺寸」写回去。本机 100% 缩放下这个往返幂等（探针 500 次 0 漂移），但
     * 非 100% 缩放的屏幕上 DIP↔物理取整误差会逐帧累积，朋友实测看到的就是
     * 「一边拖一边整个浮窗变大」。拖动全程锁定尺寸，setBounds 只改位置。
     */
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  });

  ipcMain.on('float:resize-to', (event, payload: unknown) => {
    if (!enabled || !isHostSender(event)) return;
    const win = primaryWindow();
    if (!win || win.isDestroyed()) return;
    if (!payload || typeof payload !== 'object') return;
    const { width, height } = payload as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number') return;
    /**
     * 下限按浮窗的最小尺寸卡死。
     *
     * 拖到 0 像素的窗口就再也点不到了（只能去任务管理器杀进程），而这种窗口
     * 又是置顶 + 不可聚焦的，鼠标根本没机会把它捡回来 —— 卡死比放开安全得多。
     */
    win.setBounds({
      ...win.getBounds(),
      width: Math.max(FLOAT_MIN_WIDTH, Math.round(width)),
      height: Math.max(FLOAT_MIN_HEIGHT, Math.round(height)),
    });
  });

  /* ------------------------------------------------------------------ *
   * 常规模式的窗口按钮（顶栏右上角那三个）
   *
   * 主窗口是 `frame: false` 的（见 main.ts 里 frame 那段）：原生标题栏在浮窗模式下
   * 是个拖不动的死角，索性整个去掉，最小化 / 最大化 / 关闭改由界面自己画。
   *
   * **按发送者找窗口**（`BrowserWindow.fromWebContents`），不走 `primaryWindow()`：
   * 这条与浮窗状态无关，谁发来的就动谁 —— 少一个「登记表没建好就点不动」的失败面。
   * ------------------------------------------------------------------ */
  ipcMain.on('win:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('win:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // 浮窗模式下没有最大化这回事（而且浮窗是不可聚焦的，放大了也点不回来）
    if (enabled) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('win:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // 启动时把上次的透明度读进来（浮窗模式本身不自动开，见 ARCHITECTURE.md 4.13）
  opacity = clampOpacity(getPersisted().opacity);

  hotkeyAvailable = globalShortcut.register(HOTKEY, toggleFloat);

  app.on('browser-window-created', (_event, win) => {
    if (enabled) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setOpacity(opacity);
    }

    /**
     * 最大化状态回报给页面：顶栏那个按钮要跟着换图标（□ / ❐）。
     *
     * **必须听这个事件，不能由渲染层自己记**：双击拖动区也会最大化 —— 那是系统行为
     * （`-webkit-app-region: drag` 自带的），不经过我们的按钮，自己记的图标立刻说反话。
     */
    const pushMaximized = (): void => {
      if (win.isDestroyed()) return;
      win.webContents.send('win:maximized', win.isMaximized());
    };
    win.on('maximize', pushMaximized);
    win.on('unmaximize', pushMaximized);

    // 用户拖动/缩放浮窗后记下来，下次进浮窗直接是那个样子。
    //
    // **拆分模式下必须跳过**：那时主窗口被收成了一条贴底的控制条，
    // 记下来的话下次进浮窗就变成一条 620×76 的窄条 —— 而且它看着「像是记错了」，
    // 实际是记对了（记的是没意义的那个瞬间）。
    const remember = (): void => {
      if (!enabled || getTilesEnabled() || win.isDestroyed()) return;
      floatBounds = win.getBounds();
      persistSoon();
    };
    win.on('resize', remember);
    win.on('move', remember);
  });

  // 不注销的话快捷键会一直挂在系统上，进程退掉之后还可能残留
  app.on('will-quit', () => {
    stopTopmostKeepAlive();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      persistNow();
    }
    globalShortcut.unregisterAll();
  });
}
