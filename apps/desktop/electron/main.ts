import path from 'node:path';

import { BrowserWindow, app, ipcMain, shell } from 'electron';

import { registerCaptureHandlers } from './capture';
import { registerClipboardHandlers } from './clipboard';
import { EmbeddedSignalingServer } from './embedded-server';
import { registerFloatTilesHandlers, setTilesHostWindow } from './float-tiles';
import { TunnelManager } from './tunnel';
import { registerWindowModeHandlers, setPrimaryWindow } from './window-mode';

/**
 * 刻意不加 requestSingleInstanceLock()。
 *
 * 开发与联调阶段需要在本机同时启动 4 个客户端来验证四人 Mesh，
 * 单实例锁会让这件事直接做不到。M9 之后再评估是否需要限制。
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

/**
 * 内置信令服务器：客户端启动时顺手把服务器带起来，省掉「先去命令行起服」这一步。
 *
 * 默认开启；端口被占用时不会报错，只会放弃监听并照常当客户端用
 * （详见 embedded-server.ts）。自动化验收时用 GAMESHARE_EMBEDDED_SERVER=0 关掉。
 */
const embeddedServer = new EmbeddedSignalingServer({
  enabled: process.env.GAMESHARE_EMBEDDED_SERVER !== '0',
});

/**
 * 异地访问用的 Cloudflare 隧道。
 *
 * **默认关闭，只能由界面上手动开。** 隧道地址是公网可达的，而信令服务没有
 * 任何鉴权与限流 —— 原先「用完即关」这层兜底靠的就是隧道必须手动起。
 * 一旦改成随客户端常驻，这层保护就没了。详见 tunnel.ts 顶部说明。
 */
const tunnel = new TunnelManager();

let mainWindow: BrowserWindow | null = null;

/**
 * 采集那一整套（源列表 / 选源 / 请求 handler / 音频模式）在 `capture.ts` 里。
 * 它是独立可测的一层：验收脚本直接跑那个真模块 + 真 IPC，
 * 不必把 handler 抄一份进脚本（抄件验不出产物的问题）。
 */

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'GameShare',
    autoHideMenuBar: true,
    /**
     * **不要原生边框。**
     *
     * 浮窗模式下窗口是刻意 `setFocusable(false)` 的（不可激活，见 window-mode.ts 文件头），
     * 而**原生标题栏拖动与边框缩放都要先把窗口激活** —— 在不可激活的窗口上这两条路
     * 一条都不成立。于是那圈系统边框变成一块「看着能拖、实际完全拖不动」的死角：
     * 用户第一反应就是拖标题栏，得到的结论是「浮窗拖不动，拆不拆分都拖不动」
     * （2026-09-17 第二次实测，截图确认）。
     *
     * 上一批只补了自绘拖动（float-drag.ts）、没动那圈边框，等于把两侧都留着了：
     * 能拖的那块（画面区）没人想到去拖，看到的标题栏拖了没反应。这次整个去掉。
     *
     * 去掉之后整窗都是页面，拖动/缩放全部自绘、都不依赖窗口激活：
     *   · 浮窗模式 → float-drag.ts 算屏幕坐标，走 `float:move-to` / `float:resize-to`；
     *   · 常规模式 → 顶栏一条 `-webkit-app-region: drag`。
     *
     * 代价写在明处：
     *   · 最小化 / 最大化 / 关闭要自己画（渲染层 `.app__winctl` → `win:*` 三个 IPC）；
     *   · 窗口不再有原生标题栏与它那条描边，自己补一圈（styles.css 的 `.app` outline）；
     *   · 顶栏整条是拖动区，所以**顶边不能再拉着改高度**，左右下三条边照旧。
     */
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      /**
       * **必须关掉上下文隔离** —— 与小窗（float-tiles.ts）同一条理由，这次是实测出来的。
       *
       * 拆分模式的画面要靠 `MessagePort` 把每一路的 `ImageBitmap` 搬给小窗，而
       * `MessagePort` **过不了 `contextBridge`**。隔离打开时它交到页面手里会变成
       * 一个**没有任何方法的普通对象**，实测（`scripts/_probe-bridge-port.cjs`）：
       *
       *     ① 过桥：port=[object Object] · postMessage 不是函数 · 主进程收不到回信
       *     ② 不过桥：port=[object MessagePort] · 一来一回正常
       *
       * 更糟的是它**不报错**：空对象是真值，`if (!port)` 这种判空照样过；之后每一帧
       * 都在 `postMessage` 上抛 TypeError，又被帧泵自己的 `.catch` 吃掉 ——
       * 表现就是「小窗全黑、控制台一句话都没有」，2026-09-17 实测踩到。
       *
       * 代价可控：这个窗口只加载我们自己的本地页面，`nodeIntegration` 仍是 false，
       * `preload` 也只是把 IPC 包一层。**哪天要在主窗口里渲染外部内容（聊天、
       * 网页预览之类），这一条必须重新评估。**
       */
      contextIsolation: false,
      nodeIntegration: false,
      // preload 需要读取 process.versions 等 Node 信息，
      // 后续 M2 接入 desktopCapturer 也会走 IPC，这里保持 sandbox 关闭。
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (isDev && DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 这两个钩子是诊断刚需：渲染进程加载失败或崩溃时，
  // 主进程若不留痕，表现就是「窗口一片空白且没有任何报错」。
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[main] 页面加载失败 code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
    );
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] 渲染进程终止 reason=${details.reason} exitCode=${details.exitCode}`);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  /**
   * 显式登记「谁是主窗口」。
   *
   * 浮窗与拆分模块都要靠它 —— `getAllWindows()[0]` 在拆分模式下可能拿到某个小窗，
   * 那样快捷键一按就会去动错窗口。注册放在这里而不是 `whenReady`：
   * `activate` 分支会重建窗口，只注册一次的话第二个窗口就没人认得。
   */
  setPrimaryWindow(win);
  setTilesHostWindow(win);

  return win;
}

app.whenReady().then(() => {
  ipcMain.handle('app:get-info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData'),
    isDev,
  }));

  registerCaptureHandlers();
  registerEmbeddedServerHandlers();
  registerTunnelHandlers();
  registerWindowModeHandlers();
  registerFloatTilesHandlers();
  registerClipboardHandlers();

  mainWindow = createMainWindow();

  // 不等它起来：端口冲突是预期内的情况，界面自己会显示结果，
  // 没有理由让窗口展示因此延后
  if (embeddedServer.status.enabled) {
    void embeddedServer.start();
  }
});

/* ------------------------------------------------------------------ *
 * 内置信令服务器
 * ------------------------------------------------------------------ */

function registerEmbeddedServerHandlers(): void {
  // 状态变化推给所有窗口（当前只有一个，但不要写死成 mainWindow）
  embeddedServer.onChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('server:status', status);
    }
  });

  ipcMain.handle('server:get-status', () => embeddedServer.status);

  ipcMain.handle('server:set-enabled', async (_event, enabled: unknown) => {
    return embeddedServer.setEnabled(enabled === true);
  });
}

/* ------------------------------------------------------------------ *
 * 异地访问隧道
 * ------------------------------------------------------------------ */

function registerTunnelHandlers(): void {
  tunnel.onChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('tunnel:status', status);
    }
  });

  ipcMain.handle('tunnel:get-status', () => tunnel.status);

  ipcMain.handle('tunnel:set-enabled', async (_event, enabled: unknown) => {
    return tunnel.setEnabled(enabled === true);
  });
}

app.on('window-all-closed', () => {
  // V0.1 只做 Windows，关掉主窗口即退出进程
  app.quit();
});

app.on('before-quit', () => {
  // 关掉监听并让已连接的客户端收到 close 帧，
  // 否则对端要等 socket.io 的 pingTimeout（25 秒）才发现我们没了
  void embeddedServer.stop();
  // 隧道是独立子进程，不会随主进程一起退出 —— 不显式收掉的话，
  // 客户端关了之后那个公网地址仍然活着。stop() 第一件事就是发 kill 信号，
  // 所以即便这里的异步没跑完，信号也已经出去了。
  void tunnel.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

process.on('uncaughtException', (err) => {
  // 主进程崩溃必须留下痕迹，M9 稳定性排查依赖这条
  console.error('[main] uncaughtException', err);
});
