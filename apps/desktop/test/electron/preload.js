// 验收页面的 preload：只暴露一条最小、单向的桥。
// 渲染进程没有 Node 能力，也不允许反过来调用主进程的任意通道。

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 需要真实采集面的那几轮，把**产品那份 preload** 也 require 进来。
 *
 * 它是靠模块副作用挂上去的（`electron/preload.ts` 末尾那句
 * `window.gameShare = api`，刻意不走 contextBridge），所以这里什么都不用接，
 * require 一下就够 —— 前提是窗口的 `contextIsolation` 为 false，
 * 否则那句写进隔离世界、页面读不到。两边的取值在 `main.js` 里对齐。
 */
const PRODUCT_PRELOAD = process.env.GAMESHARE_HARNESS_PRODUCT_PRELOAD || '';
if (PRODUCT_PRELOAD) {
  require(PRODUCT_PRELOAD);
}

/** 索引由主进程通过 additionalArguments 传入（preload 看不到页面 URL 的查询串） */
const INDEX = Number(
  (process.argv.find((arg) => arg.startsWith('--harness-index=')) ?? '').split('=')[1] ?? '0',
);

const goWaiters = [];
const roomCodeWaiters = [];
let goReceived = false;
let roomCode = null;

/**
 * 相位屏障：让「所有窗口都到了某一步」这件事可被观测。
 * 用来保证「先确认每个人都收到画面，再拆掉其中一端」。
 */
const phaseWaiters = new Map();
const phasesSeen = new Set();

ipcRenderer.on('harness:go', () => {
  goReceived = true;
  while (goWaiters.length) goWaiters.shift()();
});

ipcRenderer.on('harness:room-code', (_event, code) => {
  roomCode = code;
  while (roomCodeWaiters.length) roomCodeWaiters.shift()(code);
});

ipcRenderer.on('harness:phase-go', (_event, name) => {
  phasesSeen.add(name);
  const waiters = phaseWaiters.get(name);
  if (!waiters) return;
  phaseWaiters.delete(name);
  while (waiters.length) waiters.shift()();
});

const bridgeApi = {
  ready: () => ipcRenderer.send('harness:ready', INDEX),
  log: (line) => ipcRenderer.send('harness:log', String(line)),
  announceRoomCode: (code) => ipcRenderer.send('harness:room-code', String(code)),
  report: (payload) => ipcRenderer.send('harness:report', payload),
  /** 等主进程确认所有窗口都就绪，避免抢跑导致信令先于对端链路建立 */
  waitGo: () => (goReceived ? Promise.resolve() : new Promise((resolve) => goWaiters.push(resolve))),
  waitRoomCode: () =>
    roomCode ? Promise.resolve(roomCode) : new Promise((resolve) => roomCodeWaiters.push(resolve)),
  phaseReady: (name) => ipcRenderer.send('harness:phase-ready', { index: INDEX, name: String(name) }),
  waitPhase: (name) => {
    const key = String(name);
    if (phasesSeen.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = phaseWaiters.get(key) ?? [];
      waiters.push(resolve);
      phaseWaiters.set(key, waiters);
    });
  },
};

/**
 * 挂桥。两种上下文都要能活：
 *
 *   · `contextIsolation: true`（默认那几轮）—— 只能走 contextBridge；
 *   · `contextIsolation: false`（挂产品 preload 的那几轮，理由见 `main.js`）——
 *     这时页面与 preload 共享同一个全局，直接挂 `window` 才看得见；
 *     `exposeInMainWorld` 在这种配置下会抛，属于预期内。
 *
 * 只挂一种的话，另一种配置下页面会拿不到 `harnessBridge`：
 * 表现是所有窗口都不 ready、主进程等到总超时才报错，看不出根因。
 */
try {
  contextBridge.exposeInMainWorld('harnessBridge', bridgeApi);
} catch {
  /* 隔离关着，走下面那条 */
}
if (PRODUCT_PRELOAD) {
  // 用 globalThis 走访问：这份文件是 .js，`window` 在 lint 的浏览器环境外是未声明的
  globalThis.window.harnessBridge = bridgeApi;
}
