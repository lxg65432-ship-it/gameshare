'use strict';

/**
 * 验证「浮窗拆分模式」：每一路远端画面拆成一个可独立拖动的小窗。
 *
 * 为什么单独有这个脚本 —— 拆分模式有几处**看着能跑、其实没跑**的失败模式：
 *
 *   a) 小窗开了但画面过不去（`ImageBitmap` 没走 transfer list、或者通道接错了序号）：
 *      表现是小窗全黑，而控制台一句报错都没有；
 *   b) 几个小窗串了台（几个泵共用一张画布、或者端口按错了序号）：
 *      表现是「A 的窗里放着 B 的画面」，而且偶发，肉眼很难稳定复现；
 *   c) 主进程把一个字段丢掉了（比如把 `muted` 过滤掉），界面照样打开，
 *      只是小窗上的按钮开始说反话 —— 只能靠断言「建窗参数」和「状态推送」来盯；
 *   d) 同一个序号换了人时页面不重新导航，**新身份没送过去**，于是悬浮条一直挂着
 *      上一个人的名字，而「静音这一路」会发给一个已经不在房间里的人。
 *
 * 这些都得靠真开窗口、真读像素、真比身份来判断。
 *
 * 分组：
 *
 *   1. **装载组** —— 跑的是**真模块、真 IPC**。把 `float-tiles.ts` 单独打包成一份 CJS
 *      在本进程 require 进来，再配一个挂**真 preload** 的主窗口去调它的 IPC 通道，
 *      所以验的是真实链路而不是复刻。覆盖：窗数、每个小窗的窗口标志（不可聚焦 /
 *      置顶 / 不可最小化…）、建窗参数（含初始静音状态）、主窗口被收成控制条、
 *      换人不重建窗口且身份送达、清单变短关掉多余的、静音双向、尺寸回流、
 *      用户直接关窗后的状态、透明度、合并与还原。
 *   2. **帧泵组** —— 三路带颜色的合成视频源 → 抽帧 → `ImageBitmap` → MessagePort
 *      → 三个小窗各自画布。断言**每个小窗画出来的是自己那一路的颜色**（串台检测）
 *      且三路都在 30fps 附近。
 *   3. **静态断言组** —— 几条「改错了就静默失效」的写法，就地正则盯着。
 *
 * ⚠️ **没覆盖的**：真实对端的视频流、渲染层（App.tsx）里那套接线、鼠标真拖小窗、
 * 以及「小窗能不能压在无边框全屏游戏上面」（那一条归 `npm run check:topmost`）。
 * 帧泵组是**复刻**实现，不是直接跑 App.tsx 里那一份 —— 所以第 3 组必须存在：
 * 实现漂移了要能把这边从绿变红。
 *
 * 用法：
 *   npm run check:tiles
 *
 * ⚠️ 会真的开一批窗口（约 15 秒）然后自动关掉。跑的时候别抢鼠标。
 * 用的是独立的 userData 目录，**不会碰你自己那份小窗位置记录**。
 */

const { app, BrowserWindow, MessageChannelMain, screen, session } = require('electron');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const DIST_ELECTRON = path.join(DESKTOP, 'dist-electron');
const CACHE_ROOT = path.join(ROOT, '.cache');
/** 待测模块要落在这里，因为 float-tiles.ts 用 `__dirname` 找 preload 与页面 */
const WORK = path.join(CACHE_ROOT, 'check-float-tiles');
const PROBE_DIST = path.join(CACHE_ROOT, 'dist');
const USER_DATA = path.join(CACHE_ROOT, 'check-float-tiles-userdata');

/**
 * **必须在读 userData 之前改掉它。**
 *
 * `float-tiles.ts` 会把小窗位置写进 `userData/float-tiles.json`。用真实目录的话：
 * (1) 这次跑出来的窗口会被写进用户自己的记录里，(2) 用户已经存下的位置会让「默认
 * 摆法」的断言失败 —— 看着像脚本和实现漂移，其实是被数据坑的。所以整个进程换目录。
 */
app.setPath('userData', USER_DATA);

/**
 * **不加这一条，脚本会在第一组结束时莫名其妙地成功退出。**
 *
 * Electron 默认行为是「所有窗口关掉就退出」。第一组末尾会销毁主窗口，那一刻确实
 * 一个窗口都不剩了 —— 进程直接以 0 退出，后面两组根本没跑，而屏幕上只留下一堆
 * 通过的字。这是最坏的一种「假绿」。
 */
app.on('window-all-closed', () => {
  /* 保持进程存活，由 main() 决定何时退出 */
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
let passed = 0;

function check(label, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 真页面的小工具（第 7 组用）
 * ------------------------------------------------------------------ */

/**
 * 重跑一次 `vite build`。
 *
 * 第 7 组量的是**界面上看得见的东西**，所以它必须跑真渲染层产物 ——
 * 而这个脚本前面几组全是 `data:` 空白页，没有构建过渲染层。不重建的话
 * 量到的是上一次 build 的 CSS，改完样式这里照样绿（最典型的假绿）。
 * 构建方式是照 `scripts/_probe-tile-name.cjs` 抄的：把 electron 当 node 用。
 */
function buildRenderer() {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new Error(`找不到 vite：${vite}`);
  const res = spawnSync(process.execPath, [vite, 'build'], {
    cwd: DESKTOP,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (res.status !== 0) {
    throw new Error(`vite build 失败（status=${res.status}）\n${res.stdout ?? ''}${res.stderr ?? ''}`);
  }
  return /built in ([\d.]+m?s)/.exec(res.stdout ?? '')?.[1] ?? '?';
}

/** 读一个元素在真页面里的几何与关键样式；不存在时返回 null */
async function readBox(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      opacity: Number(cs.opacity),
      pointerEvents: cs.pointerEvents,
      text: (el.textContent || '').trim(),
    };
  })()`);
}

/** BGRA 取亮度（Electron 的 toBitmap 就是 BGRA 顺序） */
function lumaAt(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return 0.114 * bitmap[offset] + 0.587 * bitmap[offset + 1] + 0.299 * bitmap[offset + 2];
}

/** 一个矩形区域的平均亮度；只用一次 toBitmap，避免逐像素重复拷贝整张图 */
function meanLuma(image, box) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let sum = 0;
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      sum += lumaAt(bitmap, width, x, y);
      n++;
    }
  }
  return n ? sum / n : Number.NaN;
}

/* ------------------------------------------------------------------ *
 * 探针页面
 * ------------------------------------------------------------------ */

/**
 * 小窗页面。
 *
 * 真页面（`apps/desktop/dist/index.html`）在这个场景里跑不出我们要看的东西 ——
 * 它等的是主窗口那台帧泵，而这里没有。所以放一个只做记录的替代页：把主进程推过来的
 * 静音状态、通道（连同通道上的对端身份）、以及自己建窗时的 URL 参数都记下来。
 *
 * 它跑在 `contextIsolation: false` 的窗口里（这是 `float-tiles.ts` 定的，因为
 * MessagePort 过不了 contextBridge），所以能直接读到 `window.gameShareTile`。
 */
const TILE_PROBE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;height:100%;background:#000}</style></head><body><script>
var q = new URLSearchParams(location.search);
window.__probe = {
  tileIndex: q.get('floatTile'),
  peer: q.get('peer'),
  name: q.get('name'),
  initialMuted: q.get('muted'),
  mutedPushes: [],
  portCount: 0,
  portMeta: null,
  /** 从通道上真收到的位图张数 —— 「主窗口 → 小窗」这条路的唯一硬证据 */
  bitmaps: 0,
  lastBitmap: null,
  reportedWidth: 0,
  apiPresent: !!window.gameShareTile,
  errors: []
};
try {
  var api = window.gameShareTile;
  if (api) {
    api.onMuted(function (m) { window.__probe.mutedPushes.push(m === true); });
    api.onPort(function (port, meta) {
      window.__probe.portCount += 1;
      window.__probe.portMeta = { index: meta.index, peerId: meta.peerId, name: meta.name };
      if (!port || typeof port.postMessage !== 'function') {
        window.__probe.errors.push('端口不可用（没有 postMessage）');
        return;
      }
      port.onmessage = function (e) {
        var bmp = e.data && e.data.bmp;
        if (!bmp) return;
        window.__probe.bitmaps += 1;
        window.__probe.lastBitmap = bmp.width + 'x' + bmp.height;
        if (bmp.close) bmp.close();
      };
    });
    api.reportSize(window.innerWidth, window.innerHeight);
    window.__probe.reportedWidth = window.innerWidth;
  }
} catch (e) { window.__probe.errors.push(String(e)); }
</script></body></html>`;

/** 帧泵组的画布页：收到通道就把位图画下来，并采中心点的颜色 */
const CONSUMER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>consumer</title>
<style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body>
<canvas id="c" width="8" height="8"></canvas><script>
window.__stats = { frames: 0, fps: 0, color: null, meta: null, bytes: 0 };
window.__onPumpPort = function (port, meta) {
  window.__stats.meta = meta;
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  var times = [];
  port.onmessage = function (e) {
    var bmp = e.data && e.data.bmp;
    if (!bmp) return;
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width; canvas.height = bmp.height;
    }
    ctx.drawImage(bmp, 0, 0);
    var px = ctx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data;
    window.__stats.color = [px[0], px[1], px[2]];
    window.__stats.bytes = bmp.width * bmp.height;
    var now = performance.now();
    times.push(now);
    if (times.length > 31) times.shift();
    window.__stats.frames += 1;
    if (times.length >= 2) {
      window.__stats.fps = Math.round(((times.length - 1) * 1000) / (times[times.length - 1] - times[0]));
    }
    bmp.close();
  };
};
</script></body></html>`;

/**
 * 帧泵组的视频源页：三路不同颜色的合成视频。
 *
 * **必须持续重绘**：`canvas.captureStream()` 只在画布被重绘时产帧，画完就晾着的话
 * 一帧都不会有（这一条在探测阶段踩过，量出来是「0fps」却看着一切正常）。
 * 中间那块保持纯色（下面要采它的中点），动的是左上角一个小方块。
 *
 * 三个 `<video>` 的尺寸**跟着窗口流动**（不写死）：真实场景里帧泵的源是主窗口那层
 * `inset: 0` 的画面，元素的尺寸本来就是随窗口走的。写死成 160x90 的话，探针里的
 * 视频元素永远停在那个尺寸 —— 下面那三条帧率断言正是在它上面量的。
 */
const SOURCE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>source</title>
<style>html,body{margin:0;height:100%}body{display:flex;gap:2px;background:#000;color:#888}
video{flex:1;min-width:0;background:#111}</style>
</head><body>
<video id="v0" autoplay muted playsinline></video>
<video id="v1" autoplay muted playsinline></video>
<video id="v2" autoplay muted playsinline></video>
<script>
var COLORS = [[192, 57, 43], [39, 174, 96], [36, 113, 163]];
var videos = [];
COLORS.forEach(function (rgb, i) {
  var cv = document.createElement('canvas');
  cv.width = 1280; cv.height = 720;
  var ctx = cv.getContext('2d', { alpha: false });
  var n = 0;
  var paint = function () {
    ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = n % 2 ? '#ffffff' : '#000000';
    ctx.fillRect(8, 8, 32, 32);
    n += 1;
  };
  paint();
  setInterval(paint, 33);
  var v = document.getElementById('v' + i);
  v.srcObject = cv.captureStream(30);
  v.play().catch(function () {});
  videos.push(v);
});
window.__ready = function () {
  return videos.filter(function (v) { return v.videoWidth > 0; }).length;
};
/**
 * 帧泵。**这一段是 App.tsx 里那份的复刻** —— 第 3 组会用正则盯住几个关键写法，
 * 免得实现改了这边还在绿。
 */
window.__posted = 0;
window.__onPumpPort = function (port, meta) {
  var video = document.getElementById('v' + meta.col);
  if (!video) return;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { alpha: false });
  var handle = 0;
  var inFlight = false;
  var cancelled = false;
  var pump = function () {
    if (cancelled) return;
    handle = video.requestVideoFrameCallback(pump);
    if (inFlight) return;
    var srcW = video.videoWidth;
    var srcH = video.videoHeight;
    if (srcW === 0 || srcH === 0) return;
    // 与 float-tiles.ts 的默认小窗尺寸一致（脚本开头会断言它没漂）
    var scale = Math.min(360 / srcW, 203 / srcH, 1);
    var w = Math.max(2, Math.round(srcW * scale));
    var h = Math.max(2, Math.round(srcH * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    inFlight = true;
    createImageBitmap(canvas).then(function (bmp) {
      inFlight = false;
      if (cancelled) { bmp.close(); return; }
      window.__posted += 1;
      port.postMessage({ bmp: bmp }, [bmp]);
    }).catch(function () { inFlight = false; });
  };
  handle = video.requestVideoFrameCallback(pump);
  window.__cancelPump = function () { cancelled = true; video.cancelVideoFrameCallback(handle); };
};
</script></body></html>`;

/** 收通道用的 preload（复刻 `preload-tile.ts` 的做法：拿到 port 直接挂到 window 上） */
const PORT_PRELOAD = `'use strict';
const { ipcRenderer } = require('electron');
ipcRenderer.on('pump-port', (event, meta) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  if (typeof window.__onPumpPort === 'function') window.__onPumpPort(port, meta);
});`;

/**
 * 「不是主窗口」的发送方 —— 第 4 组（浮窗拖动 / 缩放）的**对照组**。
 *
 * 拖动与缩放走 IPC 之后，主进程那道 `event.sender === hostWindow.webContents` 的闸
 * 就是唯一的防线：小窗、或者任何别的窗口都不该能把主窗口搬走（小窗手里同样握着
 * `ipcRenderer`，真被利用了就是「点一下小窗，主窗口跑掉了」）。
 * 这个 preload 假扮成那种窗口：页面一加载就发一次拖动 + 一次缩放。
 */
const ROGUE_PRELOAD = `'use strict';
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', function () {
  ipcRenderer.send('float:move-to', { x: 7, y: 7, width: 520, height: 293 });
  ipcRenderer.send('float:resize-to', { width: 999, height: 999 });
});`;

/* ------------------------------------------------------------------ *
 * 准备被测产物
 * ------------------------------------------------------------------ */

function makeWindow(options) {
  return new BrowserWindow({
    ...options,
    // 检查窗口一律不许被节流：后台窗口的定时器会被降频，
    // 而这里的被测对象就是「每秒出多少帧」。
    webPreferences: { backgroundThrottling: false, ...(options.webPreferences ?? {}) },
  });
}

async function prepare() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(PROBE_DIST, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  // 1) 用仓库自己的构建脚本产出 main / preload / preload-tile（esbuild，很快）
  const { buildElectron } = await import(
    pathToFileURL(path.join(DESKTOP, 'scripts', 'build-electron.mjs')).href
  );
  await buildElectron();

  // 2) 单独打包待测模块。落在 .cache 里是有讲究的：float-tiles.ts 用 `__dirname`
  //    去找 preload-tile.cjs 和 ../dist/index.html，而这两样我们也放在它旁边/上一层。
  const { buildSync } = require('esbuild');
  buildSync({
    entryPoints: [path.join(DESKTOP, 'electron', 'float-tiles.ts')],
    outfile: path.join(WORK, 'float-tiles.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning',
  });

  fs.copyFileSync(
    path.join(DIST_ELECTRON, 'preload-tile.cjs'),
    path.join(WORK, 'preload-tile.cjs'),
  );

  /**
   * `window-mode.ts` 也单独打一份 —— 第 4 组验的是「浮窗的拖动 / 缩放 IPC」。
   *
   * 它 import 的 `./float-tiles` 会被**一起打进来**，刻意不做成 external：
   * 标 external 之后生成的是 `require('./float-tiles')`，而 Node 解析无扩展名的路径时
   * **不会去找 `.cjs`**（只试 .js / .json / .node / 目录），直接就是模块找不到。
   * 多一份副本是安全的：这个副本不注册任何 IPC handler（`registerFloatTilesHandlers`
   * 由 main.ts 调、不在 window-mode 里），也不碰小窗列表。反倒是让它俩共享同一份状态
   * 更危险 —— `setFloatEnabled(false)` 会顺手把第 1 组的小窗全关掉。
   */
  buildSync({
    entryPoints: [path.join(DESKTOP, 'electron', 'window-mode.ts')],
    outfile: path.join(WORK, 'window-mode.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning',
  });

  /**
   * `clipboard.ts` 也单独打一份 —— 第 6 组要跑「真 preload → 真 handler →
   * 真系统剪贴板」这条链。handler 要是留在 main.ts 里，这组就只能自己抄一份
   * 塞进校验脚本，那验的是抄件、不是产物。
   */
  buildSync({
    entryPoints: [path.join(DESKTOP, 'electron', 'clipboard.ts')],
    outfile: path.join(WORK, 'clipboard.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning',
  });

  fs.writeFileSync(path.join(PROBE_DIST, 'index.html'), TILE_PROBE_PAGE, 'utf8');
  fs.writeFileSync(path.join(WORK, 'port-preload.cjs'), PORT_PRELOAD, 'utf8');
  // 第 4 组的对照组：假扮「不是主窗口」的发送方
  fs.writeFileSync(path.join(WORK, 'rogue-preload.cjs'), ROGUE_PRELOAD, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 第 1 组：装载（真模块 + 真 IPC）
 * ------------------------------------------------------------------ */

/** 读小窗页面上的探针。页面还没加载完时拿不到 —— 返回 null 而不是抛。 */
async function probeOf(win) {
  try {
    const raw = await win.webContents.executeJavaScript('JSON.stringify(window.__probe || null)');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function probeAll(wins) {
  const out = [];
  for (const win of wins) out.push({ win, probe: await probeOf(win) });
  return out;
}

async function groupLoad() {
  console.log('\n装载组（跑的是真模块 + 真 IPC）');

  const ftSource = fs.readFileSync(path.join(DESKTOP, 'electron', 'float-tiles.ts'), 'utf8');
  // 常量从源码里读，避免脚本和实现各写一份、慢慢漂移
  const num = (pattern) => {
    const m = pattern.exec(ftSource);
    return m ? Number(m[1]) : NaN;
  };
  const TILE_WIDTH = num(/const TILE_WIDTH = (\d+);/);
  const BAR_WIDTH = num(/const BAR_WIDTH = (\d+);/);
  const BAR_HEIGHT = num(/const BAR_HEIGHT = (\d+);/);
  const BAR_MARGIN = num(/const BAR_MARGIN = (\d+);/);
  /**
   * 默认小窗高度在实现里**不是常量** —— 它由宽度按 16:9 现算（屏幕窄时宽度会被压低，
   * 存一个固定高度会让画面被拉变形）。所以这里照同一条规则算一遍当期望值。
   */
  const TILE_HEIGHT = Math.round((TILE_WIDTH * 9) / 16);
  check(
    '能从源码读到小窗与控制条的尺寸常量',
    [TILE_WIDTH, BAR_WIDTH, BAR_HEIGHT, BAR_MARGIN].every((n) => Number.isFinite(n)),
    `小窗宽 ${TILE_WIDTH}（高按 16:9 = ${TILE_HEIGHT}）/ 控制条 ${BAR_WIDTH}x${BAR_HEIGHT} 留白 ${BAR_MARGIN}`,
  );
  // 帧泵组那份复刻里把目标框写死成 360x203，盯住它别跟实现漂移
  check(
    '帧泵复刻用的目标框与实现的默认尺寸一致',
    TILE_WIDTH === 360 && TILE_HEIGHT === 203,
    `实现 ${TILE_WIDTH}x${TILE_HEIGHT} vs 复刻 360x203`,
  );

  const ft = require(path.join(WORK, 'float-tiles.cjs'));

  const area = screen.getPrimaryDisplay().workArea;
  const hostStart = {
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(900, area.width - 120),
    height: Math.min(560, area.height - 120),
  };

  /**
   * 宿主窗口的 `contextIsolation` **照 main.ts 的取值来，不写死**。
   *
   * 这是「实现漂移就能把这边从绿变红」的接点：真实 preload 是直接往 `window` 上挂 API 的
   * （不走 contextBridge，理由见 preload.ts 文件头），一旦 main.ts 把它改回 true，
   * 页面就读不到 `window.gameShare`、下面那一圈断言当场炸 —— 而不是像 2026-09-17 那样
   * 一路绿到用户手上才发现。
   */
  const mainSource = fs.readFileSync(path.join(DESKTOP, 'electron', 'main.ts'), 'utf8');
  const isolation = /contextIsolation:\s*(true|false)/.exec(mainSource);
  check(
    '能从 main.ts 读到主窗口的 contextIsolation（宿主窗口照它来）',
    Boolean(isolation),
    isolation ? `实测 ${isolation[1]}` : 'main.ts 的 webPreferences 里没找到',
  );

  const host = makeWindow({
    ...hostStart,
    show: true,
    title: 'GameShare 检查用主窗口',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: isolation ? isolation[1] === 'true' : true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await host.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%23111"></body>');
  ft.setTilesHostWindow(host);
  ft.registerFloatTilesHandlers();

  // 在主窗口那侧挂上事件记录，用来验证「主进程 → 渲染层」的回流
  await host.webContents.executeJavaScript(`
    window.__host = { sizes: [], muteReqs: [], status: [], ports: [] };
    window.__tilePorts = {};
    window.gameShare.floatTiles.onTileSize(function (i) { window.__host.sizes.push(i); });
    window.gameShare.floatTiles.onToggleMuteRequest(function (p) { window.__host.muteReqs.push(p); });
    window.gameShare.floatTiles.onStatus(function (s) { window.__host.status.push(s); });
    window.gameShare.floatTiles.onTilePort(function (port, meta) {
      // 「端口到了」是**不够的**：MessagePort 过 contextBridge 之后会变成一个
      // 没有方法的空对象，而真值判断照样通过。所以「能不能用」要单独记一笔，
      // 并且真发一张位图过去（__pumpOnce）—— 见下面那两条断言。
      var usable = typeof port.postMessage === 'function';
      window.__host.ports.push({
        index: meta.index, peerId: meta.peerId, name: meta.name, usable: usable
      });
      if (usable) window.__tilePorts[meta.index] = port;
    });
    window.__pumpOnce = function (index) {
      var port = window.__tilePorts[index];
      if (!port) return 'no-port';
      var canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 18;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, 32, 18);
      return createImageBitmap(canvas).then(function (bmp) {
        port.postMessage({ bmp: bmp }, [bmp]);
        return 'posted';
      }).catch(function (err) { return 'throw:' + err.message; });
    };
    window.__sync = function (peers) { return window.gameShare.floatTiles.syncPeers(peers); };
    window.__setEnabled = function (v) { return window.gameShare.floatTiles.setEnabled(v); };
    'ok'
  `);

  const tilesNow = () => BrowserWindow.getAllWindows().filter((w) => w !== host);
  const syncFromHost = (peers) =>
    host.webContents.executeJavaScript(`window.__sync(${JSON.stringify(peers)})`);
  const readHost = async () => JSON.parse(await host.webContents.executeJavaScript('JSON.stringify(window.__host)'));

  const PEERS = [
    { peerId: 'peer-aaa', name: '阿泰', muted: false },
    { peerId: 'peer-bbb', name: '小雨', muted: true },
    { peerId: 'peer-ccc', name: '老陈', muted: false },
  ];

  /* ---- 开模式 ---- */
  await host.webContents.executeJavaScript('window.__setEnabled(true)');
  check('开拆分模式后 enabled=true', ft.getTilesEnabled() === true);

  await waitFor(() => host.getBounds().height === BAR_HEIGHT);
  const bar = host.getBounds();
  check(
    '主窗口被收成贴底的窄控制条',
    bar.width === Math.min(BAR_WIDTH, Math.max(320, area.width - 40)) &&
      bar.height === BAR_HEIGHT &&
      bar.y === area.y + area.height - BAR_HEIGHT - BAR_MARGIN,
    `实测 ${bar.width}x${bar.height} @ (${bar.x},${bar.y})，期望高 ${BAR_HEIGHT}、底边留白 ${BAR_MARGIN}`,
  );

  /* ---- 建窗 ---- */
  await syncFromHost(PEERS);
  await waitFor(() => tilesNow().length === 3);
  check('三个对端开出三个小窗', tilesNow().length === 3, `实测 ${tilesNow().length} 个`);

  const loaded = await waitFor(
    async () => {
      const list = tilesNow();
      if (list.length !== 3) return false;
      return (await probeAll(list)).every((p) => p.probe !== null);
    },
    6000,
  );
  check('三个小窗页面都加载完并挂上了探针', loaded);

  const sorted = (await probeAll(tilesNow())).sort(
    (a, b) => Number(a.probe.tileIndex) - Number(b.probe.tileIndex),
  );
  check(
    '小窗页面看到的序号与对端一一对应',
    sorted.length === 3 && sorted.map((s) => s.probe.peer).join(',') === 'peer-aaa,peer-bbb,peer-ccc',
    sorted.map((s) => `${s.probe.tileIndex}:${s.probe.peer}`).join(' '),
  );
  /**
   * 这一条是**静音字段有没有被 IPC 丢掉**的直接判据。
   *
   * `float:sync-tiles` 的 handler 早先只挑 peerId / name，把 `muted` 整个过滤掉 ——
   * 那样这里读到的全是 `0`，而用户在小窗上看到的按钮就永远是「有声」：
   * 主窗口明明静音了某一路，小窗上写着有声，点一下反而把它放出来。
   */
  check(
    '建窗参数带上了本机的静音状态（muted 没被 IPC 丢掉）',
    sorted[0]?.probe.initialMuted === '0' &&
      sorted[1]?.probe.initialMuted === '1' &&
      sorted[2]?.probe.initialMuted === '0',
    sorted.map((s) => `${s.probe.name}=${s.probe.initialMuted}`).join(' '),
  );
  check(
    '小窗页面拿到了 preload、参数解析正常',
    sorted.every((s) => s.probe.apiPresent && s.probe.errors.length === 0),
  );
  check(
    '每个小窗都收到过通道，且通道上带着对端身份',
    sorted.every((s) => s.probe.portCount >= 1 && s.probe.portMeta && s.probe.portMeta.peerId),
    sorted.map((s) => `${s.probe.name}→${s.probe.portMeta?.peerId}`).join(' '),
  );

  /* ---- 画面通道：主窗口那一头拿到的端口必须**真能用**，位图必须**真到得了小窗** ----
   *
   * 这两条是 2026-09-17 那次事故的回归位。当时主窗口是 `contextIsolation: true`，
   * `MessagePort` 过 `contextBridge` 之后变成一个**没有方法的空普通对象**：
   * 判空能过（空对象是真值）、`postMessage` 每帧抛 TypeError 又被帧泵自己的 catch 吃掉
   * —— 三个小窗全黑、一句报错都没有，用户只能看见「等待画面…」。
   *
   * 注意上面那条「小窗收到了通道」当时**照样是绿的** —— 坏的是主窗口那一端。
   * 所以判据不能是「端口到了」，只能是**真发一张位图过去、看小窗收没收到**。
   */
  const hostPorts = (await readHost()).ports;
  check(
    '主窗口这条链路上拿到了 3 条可用端口（有 postMessage，不是空对象）',
    hostPorts.length === 3 && hostPorts.every((p) => p.usable === true),
    `实测 ${hostPorts.length} 条，可用 ${hostPorts.filter((p) => p.usable).length} 条`,
  );

  const bitmapsBefore = (await probeAll(tilesNow())).map((p) => p.probe?.bitmaps ?? 0);
  const posted = await host.webContents.executeJavaScript('window.__pumpOnce(0)');
  await waitFor(
    async () => (await probeAll(tilesNow())).some((p) => (p.probe?.bitmaps ?? 0) > 0),
    3000,
  );
  const bitmapsAfter = (await probeAll(tilesNow())).map((p) => p.probe?.bitmaps ?? 0);
  check(
    '主窗口搬过去的位图真的到了小窗，而且只到了一个（不串台）',
    posted === 'posted' && bitmapsAfter.filter((n) => n > 0).length === 1,
    `发送结果=${posted} · 各窗收到的位图数 [${bitmapsBefore.join(',')}] → [${bitmapsAfter.join(',')}]`,
  );

  /* ---- 窗口标志 ---- */
  await waitFor(async () => tilesNow().every((w) => w.isVisible()));
  await sleep(400);
  const flags = tilesNow().map((w) => ({
    focusable: w.isFocusable(),
    top: w.isAlwaysOnTop(),
    minimizable: w.isMinimizable(),
    maximizable: w.isMaximizable(),
    fullscreenable: w.isFullScreenable(),
    resizable: w.isResizable(),
  }));
  check(
    '小窗全部不可聚焦（碰它不会把游戏弄失焦）',
    flags.every((f) => f.focusable === false),
    flags.map((f) => String(f.focusable)).join(' '),
  );
  check('小窗全部置顶', flags.every((f) => f.top === true));
  check(
    '小窗不可最小化 / 最大化 / 全屏，但可改大小',
    flags.every((f) => !f.minimizable && !f.maximizable && !f.fullscreenable && f.resizable),
  );

  const bounds = tilesNow().map((w) => w.getBounds());
  check(
    '小窗按默认摆法纵向排开、尺寸与常量一致',
    new Set(bounds.map((b) => b.y)).size === 3 &&
      bounds.every((b) => b.height === TILE_HEIGHT && b.width === TILE_WIDTH),
    bounds.map((b) => `${b.width}x${b.height}@y${b.y}`).join(' '),
  );

  /* ---- 静音：本机翻转 → 小窗被推 ---- */
  await syncFromHost(PEERS.map((p) => ({ ...p, muted: false })));
  await sleep(600);
  const bbb = (await probeAll(tilesNow())).find((p) => p.probe?.peer === 'peer-bbb');
  check(
    '本机取消静音后，小窗收到 muted=false 的推送',
    Boolean(bbb) && bbb.probe.mutedPushes.includes(false),
    `收到的推送：${JSON.stringify(bbb?.probe.mutedPushes ?? [])}`,
  );

  /* ---- 静音：小窗 → 主窗口 ---- */
  if (bbb) {
    await bbb.win.webContents.executeJavaScript(`window.gameShareTile.toggleMute('peer-bbb')`);
    const got = await waitFor(async () => (await readHost()).muteReqs.includes('peer-bbb'));
    check('小窗上按静音，请求回流到了主窗口', got);
  }

  /* ---- 尺寸回流 ---- */
  const hostEvents = await readHost();
  check(
    '小窗上报的尺寸回流到了主窗口（帧泵按它缩放）',
    hostEvents.sizes.length >= 3 && hostEvents.sizes.every((s) => s.width > 0 && s.height > 0),
    `收到 ${hostEvents.sizes.length} 条`,
  );

  /* ---- 换人：不重建窗口，但身份必须送到 ---- */
  const before = (await probeAll(tilesNow()))
    .map((p) => ({ id: p.win.id, index: Number(p.probe.tileIndex) }))
    .sort((a, b) => a.index - b.index);

  await syncFromHost([
    { peerId: 'peer-ddd', name: '新来的', muted: false },
    PEERS[1],
    PEERS[2],
  ]);
  await sleep(800);

  const after = (await probeAll(tilesNow()))
    .map((p) => ({ id: p.win.id, index: Number(p.probe.tileIndex), probe: p.probe }))
    .sort((a, b) => a.index - b.index);

  check(
    '同一个位置换了人**不重建窗口**（画面不会闪一下）',
    before.length === 3 &&
      after.length === 3 &&
      before.every((b) => after.some((a) => a.id === b.id && a.index === b.index)),
    `窗口 id：${before.map((b) => b.id).join(',')} → ${after.map((a) => a.id).join(',')}`,
  );
  const swapped = after.find((a) => a.probe.portMeta?.peerId === 'peer-ddd');
  check(
    '换人后小窗**从重连的通道上拿到了新身份**（不重新导航，只能这么送）',
    Boolean(swapped) && swapped.probe.portMeta.name === '新来的',
    swapped ? `meta=${JSON.stringify(swapped.probe.portMeta)}` : '没有任何小窗拿到新身份',
  );

  /* ---- 清单变短 ---- */
  const keeper = after.find((a) => a.index === 0);
  await syncFromHost([PEERS[1]]);
  await waitFor(() => tilesNow().length === 1);
  check('清单变短时多余的窗被关掉', tilesNow().length === 1, `实测剩 ${tilesNow().length} 个`);
  check(
    '活下来的正是原本第 0 号那个窗（按序号对齐，没有重排）',
    tilesNow().length === 1 && Boolean(keeper) && tilesNow()[0].id === keeper.id,
    keeper ? `原本 0 号是窗口 ${keeper.id}` : '没记下 0 号窗口',
  );
  const survivor = await probeAll(tilesNow());
  check(
    '缩窗后第 0 号窗的身份也更新成了新对端',
    survivor[0]?.probe.portMeta?.peerId === 'peer-bbb',
    `meta=${JSON.stringify(survivor[0]?.probe.portMeta ?? null)}`,
  );

  /* ---- 用户自己关掉一个小窗 ---- */
  await syncFromHost([PEERS[0], PEERS[1]]);
  await waitFor(() => tilesNow().length === 2);
  const doomed = (await probeAll(tilesNow())).find((p) => p.probe?.portMeta?.peerId === 'peer-aaa');
  if (doomed) doomed.win.destroy();
  await sleep(600);
  const statuses = (await readHost()).status;
  const last = statuses[statuses.length - 1];
  check(
    '用户直接关掉一个小窗后，状态广播里也不再有它',
    Boolean(last) && last.tiles.length === 1 && last.tiles[0].peerId === 'peer-bbb',
    last ? `广播里剩 ${last.tiles.length} 个` : '没收到广播',
  );

  /* ---- 透明度 ---- */
  ft.setTilesOpacity(0.5);
  await sleep(300);
  check(
    '透明度变化会同步到小窗',
    tilesNow().every((w) => Math.abs(w.getOpacity() - 0.5) < 0.02),
    tilesNow().map((w) => w.getOpacity().toFixed(2)).join(' '),
  );
  ft.setTilesOpacity(1);

  /* ---- 合并 / 还原 ---- */
  await host.webContents.executeJavaScript('window.__setEnabled(false)');
  await sleep(700);
  check('合并后小窗全部关掉', tilesNow().length === 0, `实测剩 ${tilesNow().length} 个`);
  check('合并后 enabled=false', ft.getTilesEnabled() === false);
  const restored = host.getBounds();
  check(
    '主窗口几何被还原（不是停在控制条上）',
    restored.width === hostStart.width &&
      restored.height === hostStart.height &&
      restored.x === hostStart.x &&
      restored.y === hostStart.y,
    `实测 ${restored.width}x${restored.height} @ (${restored.x},${restored.y})`,
  );

  /* ---- 退出浮窗时收小窗（closeAllTiles 的语义） ---- */
  await host.webContents.executeJavaScript('window.__setEnabled(true)');
  await syncFromHost([PEERS[0], PEERS[1]]);
  await waitFor(() => tilesNow().length === 2);
  ft.closeAllTiles();
  await sleep(600);
  check(
    'closeAllTiles 之后小窗与开关一起收掉（退出浮窗不会留孤儿窗）',
    tilesNow().length === 0 && ft.getTilesEnabled() === false,
    `剩 ${tilesNow().length} 个，enabled=${ft.getTilesEnabled()}`,
  );

  host.destroy();
  await sleep(300);
}

/* ------------------------------------------------------------------ *
 * 第 2 组：帧泵（复刻实现，验通道隔离与帧率）
 * ------------------------------------------------------------------ */

const SOURCE_COLORS = [
  { name: '红', rgb: [192, 57, 43] },
  { name: '绿', rgb: [39, 174, 96] },
  { name: '蓝', rgb: [36, 113, 163] },
];

function colorDistance(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

async function groupPump() {
  console.log('\n帧泵组（三路合成源 → 三个小窗，验串台与帧率）');

  const preload = path.join(WORK, 'port-preload.cjs');
  const page = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const source = makeWindow({
    x: 40,
    y: 40,
    width: 540,
    height: 340,
    show: true,
    title: 'GameShare 检查用视频源',
    webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  await source.loadURL(page(SOURCE_PAGE));

  const consumers = [];
  for (let i = 0; i < 3; i += 1) {
    const win = makeWindow({
      x: 620,
      y: 40 + i * 230,
      width: 380,
      height: 220,
      show: true,
      frame: false,
      title: `GameShare 检查用小窗 ${i}`,
      webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL(page(CONSUMER_PAGE));
    consumers.push(win);
  }

  const ready = await waitFor(
    async () => (await source.webContents.executeJavaScript('window.__ready()')) === 3,
    6000,
  );
  check('三路合成视频源都出画了', ready);

  // 一条小窗 = 一条独立通道。**序号必须一一对应** —— 这里就是串台判据的来源。
  for (let i = 0; i < 3; i += 1) {
    const { port1, port2 } = new MessageChannelMain();
    source.webContents.postMessage('pump-port', { col: i, index: i }, [port1]);
    consumers[i].webContents.postMessage('pump-port', { col: i, index: i }, [port2]);
  }

  await sleep(3200);

  const stats = [];
  for (const win of consumers) {
    stats.push(JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__stats)')));
  }
  const posted = await source.webContents.executeJavaScript('window.__posted');

  check(
    '每一路小窗都收到了帧',
    stats.every((s) => s.frames > 0),
    stats.map((s) => `${s.frames} 帧`).join(' '),
  );
  check(
    '三路都跑到源的节奏（≥24fps，源是 30fps）',
    stats.every((s) => s.fps >= 24),
    stats.map((s) => `${s.fps}fps`).join(' '),
  );
  check(
    '每个小窗画的是**自己那一路**的颜色（没有串台）',
    stats.every((s, i) => {
      if (!s.color) return false;
      const own = colorDistance(s.color, SOURCE_COLORS[i].rgb);
      const others = SOURCE_COLORS.filter((_, j) => j !== i).map((c) => colorDistance(s.color, c.rgb));
      return own < Math.min(...others);
    }),
    stats
      .map((s, i) => `#${i} 画到 rgb(${(s.color || []).join(',')}) 期望 ${SOURCE_COLORS[i].name}`)
      .join(' | '),
  );
  check(
    '送过去的位图不超过小窗尺寸（帧泵只缩不放）',
    stats.every((s) => s.bytes > 0 && s.bytes <= 360 * 203),
    stats.map((s) => `${s.bytes}px`).join(' '),
  );
  check('源侧确实在持续发帧', posted > 60, `共发出 ${posted} 帧`);

  /* 这里曾经量过一条「源窗口压到收起态尺寸（152x40）后仍在出帧」，**已经删掉**。
     反向验证时它红不了：把源页那三个 `<video>` 改成 `display:none`（比缩小彻底得多），
     帧率照样是满的 —— `requestVideoFrameCallback` 不看元素的可见性，
     所以那条断言抓不到任何东西，留着就是一条「永远绿」的假保障。（同一条结论
     第 3 组也记着：主窗口那层画面用 `opacity: 0` 收掉是**保守选择**，不是实测需要。）
     真正会静默失效的是「实现把那层画面从收起态里拿掉」——小窗全黑且不报错，
     那一条归第 3 组的静态断言（盯 `hostbar__videos` 的位置）。 */

  await source.webContents.executeJavaScript('window.__cancelPump && window.__cancelPump()').catch(() => {});
  for (const win of consumers) win.destroy();
  source.destroy();
  await sleep(200);
}

/* ------------------------------------------------------------------ *
 * 第 3 组：静态断言（防止「实现漂移了这边还在绿」）
 * ------------------------------------------------------------------ */

function groupStatic() {
  console.log('\n静态断言组（改错了就静默失效的写法）');

  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const app = read('apps/desktop/src/App.tsx');
  const ft = read('apps/desktop/electron/float-tiles.ts');
  const tilePreload = read('apps/desktop/electron/preload-tile.ts');
  const css = read('apps/desktop/src/styles.css');

  check(
    '帧泵按源的节奏走（requestVideoFrameCallback），不是按刷新率',
    app.includes('requestVideoFrameCallback') &&
      !/const pump[\s\S]{0,600}requestAnimationFrame/.test(app),
  );
  check(
    '每路一张自己的画布（共用会互相覆盖成别人的帧）',
    /for \(const tile of list\)[\s\S]*?document\.createElement\('canvas'\)/.test(app),
  );
  check(
    '位图按「不放大」缩放（拖大靠小窗自己拉，不把图放大）',
    app.includes('Math.min(box.width / srcW, box.height / srcH, 1)'),
  );
  check('位图走 transfer list 而不是拷贝', app.includes('port.postMessage({ bmp: bitmap }, [bitmap])'));
  check('帧泵同时只允许一帧在途', app.includes('inFlight'));

  check(
    '小窗关闭上下文隔离（MessagePort 过不了 contextBridge）',
    ft.includes('contextIsolation: false'),
  );
  check('小窗不可聚焦', /setFocusable\(false\)/.test(ft));
  check('小窗自己断言置顶', ft.includes("setAlwaysOnTop(true, 'screen-saver')"));
  check(
    'sync-tiles 的 handler 保留了 muted（丢了它小窗按钮就会说反话）',
    ft.includes('muted: item.muted === true'),
  );
  check(
    '换人时把新身份跟着通道送过去（页面不会重新导航）',
    /connectTile[\s\S]*?name: tile\.name/.test(ft),
  );
  check(
    '小窗 preload 缓存已到达的通道（React 双挂载会让监听器晚注册）',
    tilePreload.includes('received.push'),
  );

  const videoLayer = /\.hostbar__videos\s*\{[^}]*\}/.exec(css);
  check(
    '主窗口那层画面用 opacity:0 收掉、不能用 display:none（保守选择：别拿「会停帧」当理由）',
    Boolean(videoLayer) && /opacity:\s*0/.test(videoLayer[0]) && !/display:\s*none/.test(videoLayer[0]),
    videoLayer ? videoLayer[0].replace(/\s+/g, ' ').slice(0, 80) : '没找到 .hostbar__videos',
  );

  /* ---- 三条「改回去就整条功能静默失效」的写法 ---- */

  const mainTs = read('apps/desktop/electron/main.ts');
  const preload = read('apps/desktop/electron/preload.ts');
  const drag = read('apps/desktop/src/float-drag.ts');
  const wm = read('apps/desktop/electron/window-mode.ts');

  check(
    '主窗口关掉了上下文隔离（MessagePort 过不了 contextBridge，实测见 _probe-bridge-port.cjs）',
    /contextIsolation:\s*false/.test(mainTs) && !/contextIsolation:\s*true/.test(mainTs),
    '改回 true：主窗口拿到的端口会变成没有方法的空对象 —— 小窗全黑且不报错',
  );
  check(
    '主窗口的 preload 直接挂 window、不走 contextBridge',
    /\.gameShare = api/.test(preload) && !preload.includes('exposeInMainWorld'),
    '隔离关着时 contextBridge 会把 API 写进隔离世界，页面读不到',
  );
  check(
    '帧泵认得出「端口不可用」并写日志（这一条就是防那次静默全黑的）',
    app.includes("typeof port.postMessage !== 'function'") && app.includes('通道不可用'),
  );
  check(
    '拖动 / 缩放走 IPC 自绘（不可聚焦的窗口没有系统拖动可用）',
    drag.includes('api.moveTo') &&
      drag.includes('api.resizeTo') &&
      wm.includes("ipcMain.on('float:move-to'") &&
      wm.includes("ipcMain.on('float:resize-to'"),
  );
  check(
    '拖动 / 缩放只在浮窗模式下受理、且只认主窗口',
    /float:move-to[\s\S]{0,160}?isHostSender/.test(wm) &&
      /float:resize-to[\s\S]{0,160}?isHostSender/.test(wm),
  );
  check(
    '缩小到 0 像素的下限被卡住（置顶窗口被拖成一条虚线就再也点不到了）',
    /float:resize-to[\s\S]{0,600}Math\.max\(FLOAT_MIN_WIDTH/.test(wm),
  );

  /* ------------------------------------------------------------------ *
   * 无边框窗口（2026-09-17 第八批）
   *
   * 这几条是**防回退**的：原生标题栏在浮窗模式下是一块拖不动的死角（不可聚焦的窗口
   * 拖不动自己），用户拖它得到的结论是「浮窗拖不动」—— 而这件事**动态组一条都测不到**
   * （窗口几何完全正常，只是没人拖得动它）。所以只能钉在源码上。
   * ------------------------------------------------------------------ */
  const main = read('apps/desktop/electron/main.ts');
  check(
    '主窗口是 frame: false（原生标题栏在浮窗模式下拖不动，留着就是一块死角）',
    /const win = new BrowserWindow\(\{[\s\S]*?frame: false/.test(main),
  );
  check(
    '顶栏是拖动区，且里面的控件显式退出拖动区（少了 no-drag 浮窗开关就点不动）',
    css.includes('-webkit-app-region: drag') && css.includes('-webkit-app-region: no-drag'),
  );
  check(
    '去掉原生边框后，最小化 / 最大化 / 关闭由自己提供（否则窗口关不掉）',
    app.includes('windowControl?.minimize()') &&
      app.includes('windowControl?.toggleMaximize()') &&
      app.includes('windowControl?.close()') &&
      wm.includes("ipcMain.on('win:close'"),
  );
  check(
    '浮窗 / 控制条上有看得见的拖动把手（拖动区没人知道存在就等于没有）',
    app.includes('className="bar__grip"') && css.includes('.bar__grip'),
  );

  /* ------------------------------------------------------------------ *
   * 小窗名字牌常驻（2026-09-17 第十批）
   *
   * 名字原先挂在下面的悬浮条里，而那条是 hover 才浮出来的 —— 拆分之后几个小窗
   * 长得一模一样，想分清哪个是谁得把鼠标逐个划过去，实用上等于没有。
   * 「看不见」这件事动态组测不到（元素在、只是 opacity:0），所以钉在源码上。
   * ------------------------------------------------------------------ */
  const tileSrc = read('apps/desktop/src/FloatTile.tsx');
  const barBlock = /tilewin__bar\$\{hovering[\s\S]*?<\/div>/.exec(tileSrc);
  check(
    '小窗名字不再挂在 hover 才浮出的悬浮条里（挂着就等于平时看不见）',
    Boolean(barBlock) && !barBlock[0].includes('tilewin__name'),
    barBlock ? barBlock[0].replace(/\s+/g, ' ').slice(0, 70) : '没找到悬浮条那段 JSX',
  );

  const nameRule = /\.tilewin__name\s*\{[^}]*\}/.exec(css);
  const nameFont = nameRule ? /font-size:\s*([\d.]+)px/.exec(nameRule[0]) : null;
  check(
    '名字牌常驻（有定位、不带 opacity:0），且字号 ≥13px',
    Boolean(nameRule) &&
      /position:\s*absolute/.test(nameRule[0]) &&
      !/opacity:\s*0(?!\.)/.test(nameRule[0]) &&
      Boolean(nameFont) &&
      parseFloat(nameFont[1]) >= 13,
    nameFont ? `font-size: ${nameFont[1]}px` : '没解析到字号',
  );
  check(
    '名字牌不吃指针事件（小窗整面都是拖动区，接住那一下就从它上面拖不动了）',
    Boolean(nameRule) && /pointer-events:\s*none/.test(nameRule[0]),
  );
  check(
    '这一路静音时名字牌跟着变色（静音状态只在 hover 时才露出来的话，没人会去怀疑那个开关）',
    /tilewin__name\$\{muted \?/.test(tileSrc) && css.includes('.tilewin__name--muted'),
  );

  /* preload 与主进程是两个文件、各写一遍通道名（分属两个 tsconfig，类型也共享不了）。
     名字对不上时表现是「点了没反应」且不报错，所以这里对一遍。 */
  const preloadSrc = read('apps/desktop/electron/preload.ts');
  const winChannels = ["'win:minimize'", "'win:toggle-maximize'", "'win:close'", "'win:maximized'"];
  check(
    'preload 里 windowControl 的通道名与主进程注册的一致（写错就是「点了没反应」）',
    winChannels.every((channel) => preloadSrc.includes(channel) && wm.includes(channel)),
    winChannels.filter((c) => !preloadSrc.includes(c) || !wm.includes(c)).join(' ') || undefined,
  );

  /* ------------------------------------------------------------------ *
   * 剪贴板（2026-09-17 第九批）
   *
   * 「复制 / 复制邀请」两个按钮曾经完全没反应：渲染层 `navigator.clipboard.writeText`
   * 的权限被 main.ts 那个白名单拒掉，而调用方把它 catch 成了一行日志。
   * 改成走主进程之后，这几条钉住「别再改回去」。动态那半在第 6 组。
   * ------------------------------------------------------------------ */
  const clipSrc = read('apps/desktop/electron/clipboard.ts');
  check(
    '主进程注册了 clipboard:write-text，且用的是主进程 clipboard 模块（渲染层那条路是坏的）',
    /ipcMain\.handle\('clipboard:write-text'/.test(clipSrc) && /clipboard\.writeText\(/.test(clipSrc),
  );
  check(
    'main.ts 确实调了 registerClipboardHandlers（写了没接上=白写）',
    /registerClipboardHandlers\(\)/.test(main) && /from '\.\/clipboard'/.test(main),
  );
  check(
    '剪贴板 IPC 的通道名 preload 与主进程写的一致（写错就是「点了没反应」）',
    preloadSrc.includes("'clipboard:write-text'") && clipSrc.includes("'clipboard:write-text'"),
  );
  /* 防回退的核心一条：渲染层不许再出现 `await navigator.clipboard.*`。
     它在本工程的配置下必定失败（第 6 组有对照组实测），而失败的形态是「静默」——
     这种坑不能靠人记得。
     注意这里钉的是**调用形态**而不是这个词本身：App.tsx 的注释里正解释着这条路
     为什么走不通，注释里出现 `navigator.clipboard` 是对的，不该被误判成回退。 */
  const rendererCalls = (app.match(/await\s+navigator\.clipboard/g) ?? []).length;
  const viaHelper = (app.match(/await writeClipboard\(/g) ?? []).length;
  check(
    '渲染层的复制只走 writeClipboard → gameShare.clipboard（没有 await navigator.clipboard）',
    rendererCalls === 0 && app.includes('gameShare?.clipboard') && viaHelper === 1,
    `navigator 调用 ${rendererCalls} 处、走 writeClipboard ${viaHelper} 处（期望 0 / 1）`,
  );
  check(
    '复制邀请按钮有「已复制」的可见反馈（剪贴板看不见，没反馈就以为又没生效）',
    (app.match(/copied === 'invite'/g) ?? []).length > 0 && css.includes('.btn--done'),
  );

  /* ------------------------------------------------------------------ *
   * 控制条收起（2026-09-18 第十一批）
   *
   * 四处「改错了就静默失效」：
   *   a) 最小尺寸与 bounds 的顺序写反 —— 新尺寸被上一档静默夹住，不报错；
   *   b) 球里混进按钮 —— 整块是拖动区，谁接住鼠标，哪一块就从那儿拖不动；
   *   c) stage 没在收起态换成「按位移判点击」那套 props —— 球上没按钮可点，
   *      换不回来就是「收起来之后展不开了」，而画面上那颗球看着一切正常；
   *   d) 那条 IPC 的通道名三个文件各写一遍（分属两个 tsconfig，类型也共享不了）。
   * ------------------------------------------------------------------ */
  const collapseFn = /export function setBarCollapsed\([\s\S]*?\n\}/.exec(ft);
  const orderSeq = collapseFn ? (collapseFn[0].match(/setMinimumSize|setBounds/g) ?? []).join(',') : '';
  check(
    '收起 / 展开都是「先 setMinimumSize 再 setBounds」，各两次（顺序反了尺寸会被上一档静默夹住）',
    orderSeq === 'setMinimumSize,setBounds,setMinimumSize,setBounds',
    `实测顺序 ${orderSeq || '(没找到 setBarCollapsed)'}`,
  );

  const ballBlock = /barCollapsed \? \([\s\S]*?<\/div>\s*\)\s*:\s*\(/.exec(app);
  check(
    '收起态渲染的是那颗球（.hostball），不是又画了一条控制条',
    Boolean(ballBlock) && /className="hostball"/.test(ballBlock[0]),
  );
  check(
    '球里没有按钮 / 输入控件（整块是拖动区，谁接住鼠标，哪块就从那儿拖不动）',
    Boolean(ballBlock) && !/<(button|input|select|textarea)\b/.test(ballBlock[0]),
  );
  check(
    '收起态下画面区换成「没动过就算点一下」的拖动 props（展开全靠它，球上没有按钮可点）',
    /isFloat \? \(barCollapsed \? ballDragProps : floatDragProps\)/.test(app),
  );
  check(
    '展开只有一个来源：floatBallProps → handleToggleBarCollapsed(false)，且状态从返回值落（别自己先切界面）',
    /floatBallProps\(\(\) => void handleToggleBarCollapsed\(false\)\)/.test(app) &&
      /setTiles\(await api\.setBarCollapsed\(collapsed\)\)/.test(app),
  );

  const ballCss = /\.hostball\s*\{([^}]*)\}/.exec(css);
  check(
    '球铺满整扇窗口（窗口本身就是 152x40，胶囊贴边画才看不出四角）',
    Boolean(ballCss) && /height:\s*100%/.test(ballCss[1]),
    ballCss ? ballCss[1].replace(/\s+/g, ' ').slice(0, 80) : '没找到 .hostball',
  );
  check(
    '球里没有 pointer-events（给它 auto 之类等于自断拖动区，整颗球会拖不动）',
    Boolean(ballCss) && !/pointer-events/.test(ballCss[1]),
  );
  check(
    'set-bar-collapsed 这个通道名三处一致：主进程 / preload / 类型定义',
    ft.includes("'float:set-bar-collapsed'") &&
      preloadSrc.includes("'float:set-bar-collapsed'") &&
      read('apps/desktop/src/types/global.d.ts').includes('setBarCollapsed'),
  );

  /* 收起成球时**那层画面不能被一起收掉** —— 它才是帧泵的源（小窗拿不到媒体轨道，
     画面全靠主窗口搬）。谁哪天顺手把它挪进「球 / 条」的某个分支、或者在它外面套一个
     `barCollapsed` 条件，表现是所有小窗全黑、而控制台一句话都没有 —— 第 2 组也接不住
     （那组用的是自己的源窗口，根本不看 App.tsx）。
     所以判据不是「它在不在」而是「它归不归那个三元管」：先框出整个 `barCollapsed ? … : …`，
     再要求这段里没有它、且它前面那截（三元到它之间）也不许出现 `barCollapsed`。 */
  const splitBlock = /barCollapsed \? \([\s\S]*?\n\s*\)\}/.exec(app);
  const gapAfterSplit = splitBlock
    ? app.slice(splitBlock.index + splitBlock[0].length, app.indexOf('className="hostbar__videos"'))
    : '';
  const videoLayerAt = app.indexOf('className="hostbar__videos"');
  check(
    '搬帧那层画面不归「球 / 条」那个三元管（收起时把它也收掉的话，小窗全黑且不报错）',
    Boolean(splitBlock) &&
      videoLayerAt > 0 &&
      !splitBlock[0].includes('hostbar__videos') &&
      !/barCollapsed/.test(gapAfterSplit),
    splitBlock
      ? `分支块 ${splitBlock[0].length} 字符，三元之后到画面层 ${gapAfterSplit.length} 字符`
      : '没匹配到收起分支（正则要跟着改结构一起改）',
  );
}

/* ------------------------------------------------------------------ *
 * 第 4 组：浮窗的拖动与缩放（不可聚焦窗口的自绘拖动）
 *
 * 为什么必须单独验：浮窗是 `setFocusable(false)` 的窗口，而**系统的标题栏拖动与
 * 边框缩放都会先激活窗口** —— 在非激活窗口上这两条路都不成立，表现就是「浮窗拖不动」，
 * 而且它**报不出任何错**（没有任何 API 会告诉你「这个窗口不让你拖」）。
 * 所以拖动/缩放改成了渲染层自绘、走 IPC 落 `setBounds`，这条新链路得自己验。
 *
 * 三条判据：
 *   ① 浮窗开着（已不可聚焦）时，move / resize 真的改得动窗口几何；
 *   ② 下限被卡住；
 *   ③ **不是主窗口**的发送方搬不动它 —— 对照组，靠 `isHostSender` 那道闸。
 * ------------------------------------------------------------------ */

async function groupDrag() {
  console.log('\n浮窗拖动组（不可聚焦窗口的自绘拖动，真模块 + 真 preload）');

  const wm = require(path.join(WORK, 'window-mode.cjs'));
  const area = screen.getPrimaryDisplay().workArea;

  const win = makeWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(900, area.width - 120),
    height: Math.min(560, area.height - 120),
    show: true,
    title: 'GameShare 检查用浮窗',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%23111"></body>');
  wm.setPrimaryWindow(win);
  wm.registerWindowModeHandlers();

  // 进浮窗：下限放宽到 260x150、窗口挪到右下角、并且**变成不可聚焦**
  await win.webContents.executeJavaScript('window.gameShare.windowMode.setEnabled(true)');
  await sleep(250);
  check(
    '进浮窗后窗口不可聚焦 —— 这正是系统那套拖动失效的原因',
    win.isFocusable() === false,
  );

  const start = win.getBounds();
  await win.webContents.executeJavaScript(
    `window.gameShare.windowMode.moveTo(${area.x + 60}, ${area.y + 60}, ${start.width}, ${start.height})`,
  );
  await waitFor(() => win.getBounds().x === area.x + 60 && win.getBounds().y === area.y + 60, 2000);
  const moved = win.getBounds();
  check(
    '不可聚焦的浮窗能被渲染层拖动（float:move-to → setBounds）',
    moved.x === area.x + 60 && moved.y === area.y + 60,
    `${start.x},${start.y} → ${moved.x},${moved.y}，期望 ${area.x + 60},${area.y + 60}`,
  );

  await win.webContents.executeJavaScript('window.gameShare.windowMode.resizeTo(700, 400)');
  await waitFor(() => win.getBounds().width === 700, 2000);
  const sized = win.getBounds();
  check(
    '浮窗能被渲染层缩放（float:resize-to → setBounds）',
    sized.width === 700 && sized.height === 400,
    `实测 ${sized.width}x${sized.height}，期望 700x400`,
  );

  await win.webContents.executeJavaScript('window.gameShare.windowMode.resizeTo(10, 10)');
  await sleep(300);
  const clamped = win.getBounds();
  check(
    '缩放卡在浮窗下限上（10x10 被抬到 260x150）',
    clamped.width >= 260 && clamped.height >= 150,
    `实测 ${clamped.width}x${clamped.height}，下限 260x150`,
  );

  /* ---- 对照组：不是主窗口的发送方搬不动它 ---- */
  const before = win.getBounds();
  const rogue = makeWindow({
    x: area.x + 600,
    y: area.y + 400,
    width: 220,
    height: 120,
    show: false,
    webPreferences: {
      preload: path.join(WORK, 'rogue-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await rogue.loadURL('data:text/html;charset=utf-8,<body>rogue</body>');
  await sleep(500);
  const after = win.getBounds();
  check(
    '别的窗口发来的拖动 / 缩放请求被丢掉（只认主窗口，小窗手里也有 ipcRenderer）',
    after.x === before.x &&
      after.y === before.y &&
      after.width === before.width &&
      after.height === before.height,
    `${before.x},${before.y} ${before.width}x${before.height} → ${after.x},${after.y} ${after.width}x${after.height}`,
  );

  rogue.destroy();
  win.destroy();
}

/* ------------------------------------------------------------------ *
 * 第 5 组：在「浮窗已经开着」的窗口上拆分
 *
 * 为什么单开一组。浮窗模式给主窗口设了 260x150 的下限（`enterFloat`），
 * 而拆分要把主窗口收成一条 **620x76** 的控制条（`collapseHost`）——
 * **两档下限在同一扇窗口上打架**：76 被静默夹回 150，窗口比设计的高一倍，
 * 控件垂直居中、下面空出一大块同色黑边。用户看到的是「这条控制条怪怪的、拖不动」。
 *
 * 夹的动作不报错、也没有任何 API 会回一句「你要的尺寸被抬了」，所以第 1~4 组
 * 都没接住它 —— **它们从没在浮窗开着的窗口上拆过**（第 1 组的拆分跑在自己那份
 * 窗口上，那扇窗口没进过浮窗，下限就不是 150）。2026-09-17 第三次实测踩到。
 *
 * 四条判据：
 *   ① 拆分后真的是 620x76，不是被夹住的 620x150；
 *   ② 控制条贴 workArea 底部（高度错了这条也会跟着错）；
 *   ③ 合并后几何还回拆分前那一份；
 *   ④ 合并后**下限还回浮窗那一档** —— 再压到 10x10 会被抬回 260x150。
 *      少了这半句，修完就是「拆分对了、合并回来的浮窗再也缩不小」。
 * ------------------------------------------------------------------ */

async function groupSplitOverFloat() {
  console.log('\n拆分叠在浮窗上（两档最小尺寸打架的那条路）');

  const wm = require(path.join(WORK, 'window-mode.cjs'));
  const ft = require(path.join(WORK, 'float-tiles.cjs'));
  const area = screen.getPrimaryDisplay().workArea;

  const num = (src, pattern) => {
    const m = pattern.exec(src);
    return m ? Number(m[1]) : NaN;
  };
  const ftSrc = fs.readFileSync(path.join(DESKTOP, 'electron', 'float-tiles.ts'), 'utf8');
  const wmSrc = fs.readFileSync(path.join(DESKTOP, 'electron', 'window-mode.ts'), 'utf8');
  const barWidth = num(ftSrc, /const BAR_WIDTH = (\d+);/);
  const barHeight = num(ftSrc, /const BAR_HEIGHT = (\d+);/);
  const barMargin = num(ftSrc, /const BAR_MARGIN = (\d+);/);
  const floatMinW = num(wmSrc, /const FLOAT_MIN_WIDTH = (\d+);/);
  const floatMinH = num(wmSrc, /const FLOAT_MIN_HEIGHT = (\d+);/);
  const hostMinW = num(ftSrc, /const HOST_FLOAT_MIN_WIDTH = (\d+);/);
  const hostMinH = num(ftSrc, /const HOST_FLOAT_MIN_HEIGHT = (\d+);/);

  /**
   * 两份「浮窗最小尺寸」常量必须一样，但**它们不能互相 import**（window-mode 已经
   * import 了 float-tiles，反向 import 会成环，见 float-tiles.ts 里那段注释）——
   * 只能各存一份、拿这条断言对值。改了一边忘另一边就红在这里。
   */
  check(
    'float-tiles 的 HOST_FLOAT_MIN_* 与 window-mode 的 FLOAT_MIN_* 一致（成环所以只能各存一份）',
    hostMinW === floatMinW && hostMinH === floatMinH,
    `window-mode ${floatMinW}x${floatMinH} vs float-tiles ${hostMinW}x${hostMinH}`,
  );

  /**
   * 第 4 组把 window-mode 的 enabled 留在 true 上了，先清掉 ——
   * 不清的话下面那次 `setEnabled(true)` 会因为 `next === enabled` 直接早退，
   * 下限根本不会被设成 260x150，这组就永远红不了（**假绿比红更糟**）。
   *
   * 刻意放在**登记本组窗口之前**：这时 window-mode 的 `primaryWindow()` 还是 null，
   * `exitFloat` 里「还原上次几何」的动作整个跳过 —— 那份 `restoreBounds` 记的是
   * 第 4 组那扇已经销毁的窗口，照着它还等于把这扇新窗挪走。
   */
  wm.setFloatEnabled(false);

  const win = makeWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(900, area.width - 120),
    height: Math.min(560, area.height - 120),
    show: true,
    title: 'GameShare 检查用浮窗（拆分叠加组）',
    // 走真 preload：这组每一步都从渲染层发 IPC，和用户点出来的路径一致
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%23111"></body>');

  wm.setPrimaryWindow(win);
  /**
   * float-tiles 那份模块的 `hostWindow` 还指着第 1 组那扇**已经销毁**的窗口，
   * 得改指过来 —— 否则 `collapseHost` 一句 `isDestroyed()` 就早退，
   * 窗口压根不会被收成控制条，这条断言就成了「永远绿」。
   */
  ft.setTilesHostWindow(win);
  // 先保证拆分关着、对端列表是空的，否则 setEnabled(true) 会顺手建一堆小窗出来
  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(false)');
  await win.webContents.executeJavaScript('window.gameShare.floatTiles.syncPeers([])');

  await win.webContents.executeJavaScript('window.gameShare.windowMode.setEnabled(true)');
  await sleep(250);

  // 前置：确认浮窗那一档下限真的生效了（压到 10x10，看它被抬到哪儿）。
  // 没有这一步，判据 ① 的「绿」也可能是「下限压根没设上」，而不是「修好了」
  win.setBounds({ ...win.getBounds(), width: 10, height: 10 });
  await sleep(200);
  const floatClamped = win.getBounds();
  check(
    `前置：浮窗下限 ${floatMinW}x${floatMinH} 已生效`,
    floatClamped.width >= floatMinW && floatClamped.height >= floatMinH,
    `压到 10x10 后实测 ${floatClamped.width}x${floatClamped.height}`,
  );

  win.setBounds({ x: area.x + 40, y: area.y + 40, width: 900, height: 560 });
  await sleep(200);
  const floatBounds = win.getBounds();

  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(true)');
  await waitFor(() => win.getBounds().height === barHeight, 2000);
  const bar = win.getBounds();
  check(
    `拆分后主窗口收成 ${barWidth}x${barHeight}（不被浮窗下限 ${floatMinH} 夹住）`,
    bar.width === barWidth && bar.height === barHeight,
    `实测 ${bar.width}x${bar.height}，期望 ${barWidth}x${barHeight}`,
  );
  check(
    '控制条贴 workArea 底部',
    bar.y === area.y + area.height - barHeight - barMargin,
    `实测 y=${bar.y}，期望 ${area.y + area.height - barHeight - barMargin}`,
  );

  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(false)');
  await sleep(250);
  const merged = win.getBounds();
  check(
    '合并后几何还回拆分前那一份',
    merged.x === floatBounds.x &&
      merged.y === floatBounds.y &&
      merged.width === floatBounds.width &&
      merged.height === floatBounds.height,
    `${floatBounds.x},${floatBounds.y} ${floatBounds.width}x${floatBounds.height} → ${merged.x},${merged.y} ${merged.width}x${merged.height}`,
  );

  win.setBounds({ ...merged, width: 10, height: 10 });
  await sleep(200);
  const mergedClamped = win.getBounds();
  check(
    `合并后下限还回浮窗档（压到 10x10 抬回 ${floatMinW}x${floatMinH}，不是停在控制条的 ${barHeight}）`,
    mergedClamped.width >= floatMinW && mergedClamped.height >= floatMinH,
    `实测 ${mergedClamped.width}x${mergedClamped.height}`,
  );

  await win.webContents.executeJavaScript('window.gameShare.windowMode.setEnabled(false)');

  /* ---- 无边框之后，窗口按钮是自己发的：真 preload → 真 IPC 走一遍 ----
     这几个 channel 一旦写错（preload 与主进程各写一份名字、对不上），表现是
     **「点了没反应」而且不报错** —— 和「浮窗拖不动」是同一类静默失效，所以真跑一次。 */
  await win.webContents.executeJavaScript(
    // 末尾那个 `0` 不能省：executeJavaScript 要把结果结构化克隆回主进程，
    // 而 onMaximized 的返回值是「退订函数」—— 函数不可克隆，直接抛 "could not be cloned"
    'window.__max = []; window.gameShare.windowControl.onMaximized((v) => window.__max.push(v)); 0',
  );

  await win.webContents.executeJavaScript('window.gameShare.windowControl.minimize()');
  await waitFor(() => win.isMinimized(), 2000);
  check('界面上那个最小化按钮真的把窗口最小化了（preload → win:minimize）', win.isMinimized());

  win.restore();
  await sleep(200);

  await win.webContents.executeJavaScript('window.gameShare.windowControl.toggleMaximize()');
  await waitFor(() => win.isMaximized(), 2000);
  check('最大化按钮生效（preload → win:toggle-maximize）', win.isMaximized());
  const maxEvents = await win.webContents.executeJavaScript('window.__max');
  check(
    '最大化状态推回了页面（按钮图标要跟着换；双击顶栏也会最大化，所以不能自己记）',
    maxEvents.includes(true),
    `收到的推送：${JSON.stringify(maxEvents)}`,
  );

  await win.webContents.executeJavaScript('window.gameShare.windowControl.toggleMaximize()');
  await waitFor(() => !win.isMaximized(), 2000);
  check('同一个按钮再点一次是还原（它是个开关，不是单向最大化）', !win.isMaximized());

  await win.webContents.executeJavaScript('window.gameShare.windowControl.close()').catch(() => {});
  await waitFor(() => win.isDestroyed(), 2000);
  check('关闭按钮真的关掉了窗口（preload → win:close）', win.isDestroyed());

  // 上面那条要是没成，别把这扇窗留给用户
  if (!win.isDestroyed()) win.destroy();
}

/* ------------------------------------------------------------------ *
 * 第 8 组：浮窗的控件入口（常驻可见 + 点得开）
 *
 * 为什么单开一组：2026-09-18 实测只开自己一端就切进浮窗，看到的是一条控件都没有的
 * 空态提示 —— 想退出去只能靠 `Ctrl+Alt+G`。两个原因叠在一起：
 *   ① 控件原先挂在 `isFloat` 那个分支里，而分支链最前面还有一层 `!inRoom`
 *      （「进入房间后，这里显示其他玩家的画面」）—— 没进房时整块被它接走，
 *      控件连渲染都没有（所以这一组**刻意不进房**）；
 *   ② 就算进了房，那条 `.floatbar` 也只是 `opacity: 0`、等鼠标进窗才浮出来 ——
 *      「只在 hover 时才出现」等于没有（与 4.13.1 的名字牌同一条判据）。
 *
 * 这组要证明四件事，全部在**真渲染层页面**上量：
 *   A. 没进房、没 hover，左上角那个入口也看得见 —— 静态断言接不住这条：
 *      元素被 `!inRoom` 拦掉时，源码里那几个字符串照样在；
 *   B. 它真占了像素（藏起来那块必须明显变暗，画面别处基本不变）；
 *   C. 真鼠标点一下能展开那条控件、再点一下收回（入口与开关是一条链）；
 *   D. 窗口压到最窄（260x150）时展开也不把「退出浮窗」裁到窗口外 ——
 *      点开却看不见按钮，等于仍然没有入口。
 * ------------------------------------------------------------------ */

async function groupFloatMenu() {
  console.log('\n浮窗控件入口组（真页面 + 真 preload，没进房、不 hover）');

  const built = buildRenderer();
  console.log(`· 渲染层已重建（vite build ${built}）`);

  const wm = require(path.join(WORK, 'window-mode.cjs'));
  const area = screen.getPrimaryDisplay().workArea;

  const win = makeWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: 560,
    height: 320,
    show: true,
    frame: false,
    title: 'GameShare 检查用浮窗（控件入口组）',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(DESKTOP, 'dist', 'index.html'));
  await sleep(900);

  /*
   * 页面上会蹦出几行 `Error occurred in handler for 'server:get-status' / 'tunnel:get-status'`：
   * 真界面挂载时就去问这两个状态，而这个检查脚本只注册了窗口相关的通道。
   * **属于预期噪音**，不是这一组失败 —— 判据只看每行的 ✓ / ✗。
   */
  /**
   * 2026-09-21 起浮窗控件条改纯 hover 显现，这组不再点击按钮 —— clickBox
   * 的用法（真输入链路而非 `el.click()`）由其他组沿用；此处 hover 触发直接
   * 用 `sendInputEvent({ type: 'mouseMove' })`。
   */

  wm.setPrimaryWindow(win);
  /**
   * `registerWindowModeHandlers` **不幂等** —— `ipcMain.handle` 对同一个通道
   * 重复注册会直接抛（第 4 组已经注册过了），照抄别的组那样裸调一次，
   * 整组会在第一句断言之前就崩掉。注册过就用现成的。
   */
  try {
    wm.registerWindowModeHandlers();
  } catch {
    /* 第 4 组已经注册过了 —— 这正是预期 */
  }
  await win.webContents.executeJavaScript('window.gameShare.windowMode.setEnabled(true)');
  await sleep(300);

  // 前置：确认这扇窗「没进房」—— 这组的整个前提，也是实机反馈时的原始状态
  const emptyText = await win.webContents.executeJavaScript(
    "((document.querySelector('.stage__empty') || {}).textContent || '').trim()",
  );
  check(
    '前置：这扇窗确实还没进房（用户反馈时就是这个状态）',
    emptyText.includes('进入房间后'),
    `空态文案「${emptyText.slice(0, 20)}…」`,
  );

  /* ---- A. 控件条在 DOM 里、没 hover 时收着（2026-09-21 起：纯 hover 显现，
       常驻入口按钮已删 —— 显现路径只有鼠标进窗这一条，`Ctrl+Alt+G` 兜底） ---- */
  const bar = await readBox(win, '.floatbar');
  check(
    '没进房时控件条也在（挂在分支链外面，`!inRoom` 空态拦不住它）',
    Boolean(bar) && bar.width > 20,
    bar ? `${Math.round(bar.width)}x${Math.round(bar.height)} @ ${Math.round(bar.x)},${Math.round(bar.y)}` : '没找到 .floatbar',
  );
  if (!bar) {
    win.destroy();
    return;
  }
  check(
    '鼠标没进窗时控件条是收着的（不摊在画面上挡视线）',
    bar.opacity === 0,
    `opacity ${bar.opacity}`,
  );

  /* ---- B. 真鼠标进窗：控件条 hover 显现 / 移出隐藏 + 像素对照 ---- */
  /*
   * 先撑回一个正常尺寸再验：进浮窗时窗口用的是**上次记住的几何**（这组跑在
   * 收起组后面，那份记录正好是 152x40 那一档，被 260x150 的下限抬上来），
   * 不撑开的话「宽窗也不裁」就跟下面那条窄窗断言量的是同一个尺寸，白写一条。
   */
  win.setBounds({ ...win.getBounds(), width: 520, height: 300 });
  await sleep(250);
  const wideContent = win.getContentBounds();

  // 鼠标移到窗口中间 —— 真实输入管线，CSS :hover 随之生效
  await win.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 150 });
  await sleep(350); // 等 opacity 过渡（0.15s）走完
  const opened = await readBox(win, '.floatbar');
  check(
    '鼠标进窗，控件条 hover 显现（拆分/退出直接可见，不用先点一次）',
    Boolean(opened) && opened.opacity === 1,
    opened ? `opacity ${opened.opacity}` : '没找到 .floatbar',
  );

  /* 像素对照：条真的画上去了（防「opacity 是 1 但什么都没渲染」的假阳性）。
     bar 是 rgba(12,14,19,0.9) 的实心底，与背后画面的亮度差足够大；
     之前想用右下角缩放手柄当对照，但它是 16x16 的半透明条纹，均值差只有 0.3。 */
  const content = win.getContentBounds();
  const imgOpen = await win.capturePage();
  await win.webContents.sendInputEvent({ type: 'mouseLeave', x: -50, y: -50 });
  await sleep(350);
  const imgClosed = await win.capturePage();

  const size = imgOpen.getSize();
  const scale = size.width / content.width;
  const toBox = (x, y, w, h) => ({
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  });
  const barBox = toBox(opened.x + 4, opened.y + 4, opened.width - 8, opened.height - 8);
  const otherBox = toBox(10, content.height - 70, 80, 60);

  const barOpenLuma = meanLuma(imgOpen, barBox);
  const barClosedLuma = meanLuma(imgClosed, barBox);
  const otherOpen = meanLuma(imgOpen, otherBox);
  const otherClosed = meanLuma(imgClosed, otherBox);
  console.log(
    `    条盒内平均亮度：显现 ${barOpenLuma.toFixed(1)} → 收走 ${barClosedLuma.toFixed(1)}；` +
      `画面别处 ${otherOpen.toFixed(1)} → ${otherClosed.toFixed(1)}`,
  );
  check(
    '条真的占了像素（显现与收走两帧，条那块明显变化）',
    Math.abs(barOpenLuma - barClosedLuma) > 8,
    `差 ${Math.abs(barOpenLuma - barClosedLuma).toFixed(1)}（阈值 8）`,
  );
  check(
    '条只占右上角一条、没糊在画面上（别处两帧基本一致）',
    Math.abs(otherOpen - otherClosed) < 3,
    `差 ${Math.abs(otherOpen - otherClosed).toFixed(1)}（阈值 3）`,
  );

  const exitBtn = await readBox(win, '.floatbar__exit:last-of-type');
  /*
   * 判据是**整条**都在窗口里，不是只看「退出浮窗」那颗按钮。
   * 条是右对齐的（`right: 6px`），末尾那颗按钮天生贴着右边、不会被裁；真正会被
   * 挤出窗口的是左边——把手、透明度滑杆。所以要量条的左边缘：
   * `.floatbar` 那条 `max-width + flex-wrap` 就是为它准备的（窄窗里折行而不是溢出）。
   */
  const barInsideWide =
    Boolean(opened) &&
    opened.x >= -0.5 &&
    opened.y >= -0.5 &&
    opened.x + opened.width <= wideContent.width + 0.5 &&
    opened.y + opened.height <= wideContent.height + 0.5;
  const insideNow =
    barInsideWide &&
    Boolean(exitBtn) &&
    exitBtn.x >= 0 &&
    exitBtn.y >= 0 &&
    exitBtn.x + exitBtn.width <= wideContent.width + 0.5 &&
    exitBtn.y + exitBtn.height <= wideContent.height + 0.5;
  check(
    '宽窗下显现，整条控件与「退出浮窗」都完整落在窗口里（显现了却看不见按钮等于没入口）',
    insideNow,
    opened
      ? `条 ${Math.round(opened.x)},${Math.round(opened.y)} ${Math.round(opened.width)}x${Math.round(opened.height)}，窗口 ${wideContent.width}x${wideContent.height}`
      : '没找到 .floatbar',
  );

  // 鼠标移出窗口 → 条收走
  await win.webContents.sendInputEvent({ type: 'mouseLeave', x: -50, y: -50 });
  await sleep(350); // 等 opacity 过渡（0.15s）走完
  const closedAgain = await readBox(win, '.floatbar');
  check(
    '鼠标移出窗口后控件条收走（hover 只在窗口内生效）',
    closedAgain.opacity === 0,
    `opacity ${closedAgain.opacity}`,
  );

  /* ---- D. 压到最窄（260x150）再 hover：整条仍不许被挤出窗口 ---- */
  win.setBounds({ ...win.getBounds(), width: 260, height: 150 });
  await sleep(250);
  const narrow = win.getContentBounds();
  check(
    `前置：窗口确实从 ${wideContent.width}x${wideContent.height} 压到了最小档（否则下面那条是假的）`,
    narrow.width <= 300 && narrow.height <= 160,
    `实测 ${narrow.width}x${narrow.height}`,
  );
  await win.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 70 });
  await sleep(350);
  const narrowOpened = await readBox(win, '.floatbar');
  const narrowExit = await readBox(win, '.floatbar__exit:last-of-type');
  /* 窄窗这一条的判据同样是**整条**：折行之后条的左边缘若被挤出窗口，
     被裁掉的正是拖动把手与透明度滑杆（末尾的按钮贴着右边，反而看不出来） */
  const barInsideNarrow =
    Boolean(narrowOpened) &&
    narrowOpened.x >= -0.5 &&
    narrowOpened.y >= -0.5 &&
    narrowOpened.x + narrowOpened.width <= narrow.width + 0.5 &&
    narrowOpened.y + narrowOpened.height <= narrow.height + 0.5;
  const insideNarrow =
    barInsideNarrow &&
    Boolean(narrowExit) &&
    narrowExit.x >= 0 &&
    narrowExit.y >= 0 &&
    narrowExit.x + narrowExit.width <= narrow.width + 0.5 &&
    narrowExit.y + narrowExit.height <= narrow.height + 0.5;
  check(
    `窗口压到最窄（${narrow.width}x${narrow.height}）时显现，整条控件与「退出浮窗」都还在窗口里`,
    Boolean(narrowOpened) && narrowOpened.opacity === 1 && insideNarrow,
    narrowOpened
      ? `条 ${Math.round(narrowOpened.x)},${Math.round(narrowOpened.y)} ${Math.round(narrowOpened.width)}x${Math.round(narrowOpened.height)}，窗口 ${narrow.width}x${narrow.height}`
      : '没找到 .floatbar',
  );

  /* 最挤的尺寸下，显现的条**不许压住右下角的缩放手柄**：
     手柄被盖住，缩放功能在 hover 期间就点不着（靠 `.floatbar` 的
     `max-width` 保证条不向下延伸到底）。 */
  const grip = await readBox(win, '.floatgrip');
  const overlapsGrip =
    Boolean(narrowOpened) &&
    Boolean(grip) &&
    narrowOpened.x < grip.x + grip.width &&
    grip.x < narrowOpened.x + narrowOpened.width &&
    narrowOpened.y < grip.y + grip.height &&
    grip.y < narrowOpened.y + narrowOpened.height;
  check(
    '最窄窗口里，显现的控件条不压住右下角的缩放手柄（压住就没法缩放了）',
    Boolean(narrowOpened) && Boolean(grip) && !overlapsGrip,
    narrowOpened && grip
      ? `条 y ${Math.round(narrowOpened.y)}..${Math.round(narrowOpened.y + narrowOpened.height)} vs 手柄 y ${Math.round(grip.y)}..${Math.round(grip.y + grip.height)}`
      : '没找到 .floatbar 或 .floatgrip',
  );

  wm.setFloatEnabled(false);
  win.destroy();
}

/* ------------------------------------------------------------------ *
 * 第 6 组：剪贴板（复制房间码 / 复制邀请）
 *
 * 为什么单独验：这两个按钮曾经**完全没反应、也不报错** —— 渲染层的
 * `navigator.clipboard.writeText` 要的权限被 main.ts 那个白名单拒掉（抛
 * `NotAllowedError`），而 App.tsx 把它 catch 成了一行日志（2026-09-17 实机报的
 * 「复制和邀请按钮根本无效」）。
 *
 * 换成走主进程之后，要钉住两件事：
 *   ① IPC 真的把字写进了**系统剪贴板** —— 不是页面自己以为写成了，
 *      而是主进程 `clipboard.readText()` 读得回来（「通道到了」≠「数据到了」）；
 *   ② 渲染层那条路**在这个工程的配置下确实走不通** —— 否则这条 IPC 就是多余的，
 *      下次有人顺手删掉，按钮又会安静地坏一遍。
 *
 * ⚠️ 这组会动**系统剪贴板**（真写真好），所以开头存一份原文、结尾还回去。
 * ------------------------------------------------------------------ */

async function groupClipboard() {
  console.log('\n剪贴板组（真 preload → 真 handler → 真系统剪贴板）');

  const { clipboard } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  // 真产物：prepare() 单独打的 clipboard.cjs，不是在这里抄一份 handler
  require(path.join(WORK, 'clipboard.cjs')).registerClipboardHandlers();

  // 用完还回去，别把用户正在用的剪贴板内容顶掉
  const savedClipboard = clipboard.readText();

  const win = makeWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(520, area.width - 120),
    height: 300,
    show: true,
    title: 'GameShare 检查用窗口（剪贴板组）',
    // 真 preload：下面每一步都从渲染层发 IPC，和用户点按钮的路径一致
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  /**
   * 用 **file://** 页面，不用 `data:` —— 打包后主窗口走的就是 `loadFile`（file://）。
   * `data:` 是不透明源，`navigator.clipboard` 在那种页面上可能压根不存在，
   * 那样下面那条对照组的失败原因就变成了「源不对」，而不是我们要验的那条权限。
   */
  const checkPage = path.join(CACHE_ROOT, 'clipboard-check.html');
  fs.writeFileSync(checkPage, '<body style="margin:0;background:#111"></body>', 'utf8');
  await win.loadFile(checkPage);
  win.focus();
  await sleep(300);

  const run = (expr) => win.webContents.executeJavaScript(expr);

  check(
    '渲染层拿得到 clipboard.writeText 这个面（preload 挂上了，不然按钮点了就是没反应）',
    (await run('typeof (window.gameShare && window.gameShare.clipboard && window.gameShare.clipboard.writeText)')) ===
      'function',
  );

  /** 等系统剪贴板变成期望值。主进程那次写是同步的，留点余量只是防机器忙。 */
  const landed = async (want) => {
    for (let i = 0; i < 20; i++) {
      if (clipboard.readText() === want) return true;
      await sleep(50);
    }
    return false;
  };

  // 哨兵：先确认剪贴板里不是待会儿要写的那个值，否则读回一致也可能是巧合
  const sentinel = `SENTINEL-${Date.now()}`;
  clipboard.writeText(sentinel);
  const token = `房间码 7Y3HCQ · ${Date.now()}`;
  const wrote = await run(`window.gameShare.clipboard.writeText(${JSON.stringify(token)})`);
  const back = await landed(token);
  check(
    '复制真的写进了系统剪贴板（主进程读回来 == 渲染层发过去的原文）',
    wrote === true && back,
    `返回 ${JSON.stringify(wrote)}，系统剪贴板读回 ${JSON.stringify(clipboard.readText())}`,
  );

  // 边界：空串不该被写进去（否则用户粘出来是空的，还以为复制坏了）
  clipboard.writeText(sentinel);
  const emptyWrote = await run("window.gameShare.clipboard.writeText('')");
  await sleep(150);
  check(
    '空串被拒绝、且不覆盖剪贴板里原有内容',
    emptyWrote === false && clipboard.readText() === sentinel,
    `返回 ${JSON.stringify(emptyWrote)}，剪贴板仍是 ${JSON.stringify(clipboard.readText())}`,
  );

  /**
   * 对照组：按 main.ts 的白名单姿态（只放行 media / display-capture）装一个权限处理器，
   * 再看渲染层那条老路还走不走得通。**期望是走不通** —— 这条就是用来证明上面那个 IPC
   * 不是多余的。（main.ts 里那份白名单本身由 groupStatic 钉住。）
   */
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
  const rendererPath = await run(`(async () => {
    try { await navigator.clipboard.writeText('renderer-path-should-fail'); return 'ok'; }
    catch (e) { return (e && e.name ? e.name : 'Error') + ': ' + (e && e.message ? e.message : ''); }
  })()`);
  check(
    '对照组：渲染层 navigator.clipboard 在本工程配置下写不进去（证明这条 IPC 不是多余的）',
    rendererPath !== 'ok',
    `实测 ${rendererPath}`,
  );

  clipboard.writeText(savedClipboard);
  win.destroy();
}

/* ------------------------------------------------------------------ *
 * 第 7 组：控制条收起成球（三档最小尺寸里最难的那一档）
 *
 * 为什么单独验。收起要在**同一扇窗口**上再切一次最小尺寸，而这时窗口带着控制条
 * 那一档的下限（620x76）—— 小球要的是 152x40，**宽和高两个方向都会被夹**。
 * 夹的动作不报错、也没有任何 API 会回一句「你要的尺寸被抬了」，只有主动问
 * `getBounds()` 才看得出来（第 5 组踩过的那次是高度被夹回 150，用户看到的是一条
 * 「比设计高一倍、下面一片同色黑边」的条，还以为是窗口坏了）。
 *
 * 另一半是第 6 组的翻版：**「状态到了」≠「界面切了」**。渲染层切不切成球，
 * 唯一的依据是状态里带没带 `barCollapsed` 这个字段 —— 所以不光读 invoke 的返回值，
 * 还挂一次订阅，看它真的从推送里过线。
 *
 * 判据：
 *   ① 收起后真的是 152x40，不是被控制条那一档夹住的；
 *   ② 贴 workArea 右下角（用屏幕 bounds 会压到任务栏下面）；
 *   ③ barCollapsed 跟着状态推回页面；小窗一个都不能少（收的是窗口，不是模式）；
 *   ④ 重复收起是幂等的；
 *   ⑤ 展开回到收起前那一份几何，连位置一起还；
 *   ⑥ 没进拆分时调它不炸、也不搬窗口。
 * ------------------------------------------------------------------ */
async function groupCollapse() {
  console.log('\n收起组（控制条 → 右下角那颗球）');

  const ft = require(path.join(WORK, 'float-tiles.cjs'));
  const area = screen.getPrimaryDisplay().workArea;
  const ftSrc = fs.readFileSync(path.join(DESKTOP, 'electron', 'float-tiles.ts'), 'utf8');
  const num = (pattern) => {
    const m = pattern.exec(ftSrc);
    return m ? Number(m[1]) : NaN;
  };
  const barWidth = num(/const BAR_WIDTH = (\d+);/);
  const barHeight = num(/const BAR_HEIGHT = (\d+);/);
  const ballWidth = num(/const BALL_WIDTH = (\d+);/);
  const ballHeight = num(/const BALL_HEIGHT = (\d+);/);
  const ballMargin = num(/const BALL_MARGIN = (\d+);/);

  /* 这几条常量是下面所有判据的期望值来源。正则一旦对不上，后面几条会拿 NaN 去比 ——
     那种会红还好，怕的是哪天夹住了反而「相等」成假绿，所以先单独钉一条。 */
  check(
    '四档几何常量都从源码里读到了（正则失效会让下面几条全部失去参照）',
    [barWidth, barHeight, ballWidth, ballHeight, ballMargin].every(Number.isFinite),
    `条 ${barWidth}x${barHeight}、球 ${ballWidth}x${ballHeight}、边距 ${ballMargin}`,
  );

  const win = makeWindow({
    x: area.x + 60,
    y: area.y + 60,
    width: Math.min(880, area.width - 160),
    height: Math.min(540, area.height - 160),
    show: true,
    title: 'GameShare 检查用控制条（收起组）',
    // 真 preload：这里每一步都从渲染层发 IPC，和用户点出来的路径一致
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%23111"></body>');

  /* float-tiles 那份模块的 hostWindow 还指着上一组那扇已经销毁的窗口，得改指过来 ——
     否则 `collapseHost` 一句 `isDestroyed()` 就早退，窗口压根不会被收成控制条，
     这整组就成了「永远绿」。 */
  ft.setTilesHostWindow(win);
  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(false)');
  await win.webContents.executeJavaScript(
    `window.gameShare.floatTiles.syncPeers([{ peerId: 'p1', name: '甲' }, { peerId: 'p2', name: '乙' }])`,
  );
  // 订阅状态推送 —— 界面切不切成球全靠这个字段，所以这里也走真推送而不是返回值
  await win.webContents.executeJavaScript(
    'window.__st = []; window.gameShare.floatTiles.onStatus((s) => window.__st.push(s)); 0',
  );

  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(true)');
  await waitFor(() => win.getBounds().height === barHeight, 2500);
  const barBefore = win.getBounds();

  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setBarCollapsed(true)');
  await waitFor(() => win.getBounds().height === ballHeight, 2000);
  const ball = win.getBounds();
  check(
    `收起后是 ${ballWidth}x${ballHeight}（宽和高都没被控制条那一档的 ${barWidth}x${barHeight} 夹住）`,
    ball.width === ballWidth && ball.height === ballHeight,
    `实测 ${ball.width}x${ball.height}，期望 ${ballWidth}x${ballHeight}`,
  );
  check(
    '小球贴 workArea 右下角（改用屏幕 bounds 会压到任务栏下面）',
    ball.x === area.x + area.width - ballWidth - ballMargin &&
      ball.y === area.y + area.height - ballHeight - ballMargin,
    `实测 (${ball.x},${ball.y})，期望 (${area.x + area.width - ballWidth - ballMargin},${
      area.y + area.height - ballHeight - ballMargin
    })`,
  );

  const pushed = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__st)'));
  check(
    'barCollapsed 跟着状态推回了页面（不带这个字段，窗口已经是球了、界面还停在「条」上）',
    pushed.some((s) => s && s.barCollapsed === true),
    `共 ${pushed.length} 次推送，最后一条 ${JSON.stringify(pushed[pushed.length - 1] || null)}`,
  );
  const stateRaw = await win.webContents.executeJavaScript(
    'window.gameShare.floatTiles.getStatus().then((s) => JSON.stringify({ n: s.tiles.length, c: s.barCollapsed }))',
  );
  const state = JSON.parse(stateRaw);
  check(
    `收起只是把主窗口缩小，小窗一个都不少（实测 ${state.n} 个，期望 2）`,
    state.n === 2 && state.c === true,
    `状态 ${stateRaw}`,
  );

  const again = await win.webContents.executeJavaScript(
    'window.gameShare.floatTiles.setBarCollapsed(true)',
  );
  await sleep(250);
  const ball2 = win.getBounds();
  check(
    '重复收起是幂等的（几何一动不动）',
    Boolean(again) &&
      again.barCollapsed === true &&
      ball2.x === ball.x &&
      ball2.y === ball.y &&
      ball2.width === ball.width &&
      ball2.height === ball.height,
    `返回 barCollapsed=${again && again.barCollapsed}，几何 ${ball2.width}x${ball2.height}`,
  );

  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setBarCollapsed(false)');
  await waitFor(() => win.getBounds().height === barHeight, 2000);
  const back = win.getBounds();
  check(
    '展开后回到收起前那一份几何，连位置一起还（只还尺寸的话，条会留在右下角）',
    back.x === barBefore.x &&
      back.y === barBefore.y &&
      back.width === barBefore.width &&
      back.height === barBefore.height,
    `${barBefore.x},${barBefore.y} ${barBefore.width}x${barBefore.height} → ${back.x},${back.y} ${back.width}x${back.height}`,
  );

  /* 边界：拆分关着的时候调它。收起是拆分模式里的东西，这时该原样返回、不碰窗口 ——
     用户合并之后再点一次那个入口，不该看见窗口跳一下。 */
  await win.webContents.executeJavaScript('window.gameShare.floatTiles.setEnabled(false)');
  await sleep(300);
  const idleBefore = win.getBounds();
  const idle = await win.webContents.executeJavaScript(
    'window.gameShare.floatTiles.setBarCollapsed(true)',
  );
  await sleep(250);
  const idleAfter = win.getBounds();
  check(
    '没进拆分时调「收起」不炸、也不搬窗口',
    Boolean(idle) &&
      idle.barCollapsed === false &&
      idleAfter.x === idleBefore.x &&
      idleAfter.y === idleBefore.y &&
      idleAfter.width === idleBefore.width &&
      idleAfter.height === idleBefore.height,
    `返回 barCollapsed=${idle && idle.barCollapsed}，几何 ${idleBefore.width}x${idleBefore.height} → ${idleAfter.width}x${idleAfter.height}`,
  );

  win.destroy();
  await sleep(200);
}

/* ------------------------------------------------------------------ */

async function main() {
  await prepare();
  await groupLoad();
  await groupPump();
  await groupDrag();
  await groupSplitOverFloat();
  await groupCollapse();
  await groupFloatMenu();
  await groupClipboard();
  groupStatic();

  console.log(`\n${failed === 0 ? `✓ 通过（${passed} 项）` : `✗ ${failed} 项未通过`}\n`);
  // .cache 留着：下次跑不用重新打包。它在 .gitignore 里，也不会被 electron-builder 收走。
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(`\n✗ ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }),
);

// 兜底：卡在某个 await 上时别把一堆窗口留在用户屏幕上
// （第 8 组要跑一次 `vite build` 才算真页面，所以这里比原来宽 60 秒）
setTimeout(() => {
  console.error('\n✗ 超时（150 秒），强制退出\n');
  app.exit(1);
}, 150000);
