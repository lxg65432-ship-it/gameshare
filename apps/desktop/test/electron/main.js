// P2P 验收用的 Electron 主进程。
//
// 拉起 N 个真实渲染进程（不是 iframe、不是 worker），让它们各自跑一遍
// ShareSession 的完整流程：连接信令 → 建房/加入 → 协商 → 传视频。
// 最后把每个窗口上报的结果汇总成一行 JSON 交给外层脚本断言。
//
// 窗口刻意可见：自动化跑的同时，人能直接看到 N 个窗口互相显示对方的
// 合成动画，肉眼确认和数字确认并行。

const { BrowserWindow, app, ipcMain, screen } = require('electron');
const path = require('node:path');

const TOTAL = Number(process.env.GAMESHARE_HARNESS_TOTAL || '2');
const HARNESS_URL = process.env.GAMESHARE_HARNESS_URL;
const SIGNALING_URL = process.env.GAMESHARE_SIGNALING_URL || 'http://127.0.0.1:8080';
const OVERALL_TIMEOUT_MS = Number(process.env.GAMESHARE_HARNESS_TIMEOUT_MS || '120000');
const VISIBLE = process.env.GAMESHARE_HARNESS_VISIBLE !== '0';
/**
 * 「断开一端」场景：全部窗口确认收到画面后，真实销毁最后一个窗口，
 * 由其余窗口断言链路与成员被正确清理。
 * 被销毁的窗口不会再上报，所以期望的报告数要相应减一。
 */
const LEAVE = process.env.GAMESHARE_HARNESS_LEAVE === '1';
/**
 * 假麦克风：喂一个**内容已知**的 WAV，让麦克风这一路带可判定的信号。
 *
 * 真机上没人会对着麦克风按脚本出声，而「应用声音轨里有没有混进语音」这类断言
 * 必须有参照物。用 `--use-file-for-fake-audio-capture` 之后，每个窗口拿到的
 * 麦克风信号频率是**我们定的**，频谱上才量得出来。
 *
 * 只在给出文件时才挂这两个开关 —— 不带的时候保持真实设备，别影响其它验收。
 */
const FAKE_MIC_FILE = process.env.GAMESHARE_HARNESS_FAKE_MIC;
/** 追加到验收页 URL 末尾的原始查询串（各轮验收自己解释，harness 不碰） */
const EXTRA_QUERY = process.env.GAMESHARE_HARNESS_EXTRA_QUERY || '';
/**
 * 产品的 preload 与采集 IPC 模块（都由驱动脚本先用 esbuild 打包好再传进来）。
 *
 * 需要**真实桌面捕获**的那几轮（目前是三轨验收的 isolation 轮）必须挂这两样：
 * 渲染层要 `window.gameShare.capture`，主进程要 `registerCaptureHandlers()`
 * 里的 `setDisplayMediaRequestHandler` —— 那条链只有用**产物本身**才算验过，
 * 验收脚本自己抄一份 handler 进去，验的是抄件（`electron/capture.ts` 的文件头
 * 对同一类问题写过一次）。
 *
 * 不传时行为完全不变：其余几轮验收走的是合成源，碰不到采集面。
 */
const PRODUCT_PRELOAD = process.env.GAMESHARE_HARNESS_PRODUCT_PRELOAD || '';
const CAPTURE_MODULE = process.env.GAMESHARE_HARNESS_CAPTURE_MODULE || '';
const RESULT_MARKER = '__HARNESS_RESULT__';

if (FAKE_MIC_FILE) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', FAKE_MIC_FILE);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** @type {BrowserWindow[]} */
let windows = [];
/** @type {Map<number, object>} */
const reports = new Map();
const readyIndexes = new Set();
/** 相位屏障：name → 已到达该相位的窗口索引 */
const phaseReady = new Map();
let roomCode = null;
let goSent = false;
let finished = false;
let leaverKilled = false;

function log(line) {
  process.stdout.write(`[harness] ${line}\n`);
}

function sendTo(index, channel, payload) {
  const win = windows[index];
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function broadcast(channel, payload, exceptIndex = -1) {
  for (let i = 0; i < windows.length; i += 1) {
    if (i === exceptIndex) continue;
    sendTo(i, channel, payload);
  }
}

/**
 * 「断开一端」场景：等所有窗口都到达 pre-leave 相位（也就是各自都已确认收到画面），
 * 再真实销毁最后一个窗口。销毁渲染进程等价于客户端崩掉/被强杀，
 * 比让客户端主动 leaveRoom() 更贴近验收里说的「断开一端」。
 */
function killLeaverIfNeeded() {
  if (!LEAVE || leaverKilled) return;
  leaverKilled = true;
  const index = TOTAL - 1;
  log(`验收：销毁 P${index} 的窗口，模拟一端断开`);
  const win = windows[index];
  if (win && !win.isDestroyed()) win.destroy();
}

function layout(index, total) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const gap = 6;
  const w = Math.floor(width / cols) - gap;
  const h = Math.floor(height / rows) - gap;
  const x = (index % cols) * Math.floor(width / cols) + gap;
  const y = Math.floor(index / cols) * Math.floor(height / rows) + gap;
  return { x, y, width: w, height: h };
}

function finish(ok, reason) {
  if (finished) return;
  finished = true;

  const collected = [...reports.values()].sort((a, b) => a.index - b.index);
  const result = {
    ok,
    reason: reason || null,
    total: TOTAL,
    reported: collected.length,
    peers: collected,
  };

  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);

  // 给 stdout 一点时间冲刷，再退出
  setTimeout(() => {
    for (const win of windows) {
      if (!win.isDestroyed()) win.destroy();
    }
    app.exit(ok ? 0 : 1);
  }, 300);
}

if (!HARNESS_URL) {
  process.stderr.write('缺少环境变量 GAMESHARE_HARNESS_URL\n');
  app.exit(2);
}

ipcMain.on('harness:log', (_event, line) => {
  process.stdout.write(`${line}\n`);
});

ipcMain.on('harness:ready', (event, index) => {
  readyIndexes.add(index);
  // 已经拿到房间码后才就绪的窗口（慢启动）要补发一次
  if (roomCode && index !== 0) {
    sendTo(index, 'harness:room-code', roomCode);
  }
  if (readyIndexes.size === TOTAL && !goSent) {
    goSent = true;
    log(`${TOTAL} 个窗口就绪，放行`);
    broadcast('harness:go');
  }
});

ipcMain.on('harness:room-code', (_event, code) => {
  if (typeof code !== 'string' || !code) return;
  roomCode = code;
  log(`房间码 ${code}，广播给其余 ${TOTAL - 1} 个窗口`);
  broadcast('harness:room-code', code, 0);
});

ipcMain.on('harness:phase-ready', (_event, payload) => {
  if (!payload || typeof payload.index !== 'number' || typeof payload.name !== 'string') return;
  const arrived = phaseReady.get(payload.name) ?? new Set();
  arrived.add(payload.index);
  phaseReady.set(payload.name, arrived);
  if (arrived.size < TOTAL) return;

  log(`相位 ${payload.name}：${TOTAL} 个窗口全部到达`);
  broadcast('harness:phase-go', payload.name);
  if (payload.name === 'pre-leave') killLeaverIfNeeded();
});

ipcMain.on('harness:report', (_event, payload) => {
  if (!payload || typeof payload.index !== 'number') return;
  reports.set(payload.index, payload);
  log(
    `收到 P${payload.index} 报告：${payload.ok ? '通过' : '未通过'}${
      payload.failure ? `（${payload.failure.split('\n')[0]}）` : ''
    }`,
  );

  // 断开场景下被销毁的窗口不会上报，期望数要少一
  const expected = LEAVE ? TOTAL - 1 : TOTAL;
  if (reports.size === expected) {
    const allOk = [...reports.values()].every((r) => r.ok);
    finish(allOk, allOk ? null : '存在未通过的客户端');
  }
});

app.whenReady().then(() => {
  /**
   * 注册产品的采集 IPC。**必须在 ready 之后** —— `registerCaptureHandlers()`
   * 第一句就是 `session.defaultSession`，app 没起来时那个是 undefined。
   */
  if (CAPTURE_MODULE) {
    try {
      require(CAPTURE_MODULE).registerCaptureHandlers();
      log(`已挂上产品的采集 IPC：${path.basename(CAPTURE_MODULE)}`);
    } catch (err) {
      process.stderr.write(
        `[harness] 采集 IPC 注册失败：${err && err.stack ? err.stack : err}\n`,
      );
    }
  }

  const display = screen.getPrimaryDisplay();
  log(`拉起 ${TOTAL} 个窗口，工作区 ${display.workAreaSize.width}x${display.workAreaSize.height}`);

  windows = Array.from({ length: TOTAL }, (_unused, index) => {
    const rect = layout(index, TOTAL);
    const win = new BrowserWindow({
      ...rect,
      show: false,
      title: `GameShare P2P 验收 · P${index}`,
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        /**
         * 挂产品 preload 时必须关掉上下文隔离：那份 preload 是**直接往 window 上挂**
         * `gameShare` 的（不走 contextBridge，理由见 `electron/preload.ts` 文件头），
         * 隔离开着的话它写进的是隔离世界，页面读不到 —— 表现就是
         * 「枚举采集源」抛「当前不在 Electron 环境」。与 `main.ts` 里的取值一致。
         */
        contextIsolation: PRODUCT_PRELOAD ? false : true,
        nodeIntegration: false,
        sandbox: false,
        // 窗口可能被其他窗口遮挡甚至最小化，关掉后台节流才能保证持续出帧
        backgroundThrottling: false,
        // preload 里拿不到页面 URL 的查询串，索引只能这样传进去
        additionalArguments: [`--harness-index=${index}`],
      },
    });

    // 渲染进程的 console 默认不会出现在主进程 stdout 里。
    // 验收失败时最需要的就是这些日志，必须转发出来。
    win.webContents.on('console-message', (_event, _level, message) => {
      process.stdout.write(`  [P${index}:console] ${message}\n`);
    });

    win.loadURL(
      `${HARNESS_URL}?index=${index}&total=${TOTAL}` +
        `&timeout=${process.env.GAMESHARE_HARNESS_PHASE_MS || '45000'}` +
        `&leave=${LEAVE ? '1' : '0'}` +
        `&url=${encodeURIComponent(SIGNALING_URL)}` +
        EXTRA_QUERY,
    );

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`P${index} 页面加载失败 code=${code} desc=${desc} url=${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log(`P${index} 渲染进程终止 reason=${details.reason}`);
    });

    if (VISIBLE) {
      win.once('ready-to-show', () => win.show());
    }

    return win;
  });

  setTimeout(() => {
    if (!finished) {
      const missing = Array.from({ length: TOTAL }, (_unused, index) => index).filter(
        (index) => !reports.has(index) && !(LEAVE && index === TOTAL - 1),
      );
      log(`总超时 ${OVERALL_TIMEOUT_MS}ms，中止；未上报的窗口：${missing.join(', ') || '无'}`);
      finish(false, `总超时（未上报：${missing.join(', ') || '无'}）`);
    }
  }, OVERALL_TIMEOUT_MS);
});

app.on('window-all-closed', () => {
  if (!finished) finish(false, '窗口被关闭');
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[harness] uncaughtException ${err && err.stack ? err.stack : err}\n`);
});
