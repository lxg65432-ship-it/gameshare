import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 浮窗的拖动与缩放 —— 纯自绘，走 IPC 让主进程 `setBounds`。
 *
 * **为什么不能用系统那套。** 浮窗模式下窗口是 `setFocusable(false)` 的
 * （见 window-mode.ts 文件头第 5 条：可聚焦的话一次 focus() 就能把焦点从游戏里抢走）。
 * 而标题栏拖动与边框缩放**都会先把窗口激活** —— 非激活窗口上这两条路都不成立，
 * 用户看到的就是「浮窗拖不动」。自己算屏幕坐标再 `setBounds` 与激活无关，行为确定。
 * 自绘的小窗（`FloatTile.tsx`）用的是同一套做法，两边不是巧合。
 *
 * **刻意不做成 React hook。** 拖动状态只是一个可变变量、不参与渲染，
 * 做成 hook 反而要在组件体里多插一行、还多一份每渲染重建的 props。
 * 这里导出的是模块级单例：一个窗口只挂一套页面，不存在两份状态的问题。
 *
 * 三条不能随手改的写法：
 *
 * 1. `window.screenX/screenY` **只在按下那一刻读一次**，之后一律「起点 + 位移」算目标位置。
 *    每次 move 都重新读窗口当前位置的话会读到旧值（`setBounds` 是异步的），
 *    拖起来一顿一顿、误差还会累积。
 * 2. **必须开指针捕获**：拖动时窗口在光标底下整体移动，不捕获的话指针会「跑出」元素，
 *    `pointerup` 收不到 —— 表现是拖一下就粘住、松手还在动。
 * 3. **控件上按下不算拖动**：滑杆要能拖、按钮要能点，所以按下时先看目标是不是控件。
 *
 * 缩放与移动的基准尺寸是 `innerWidth/innerHeight`，**不是 `outerWidth`**：
 * 主窗口 `frame: false` 时 Windows 仍给一圈约 8px 的不可见 resize 边框（thickFrame），
 * `outerWidth` 会把这圈也算进去（实测 520 的窗口报 536）—— 而主进程 `setBounds`
 * 收的是 `getBounds()` 那个矩形（= innerWidth）。基准用 outerWidth 的话，每按一次
 * 缩放手柄窗口就涨 16px，用户看到的就是「一边拖一边变大」（2026-09-18 朋友实测复现、
 * 探针实锤）。小窗那边是无边框窗口、inner 与 outer 相等，两边从此统一用 inner。
 */

interface DragState {
  mode: 'move' | 'resize';
  /** 按下那一刻光标的屏幕坐标 */
  startX: number;
  startY: number;
  /** 按下那一刻窗口左上角的屏幕坐标 */
  winX: number;
  winY: number;
  /** 按下那一刻窗口的客户区尺寸（= 主进程 getBounds 的 w/h，见文件尾注释） */
  winW: number;
  winH: number;
}

export interface FloatDragProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

let drag: DragState | null = null;
/** 这一次按下之后真的动过吗 —— 用来把「按住拖」和「点一下」分开 */
let dragMoved = false;
/** 「点一下」要执行的动作（只有小球会传）：松手时没动过才算点击 */
let tapHandler: (() => void) | null = null;

/** 超过这个位移就算拖动，不算点击。太小的话手抖一下就把小球当成拖走了 */
const TAP_SLOP = 3;

function begin(
  mode: DragState['mode'],
  event: ReactPointerEvent<HTMLElement>,
  onTap?: () => void,
): void {
  if (event.button !== 0) return;
  // 控件上按下不算拖动 —— 少了这一句，滑杆一拖窗口就跟着跑
  if ((event.target as HTMLElement).closest('button, input, select, textarea')) return;
  if (!window.gameShare?.windowMode) return;
  drag = {
    mode,
    startX: event.screenX,
    startY: event.screenY,
    winX: window.screenX,
    winY: window.screenY,
    winW: window.innerWidth,
    winH: window.innerHeight,
  };
  dragMoved = false;
  tapHandler = onTap ?? null;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  // 拖画面时别顺手把界面里的文字选成一片蓝
  event.preventDefault();
}

function move(event: ReactPointerEvent<HTMLElement>): void {
  if (!drag) return;
  const api = window.gameShare?.windowMode;
  if (!api) return;
  const dx = event.screenX - drag.startX;
  const dy = event.screenY - drag.startY;
  if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) dragMoved = true;
  if (drag.mode === 'move') {
    // 尺寸也一并下发（按下时锁定的值）：主进程因此不用每帧展开 getBounds()。
    // 那个 roundtrip 在非 100% 缩放的屏幕上取整误差会逐帧累积 —— 表现就是
    // 「拖动时窗口慢慢变大」。全程锁定尺寸，拖动就只改位置。
    api.moveTo(drag.winX + dx, drag.winY + dy, drag.winW, drag.winH);
  } else {
    api.resizeTo(drag.winW + dx, drag.winH + dy);
  }
}

/**
 * `fired` = 这次抬起算不算「正常松手」。
 *
 * `pointercancel`（窗口被系统收走、拖到别的显示器时中断…）**不能算点击** ——
 * 否则一次中断就会把小球展开，看着像自己乱动。
 */
function end(fired: boolean): void {
  const tap = tapHandler;
  const moved = dragMoved;
  drag = null;
  dragMoved = false;
  tapHandler = null;
  if (fired && tap && !moved) tap();
}

/** 挂在「拖动区」上：浮窗的画面区 / 拆分模式的那条控制条 */
export const floatDragProps: FloatDragProps = {
  onPointerDown: (event) => begin('move', event),
  onPointerMove: move,
  onPointerUp: () => end(true),
  onPointerCancel: () => end(false),
};

/**
 * 挂在收起后的那颗小球上：**按住能拖，松手没动过就算点了一下**。
 *
 * 小球上不能另外挖一个「展开」按钮出来：它整块都是拖动区，按钮吃掉哪一块，
 * 哪一块就变成「从这儿开始拖拖不动」（与小窗名字牌同一种坑）。所以按位移判 ——
 * 拖动超过 `TAP_SLOP` 算拖动，否则算点击，悬浮球都是这个交互。
 */
export function floatBallProps(onTap: () => void): FloatDragProps {
  return {
    onPointerDown: (event) => begin('move', event, onTap),
    onPointerMove: move,
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
  };
}

/**
 * 挂在右下角的缩放手柄上。
 *
 * 它自己先 `stopPropagation`，否则拖动区那个 handler 也会收到这一次按下，
 * 变成「一边移动一边缩放」。
 */
export const floatGripProps: FloatDragProps = {
  onPointerDown: (event) => {
    event.stopPropagation();
    begin('resize', event);
  },
  onPointerMove: move,
  onPointerUp: () => end(true),
  onPointerCancel: () => end(false),
};
