'use strict';

/**
 * 验收「应用级音频捕获基础层」。
 *
 * 要证明的东西只有一条：**业务层说 application / system / none，主进程回的那一路
 * device id 在真实采集里采到的内容，与按协议算出来的期望完全一致。**
 * 所以每一条判据都是「某频率在 / 不在」，而不是「API 没报错」——
 * 音轨对象在设备静音、格式不对、采错进程时同样存在，看它等于没看。
 *
 * 为什么拿频率当判据：`applicationLoopback` 与普通 loopback 的区别，
 * 本质上就是「谁的声音被采进来了」。让几个独立进程各播一个互不相同的单频，
 * 一次 FFT 就能把「隔离成立」和「整机混音」分得干干净净。
 *
 * 六路声源，同时存在（所以任何一条判据都不会被别的用例的残留污染）：
 *
 *   1060 Hz  本 Electron 实例自己播的  —— 代表「收到的远端语音」，任何正式模式都必须排除
 *    420 Hz  「目标应用」（独立进程）   —— Case 1 / 2 的隔离对象
 *    720 Hz  「别的应用」（独立进程）   —— 与目标无亲缘关系：证明是「按进程」而不是「按频率挑」
 *   1360 Hz  「进程树父应用」（独立进程）—— Case 3 的隔离对象
 *   1740 Hz  父应用的**直接子进程**（Python，自己持有音频流）—— Case 3 必须采到
 *   2040 Hz  父应用的**Electron 子应用**（音频出自它的渲染进程）—— Case 3 采不到的边界
 *
 * 频点是算出来的，不是随手挑的：六个频率两两相隔 ≥300 Hz，且**任何两个同时在场的
 * 频率，它的二/三次谐波与和差产物都不落在别人的 ±25 Hz 带里** ——
 * 不然互调产物会被判成「听见了那个频率」，Case 1 的「720 无」就变成假红或假绿。
 *
 * 分组：
 *
 *   0. **自己播的声音会不会被采回来** —— 在**隔离条件下**量（只有本实例在出声）：
 *      量同一路信号在 `loopback` 与 `system` 下的读数差，也就是「自己那一路被压低了多少」，
 *      另配一条内部对照（在 `loopback` 下开 / 关自己，它必然采得到自己）。
 *      这条判据直接决定「双向共享会不会啸叫」。
 *      为什么必须在**隔离**条件下量：多路声音并放时，某频点的能量还可能来自
 *      **几个别人的频率组合出的互调产物**，而其中一类（幅度正比于我们那一路的畸变）
 *      会跟着我们那一路一起消失，A/B 抵不掉它 —— 实测撞到过 `1060 = 420 + 1360 − 720`。
 *      所以多声源下的那份读数（Case 2）只作**观察**打印，不参与通过 / 不通过。
 *   1. **能力组** —— 走真 IPC 问 `capture:get-audio-capabilities`：四种模式的可用性、
 *      FFI 链状态、以及「普通 loopback 默认不可用、要显式开环境变量」这条门禁。
 *   2. **PID 链** —— `list-sources` 报回来的 `pid` 必须等于外部应用的真实进程号。
 *      那是 HWND→PID 这条 FFI 链的第一手证据，也是 `applicationLoopback:<pid>` 的前半段。
 *   3. **隔离组（Case 1~4）** —— 每组都走**真链路**：真 preload → 真
 *      `capture:select-source` → 真 `setDisplayMediaRequestHandler`（`capture.ts` 里
 *      那一份，不是抄件）→ 真 `getDisplayMedia` → 真 FFT。Case 3 / 4 用进程树，
 *      量 `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` 到底含到第几层。
 *   4. **不可用路径组** —— 几种必须**失败**的输入。「静默降级」是这一层最危险的
 *      失败模式（有声音了 ≠ 做对了），只能靠这组盯。
 *   5. **对照组** —— 显式打开 `GAMESHARE_ALLOW_RAW_LOOPBACK=1` 再采一次。
 *      它同时干两件事：验证门禁两个方向都对，以及**给整套测量装置做反向验证** ——
 *      前面几组判的是「1060 Hz 不在」，这里必须「在」，否则那些「不在」可能只是
 *      这套 FFT 根本听不见 1060 Hz（最典型的假绿）。
 *   6. **策略层** —— 把 `strategies.ts` / `device-ids.ts` 单独打一份直接调，
 *      断言「模式 + 目标 → device id」这个**纯函数**级的结果。
 *   7. **静态断言组** —— 几条「改错了会静默失效」的写法：device id 字面量是否还只在
 *      一处、koffi 是否还是 external、extraResources 的嵌套是否还保持。
 *      dev 跑通 ≠ 打包后跑通。
 *
 * ⚠️ **没覆盖的**：真实游戏进程（用的是 Electron 冒充的外部应用）、系统音量变化、
 * 蓝牙 / 多输出设备切换、麦克风。一个像素都没看，判据全在频域。
 *
 * 用法：
 *   npm run check:app-audio
 *
 * ⚠️ 会开 5 个窗口并持续出声（约 60 秒）。跑之前把音量调小一点。
 * 用的是独立的 userData 目录，不碰你自己的设置。
 */

const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const DIST_ELECTRON = path.join(DESKTOP, 'dist-electron');
const CACHE = path.join(ROOT, '.cache', 'check-app-audio');
const USER_DATA = path.join(CACHE, 'userdata');

/**
 * 独立的 userData —— 沿用 `check-float-tiles` 那条理由：真实目录会让本次跑出来的
 * 状态写进用户自己的记录里，下一次跑就被自己的残留数据坑成假红。
 */
app.setPath('userData', USER_DATA);

// 没有用户手势也要能出声，否则「本实例自己播 1060 Hz」这路根本不响，
// 各组的「1060 无」就变成了自证（采不到的东西当然不在）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * **不加这条，脚本会在某个窗口被销毁的瞬间以 0 退出**，后面的组根本不跑。
 * 屏幕上只剩一堆通过的字，最坏的一种假绿。`check-float-tiles` 踩过同一个坑。
 */
app.on('window-all-closed', () => {
  /* 保持存活，退出由 main() 决定 */
});

/**
 * Electron 的一个已知瑕疵，兜一下避免刷屏。
 *
 * 「audio 解析失败 → `callback({})`」这条路径上，Electron 内部会因为
 * 「请求了 video 却没给」而抛出一个**没人 catch 的 promise**，于是每个负例
 * 都在日志里留下两行 UnhandledPromiseRejectionWarning。渲染层那边其实是正常收到
 * 拒绝的（`AbortError: Invalid capture constraints` + `takeFailure()` 里的具体原因），
 * 所以它只是噪声 —— 但噪声会淹掉真正有用的输出，这里收一次、说明一下。
 */
let warnedAboutElectronRejection = false;
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  if (!warnedAboutElectronRejection && /no video stream was provided/.test(text)) {
    warnedAboutElectronRejection = true;
    console.log(
      '    （提示）Electron 在「按应用的音频解析失败 → callback({})」这条路上会抛一个' +
        '没人接的 promise：`Video was requested, but no video stream was provided`。' +
        '渲染层那边照常收到拒绝，下面是它的真实原因，这条忽略即可。',
    );
    return;
  }
  console.log('    （未处理的 promise 拒绝）', text);
});

/* ------------------------------------------------------------------ *
 * 频点与窗口标题
 * ------------------------------------------------------------------ */

/** 六路声源的自有频点（挑法见文件头） */
const HZ = {
  self: 1060,
  target: 420,
  bystander: 720,
  parent: 1360,
  /** 父应用的直接子进程：Python 自己持有音频流 */
  directChild: 1740,
  /** 父应用的 Electron 子应用：音频出自它的渲染进程（孙子） */
  grandChild: 2040,
};

/**
 * 标题两两之间**不能有包含关系**。
 *
 * 源列表是按标题找人的。`PROBE-AUDIO-1360` 是 `PROBE-AUDIO-1360-CHILD` 的前缀 ——
 * 一旦子应用标题这么起，父的查找就会先撞上子窗口，然后把「按应用隔离」
 * 验成一场空。所以子应用的标题刻意把频率挪到最后。
 */
const TITLE = {
  target: 'PROBE-AUDIO-420',
  bystander: 'PROBE-AUDIO-720',
  parent: 'PROBE-AUDIO-1360',
  grandChild: 'PROBE-AUDIO-CHILD-2040',
};

/** 判「这个频点里有没有能量」时，比局部本底高多少 dB 才算有 */
const MARGIN_OVER_FLOOR = 20;
/** 再补一条：必须落在「本组已知一定在」的那个频率的 25 dB 以内（跨设备音量的定标） */
const MARGIN_UNDER_REFERENCE = 25;

const MEASURE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

/** 采样出来是 -Infinity（数字静音）时显示成 -inf，别让日志里出现一串 -999 */
const f = (v) => (v <= -900 ? '-inf' : v.toFixed(1));

/* ------------------------------------------------------------------ *
 * 准备：真构建产物 + 真模块打包
 * ------------------------------------------------------------------ */

/**
 * 跑的是**真模块**：把 `capture.ts` 单独打一份 CJS require 进来。
 *
 * 它留在 main.ts 里的话，这个脚本就只能自己抄一份 handler 塞进来 ——
 * 验的是抄件不是产物，实现漂移了这边照样绿（`check-float-tiles` 的分组注释里
 * 对同一类问题写过一次，这里是第二次）。`strategies.ts` / `device-ids.ts`
 * 同理单独打一份，给策略层那组用。
 */
async function prepare() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  // 真构建产物：preload.cjs 给主窗口挂真 IPC 面
  const { buildElectron } = await import(
    pathToFileURL(path.join(DESKTOP, 'scripts', 'build-electron.mjs')).href
  );
  await buildElectron();

  const { buildSync } = require('esbuild');
  const bundle = (entry, out) =>
    buildSync({
      entryPoints: [path.join(DESKTOP, 'electron', entry)],
      outfile: path.join(CACHE, out),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      // koffi 必须 external：原生模块，打进来就是把 `.node` 的加载路径写死，
      // 而 dev 与打包后走的是两条不同路径（见 win32-window-pid.ts 的候选列表）
      external: ['electron', 'koffi'],
      logLevel: 'warning',
    });

  bundle('capture.ts', 'capture.cjs');
  bundle(path.join('audio', 'strategies.ts'), 'strategies.cjs');
  bundle(path.join('audio', 'device-ids.ts'), 'device-ids.cjs');

  fs.writeFileSync(path.join(CACHE, 'host.html'), HOST_PAGE, 'utf8');
}

/** 本机预设了 ELECTRON_RUN_AS_NODE，不删掉子进程会退化成纯 Node、开不出窗口 */
function electronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 找一个能跑 `winsound` 的 Python。
 *
 * 「直接子进程自己出声」这个角色非它不可（理由见 `_probe-audio-tone.py` 的文件头），
 * 而 `winsound` 是 CPython on Windows 的标准库 —— 不用装任何东西。
 * 找不到就跳过那两个 Case 3 断言并说明，而不是让它变成假红。
 */
function findPython() {
  const candidates = [
    process.env.GAMESHARE_CHECK_PYTHON,
    'C:/Python314/python.exe',
    // 一个可选的本机探测路径（WorkBuddy 托管 Python），存在才用：
    path.join(
      process.env.USERPROFILE || os.homedir(),
      '.workbuddy/binaries/python/versions/3.13.12/python.exe',
    ),
    'python',
  ].filter(Boolean);
  for (const p of candidates) {
    const probe = spawnSync(p, ['-c', 'import winsound'], { stdio: 'ignore' });
    if (probe.status === 0) return p;
  }
  return null;
}

function launchApp(args) {
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, '_probe-audio-app.cjs'), ...args],
    { env: electronEnv(), stdio: 'inherit' },
  );
  return { proc, pid: proc.pid };
}

/** 带进程树一起杀掉 —— 父应用自己 spawn 的播放进程与子应用都不归我们管 */
function killTree(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 已经退出了 */
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== 应用级音频捕获验收 ===');
  console.log(
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / ${process.platform}\n`,
  );

  await prepare();

  // 真模块 + 真 IPC：这一句注册的就是用户点「共享」时走的那批 handler
  const { registerCaptureHandlers } = require(path.join(CACHE, 'capture.cjs'));
  registerCaptureHandlers();

  /* ---------- 外部应用 ---------- */
  /**
   * **先不拉外部应用。** 下面第 0 组要在「只有本实例自己在出声」的条件下量一次 ——
   * 那时候频谱里除了 1060 Hz 什么都没有，任何一点 1060 Hz 的能量都只可能来自自己。
   * 混着一堆别的频率量这件事是量不准的：几个单频的和差产物会落在同一片区域，
   * 分不清「自己漏进来了」还是「别人互调出来的」（第一版就是这么误判的）。
   */
  const python = findPython();

  /* ---------- 主窗口：真 preload + file:// 页面 ---------- */
  /**
   * 页面必须是 **file://**。
   *
   * `capture.ts` 的权限处理器只放行 `file://` 与 `http://localhost`；
   * 用 `data:` 页面的话 `display-capture` 会被直接拒掉，采集一次都起不来 ——
   * 而失败信息是一句 NotAllowedError，看着像「录音权限没给」，
   * 跟真正要验的音频模式完全无关（`_probe-capture-real.cjs` 踩过）。
   */
  const host = new BrowserWindow({
    width: 720,
    height: 420,
    show: true,
    title: 'APP-AUDIO-CHECK',
    backgroundColor: '#0e1418',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.cjs'),
      // 与 main.ts 一致：preload 直接挂 window，关掉隔离才读得到
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  await host.loadFile(path.join(CACHE, 'host.html'));
  const js = (expr) => host.webContents.executeJavaScript(expr);

  const hasApi = await js(
    'typeof (window.gameShare && window.gameShare.capture && window.gameShare.capture.selectSource)',
  );
  check(
    '真 preload 挂上了 capture 面（不然下面每条都是「点了没反应」）',
    hasApi === 'function',
    hasApi,
  );

  const probe = (sourceId, options, hzList, ms = MEASURE_MS) =>
    js(
      `window.probe(${JSON.stringify(sourceId)}, ${JSON.stringify(options)}, ` +
        `${JSON.stringify(hzList)}, ${ms})`,
    );

  /* ---------- 第 0 组：自己播的声音该不该进「整机共享」 ---------- */
  /**
   * **为什么这一组是「开 / 关自己」的 A/B，而不是一次读数。**
   *
   * 第一版拿「绝对抑制量」当判据（`system` 下的读数比 `loopback` 下低多少 dB），
   * 它在只有自己出声的条件下连续给出 9.7 / 18.6 / 28.2 / 34.9 / 40.0 dB ——
   * 差了 30 dB。查下去的原因很有意思：那一刻频谱最响的 bin 落在 744~797 Hz，
   * 而当时**只有 1060 Hz 在响**；那是回环链在近静音下的瞬态（缓冲边界那点咔哒）
   * 炸出来的一片宽带能量，跟谁的声音都没关系。
   *
   * 那个现象牵出三个独立的问题，都修了：
   *
   *   1. **测量装置** —— 当时每个 bin 取的是「一窗里的最大值」，一次咔哒就能把
   *      全频段同时抬起来，读数于是变成了咔哒的形状。已改成**逐帧中位数**
   *      （见 `window.probe` 里那段长注释）：咔哒只占一两帧，进不了中位数。
   *   2. **判据** —— 「安静时读数」本身不可信，拿它当判据就是在量噪声。
   *   3. **被测的那条路不能量静音** —— 第一版给 `system` 判的是「开 / 关差值 ≤ 6 dB」，
   *      可它一旦真排干净了，前后两个读数就都是静音区的噪声，差的是两次噪声的差
   *      （实测已经翻过一次正号）。现在改成量**抑制量**（同一路信号在 `loopback`
   *      与 `system` 下的读数差），一头真信号一头真静音，与噪声无关。
   *
   * 还留着一条 A/B 与一条**内部对照**：先在 `loopback` 下做同一次开 / 关自己。
   * 那条路必然采得到自己，所以差值必须很大 —— 差值不大就说明「关掉自己」这个动作
   * 没生效，那么 `system` 那边的一切读数也就毫无意义（是最难发现的一种假绿）。
   */
  console.log('\n第 0 组  整机方案会不会把自己播出去的声音采回来（开 / 关自己的 A/B）');
  console.log(`        此刻只有本实例在播 ${HZ.self} Hz，频谱里没有别的东西。`);
  let sources = await js('window.gameShare.capture.listSources()');
  const screenForSelfTest = sources.find((s) => s.kind === 'screen') ?? null;
  const selfSourceId = screenForSelfTest?.id ?? '';
  const setSelf = (on) => js(`window.setSelfTone(${on ? 'true' : 'false'})`);

  const abProbe = async (audioMode, ms) => {
    const on = await probe(selfSourceId, { audioMode }, [HZ.self], ms);
    await setSelf(false);
    await sleep(250);
    const off = await probe(selfSourceId, { audioMode }, [HZ.self], ms);
    await setSelf(true);
    await sleep(250);
    return { on, off, delta: on.peaks?.[0] - off.peaks?.[0] };
  };

  // 两次 loopback 都得在同一个开关状态下采 —— rawLoopbackAllowed() 只认 '1'，
  // 中途改掉它第二次会直接失败
  process.env.GAMESHARE_ALLOW_RAW_LOOPBACK = '1';
  const abRaw = await abProbe('loopback', 1200);
  delete process.env.GAMESHARE_ALLOW_RAW_LOOPBACK;
  const abSystem = await abProbe('system', 1500);

  const abRow = (name, ab) =>
    console.log(
      `    ${name}: 开着 ${f(ab.on.peaks?.[0])} / 关掉 ${f(ab.off.peaks?.[0])} → 差 ${ab.delta.toFixed(1)} dB`,
    );

  if (abRaw.on?.gdmError || abSystem.on?.gdmError) {
    check('第 0 组采集本身成功', false, abRaw.on?.gdmError ?? abSystem.on?.gdmError);
  } else {
    abRow('loopback（内部对照，必然采得到自己）', abRaw);
    abRow('system  （被测的那条路）', abSystem);
    console.log(
      `    system 开着时最响的几个 bin: ${(abSystem.on.topBins ?? [])
        .slice(0, 6)
        .map(([hz, db]) => `${hz}Hz=${db.toFixed(1)}`)
        .join('  ')}`,
    );
    check(
      '内部对照：「关掉自己」之后 loopback 里的读数确实掉下去（否则下面的 A/B 全是自欺）',
      abRaw.delta >= 15,
      `${abRaw.delta.toFixed(1)} dB`,
    );
    /**
     * **被测的那条路怎么判，值得说清楚。**
     *
     * 第一版判的是 `system` 自己的「开 / 关差值 ≤ 6 dB」（跟内部对照同一个形状）。
     * 它错在**量的是静音**：`system` 一旦真的排掉了自己，前后两个读数就都是静音区
     * 的噪声（实测 -81 / -68 这种量级），它们的差就是两次噪声的差 —— 实测已经翻过
     * 一次正号。噪声上搭出来的判据，换个 run 就会随机变红或变绿。
     *
     * 换成量**抑制量**：同一路信号（自己那一路 1060 Hz），在 `loopback` 里的读数
     * 减去在 `system` 里的读数。一头是**真信号**（-40 这种量级）、一头是**真静音**，
     * 中间隔着几十 dB，跟噪声无关；而如果 `system` 其实没排掉自己，这个差值就会
     * 掉到 0 附近 —— 那时候它才是红。
     *
     * **门限为什么只取 12 dB：因为抑制量本身在 run 之间是会变的。**
     * 实测四次同一份代码：**22.5 / 47.7 / 57.5 / 58.4 dB** —— 差了 36 dB。
     * 这不是测量噪声（同一次 run 里两个读数都稳到 1 dB 以内），是
     * `loopbackWithoutChrome` 自己那条排除路径的真实波动，取多次采样也压不平。
     * 所以这条判据**只负责回答「到底排没排」**，不回答「排得够不够干净」：
     *  - 真漏进来时长什么样，由下面那条反向验证给出（**-0.6 / -0.9 dB**）；
     *  - 12 dB 对那个 0 附近有 10 dB 以上的分辨力，同时给最差那次留了 10 dB 余量。
     * 「排得够不够干净」是产品问题（双向共享会不会有可闻回声），只能实机听，
     * 别用一条会飘的读数把它说死。
     */
    const selfSuppression = abRaw.on.peaks[0] - abSystem.on.peaks[0];
    check(
      'system（loopbackWithoutChrome）把自己那一路压掉了（不是原样采回来）',
      selfSuppression >= 12,
      `比自己那一路在 loopback 下的读数低 ${selfSuppression.toFixed(1)} dB` +
        `（真漏进来会在 0 附近；实测区间 22~58 dB，会飘）`,
    );
    console.log(
      `    【观察，不作断言】system 下的开 / 关差值 ${abSystem.delta.toFixed(1)} dB ——` +
        '一旦真的排干净了，这两个读数就都在静音区，差的是两次噪声，符号都可能翻，',
    );
    console.log('        所以它只当参考；「自己有没有进来」由上一条负责。');
    /**
     * **反向验证上面那条新门限确实会红。**
     *
     * 「抑制量 ≥ 12 dB」是新写的判据，新判据必须证明它对坏情形真的会红 ——
     * 否则它可能只是个无论怎样都绿的装饰（这个仓库里踩过这种坑）。
     * 办法：拿同一个**不排除自己**的装置（普通 `loopback`）量两遍，两次之间
     * 什么都没变，所以抑制量必须是 0 附近 —— 这同时也是「真漏进来的话会长什么样」
     * 的一个实测样本（实测 -0.6 / -0.9 dB），以及那条 12 dB 门限的分辨力依据。
     */
    process.env.GAMESHARE_ALLOW_RAW_LOOPBACK = '1';
    const abRawAgain = await probe(selfSourceId, { audioMode: 'loopback' }, [HZ.self], 1200);
    delete process.env.GAMESHARE_ALLOW_RAW_LOOPBACK;
    const nullSuppression = abRaw.on.peaks[0] - abRawAgain.peaks[0];
    check(
      '反向验证：同一个「不排除自己」的装置量两遍 → 抑制量落在 0 附近（说明上面那 12 dB 会红）',
      nullSuppression < 12,
      `${nullSuppression.toFixed(1)} dB`,
    );
  }

  /* ---------- 现在才拉起外部应用 ---------- */
  console.log('\n拉起外部应用（各自独立进程，各播一个频点）');
  console.log(
    `  Python（直接子进程角色）: ${python ?? '（找不到 winsound 可用的 Python，Case 3 的子进程那条会跳过）'}`,
  );

  const appTarget = launchApp([`--freq=${HZ.target}`, `--title=${TITLE.target}`]);
  const appBystander = launchApp([`--freq=${HZ.bystander}`, `--title=${TITLE.bystander}`]);
  // 父应用：自己播 1360；再挂两个子进程 —— 一个是「该采到」的直接子进程，
  // 一个是「采不到」的孙子（Electron 子应用的音频出自它的渲染进程）
  const appParent = launchApp([
    `--freq=${HZ.parent}`,
    `--title=${TITLE.parent}`,
    `--child-freq=${HZ.grandChild}`,
    `--child-title=${TITLE.grandChild}`,
    ...(python ? [`--tone-freq=${HZ.directChild}`, `--tone-python=${python}`] : []),
  ]);
  const apps = [
    { name: TITLE.target, pid: appTarget.pid },
    { name: TITLE.bystander, pid: appBystander.pid },
    { name: TITLE.parent, pid: appParent.pid },
  ];
  for (const a of apps) console.log(`  ${a.name}  pid=${a.pid}`);

  // 等四个外部窗口都被枚举到。源列表是这一层唯一的「找窗口」手段
  const wantedTitles = [TITLE.target, TITLE.bystander, TITLE.parent, TITLE.grandChild];
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    sources = await js('window.gameShare.capture.listSources()');
    if (wantedTitles.every((t) => sources.some((s) => s.name === t))) break;
    await sleep(400);
  }

  const find = (title) => sources.find((s) => s.name === title) ?? null;
  const srcTarget = find(TITLE.target);
  const srcBystander = find(TITLE.bystander);
  const srcParent = find(TITLE.parent);
  const srcGrandChild = find(TITLE.grandChild);
  const srcScreen = sources.find((s) => s.kind === 'screen') ?? null;

  check(
    '四个外部窗口都枚举到了',
    [srcTarget, srcBystander, srcParent, srcGrandChild].every((s) => s !== null),
    wantedTitles.map((t) => `${t}:${find(t) ? 'ok' : '缺'}`).join(' '),
  );

  /* ---------- 第 1 组：能力 ---------- */
  console.log('\n能力组（真 IPC：capture:get-audio-capabilities）');
  const caps = await js('window.gameShare.capture.getAudioCapabilities()');
  const capOf = (m) => caps.modes.find((x) => x.mode === m) ?? null;
  check(
    'HWND→PID 这条 FFI 链可用（按应用采集的全部前置条件）',
    caps.ffi.available === true,
    caps.ffi.detail,
  );
  check('能力表覆盖四种模式', caps.modes.length === 4, caps.modes.map((m) => m.mode).join(','));
  check('application 可用', capOf('application')?.available === true, capOf('application')?.reason ?? '');
  check('system 可用', capOf('system')?.available === true, capOf('system')?.reason ?? '');
  check('none 恒可用', capOf('none')?.available === true);
  check(
    '普通 loopback **默认不可用**（它不再是任何路径的默认值）',
    capOf('loopback')?.available === false,
    capOf('loopback')?.reason ?? '',
  );
  check(
    '不可用的原因里给出了显式开启的办法（不是一句「不支持」）',
    /GAMESHARE_ALLOW_RAW_LOOPBACK/.test(capOf('loopback')?.reason ?? ''),
  );
  check(
    'loopback 标成非正式方案（official=false），界面不该把它当正常选项',
    capOf('loopback')?.official === false,
  );

  /* ---------- 第 2 组：PID 链 ---------- */
  console.log('\nPID 链（list-sources 的 pid 必须等于外部应用的真实进程号）');
  check(
    '窗口源带 pid，屏幕源不带',
    Boolean(srcTarget && Number.isInteger(srcTarget.pid)) && srcScreen !== null && srcScreen.pid === null,
    `target.pid=${srcTarget?.pid} screen.pid=${String(srcScreen?.pid)}`,
  );
  check(
    '目标窗口的 pid == 目标应用进程号（HWND→PID 这条链真的通）',
    srcTarget !== null && srcTarget.pid === appTarget.pid,
    `报回 ${srcTarget?.pid} / 实际 ${appTarget.pid}`,
  );
  check(
    '另一个应用报的是另一个 pid（不是随手复用了同一个数）',
    srcBystander !== null &&
      srcBystander.pid === appBystander.pid &&
      srcBystander.pid !== srcTarget?.pid,
    `报回 ${srcBystander?.pid} / 实际 ${appBystander.pid}`,
  );
  check(
    '父子两个应用窗口报的是两个不同的进程号',
    srcParent?.pid === appParent.pid && srcGrandChild !== null && srcGrandChild.pid !== srcParent?.pid,
    `父 ${srcParent?.pid}（实际 ${appParent.pid}）/ 子 ${srcGrandChild?.pid}`,
  );

  /* ------------------------------------------------------------------ *
   * 第 3 组：隔离（Case 1~4）
   * ------------------------------------------------------------------ */

  /**
   * 判「这个频点里有没有能量」。
   *
   * 两条同时满足才算有：
   *
   * 1. 比**它自己附近的**本底高 20 dB。用局部本底而不是一个远端的固定噪声带，
   *    是因为回环采集的本底是往低频抬的（实测 3 kHz 处约 -95 dB、700 Hz 处约 -78 dB），
   *    拿 3 kHz 当参考会把低频的底噪判成信号。局部本底取的是该频点两侧
   *    55~170 Hz 那圈**每 bin 时间峰值的中间值** —— 用中位数是为了不让某一条
   *    互调产物把本底抬起来（一条线拉不动中位数）。
   * 2. 落在本组「已知一定在」的那个频率的 25 dB 以内。同样是单频正弦，
   *    真信号与参考的差值跟系统音量无关，而底噪 / 互调产物总在 30 dB 以下。
   *
   * 这两个条件缺一不可：只用 1，绝对静音时（本底 -inf）任何一丝能量都算「有」；
   * 只用 2，会把整条频谱一起判成「有」。
   */
  function heard(result, hz, refHz) {
    const i = result.hzList.indexOf(hz);
    const j = result.hzList.indexOf(refHz);
    if (i < 0 || result.peaks[i] <= -900 || result.floors[i] <= -900) return false;
    const ref = j >= 0 && result.peaks[j] > -900 ? result.peaks[j] : -Infinity;
    return (
      result.peaks[i] > result.floors[i] + MARGIN_OVER_FLOOR &&
      result.peaks[i] > ref - MARGIN_UNDER_REFERENCE
    );
  }

  /**
   * 判「这个频点被压下去了」。
   *
   * **刻意不用 `!heard()` 来表达「无」。** 两者判的不是一回事：
   * 「有」要求高出局部本底，而「无」应当是一个**量化过的抑制量** ——
   * 比参考频率低多少 dB。理由来自实测：`loopbackWithoutChrome` 对自家音频
   * 不是消除而是衰减（约 19 dB，且波动），用一组「高于本底 20 dB 才算有」
   * 的阈值去反推「无」，在最浅的那次读数上只差 1.3 dB 就会翻面 ——
   * 那不是判据，是运气。
   *
   * 拿不到读数（数字静音）也算被抑制：连能量都没有，更没有「没压住」这回事。
   */
  function suppressed(result, hz, refHz, minDb) {
    const i = result.hzList.indexOf(hz);
    const j = result.hzList.indexOf(refHz);
    if (i < 0) return false;
    if (result.peaks[i] <= -900) return true;
    const ref = j >= 0 && result.peaks[j] > -900 ? result.peaks[j] : null;
    if (ref === null) return false;
    return result.peaks[i] <= ref - minDb;
  }
  const quiet = (result, hz, refHz) => {
    const i = result.hzList.indexOf(hz);
    const j = result.hzList.indexOf(refHz);
    const ref = j >= 0 ? result.peaks[j] : -999;
    return `低 ${(ref - result.peaks[i]).toFixed(1)} dB（${f(result.peaks[i])} vs ${f(ref)}）`;
  };

  /** 「有 / 无」的读数表。失败时这一行比一个「✗」有用得多 */
  const readings = (result, hzList, refHz) =>
    hzList
      .map((hz) => {
        const i = result.hzList.indexOf(hz);
        const mark = hz === refHz ? '*' : '';
        return `${hz}${mark}=${f(result.peaks[i])}/底${f(result.floors[i])}${heard(result, hz, refHz) ? '有声' : '无'}`;
      })
      .join(' ');

  const dump = (name, result, hzList, refHz) => {
    if (!result || result.gdmError || result.selectError) {
      console.log(`    ${name}: 没采到（${result?.gdmError ?? result?.selectError ?? '无结果'}）`);
      return;
    }
    console.log(
      `    ${name}: deviceId=${result.audio?.deviceId ?? '(无音轨)'}\n` +
        `      ${readings(result, hzList, refHz)}   （*=本组作为定标参考的频率）`,
    );
  };

  /* ---- Case 1 ---- */
  const C1 = [HZ.target, HZ.bystander, HZ.self];
  console.log('\nCase 1  按应用采集（applicationLoopback:<目标应用 pid>）');
  console.log('        期望：420 有 / 720 无 / 1060 无');
  const case1 = await probe(srcTarget?.id ?? '', { audioMode: 'application' }, C1);
  dump('Case 1', case1, C1, HZ.target);
  if (case1?.gdmError) {
    check('Case 1 采集本身成功', false, case1.gdmError);
  } else {
    check(
      'Case 1 画面也拿到了（音频解析失败时主进程刻意不给画面，能拿到就说明没走那条路）',
      (case1.video?.width ?? 0) > 0 && case1.videoFrames >= 10,
      `${case1.video?.width}x${case1.video?.height} ${case1.videoFrames} 帧 / 2s`,
    );
    check('Case 1 目标应用 420 Hz **有**', heard(case1, HZ.target, HZ.target));
    check(
      'Case 1 别的应用 720 Hz **无**（证明是按进程隔离，不是整机混音）',
      suppressed(case1, HZ.bystander, HZ.target, 25),
      quiet(case1, HZ.bystander, HZ.target),
    );
    check(
      'Case 1 本实例自己的 1060 Hz **无**（否则双向共享会啸叫）',
      suppressed(case1, HZ.self, HZ.target, 25),
      quiet(case1, HZ.self, HZ.target),
    );
  }

  /* ---- Case 2 ---- */
  console.log('\nCase 2  整机声音但排除本实例（loopbackWithoutChrome）');
  console.log('        期望：420 有 / 720 有 / 1060 无');
  /**
   * 这里**必须做自己开 / 关的两次采集**，不能只看一次读数。
   *
   * 有别人在场时，落在 1060 这个 bin 上的能量同时有三个来源：
   * 自己漏进来的、别人在那儿的谐波、以及几个别人的频率组合出来的互调产物 ——
   * 实测就撞上过一个：1360 + 1740 − 2040 正好等于 1060，把「自己 1060 无」
   * 判成过红、也差一点判成绿。一次读数分不清这三种。
   *
   * 把自己这一路关掉再采一次，互调与谐波两轮里一模一样，相减就抵掉了，
   * 剩下的差值只可能是自己贡献的。**差值小 = 自己真的没进来**，这才叫判据。
   */
  const case2A = await probe(srcTarget?.id ?? '', { audioMode: 'system' }, C1);
  await setSelf(false);
  await sleep(250);
  const case2B = await probe(srcTarget?.id ?? '', { audioMode: 'system' }, C1);
  await setSelf(true);
  await sleep(250);
  dump('Case 2（自己开着）', case2A, C1, HZ.target);
  dump('Case 2（自己关掉）', case2B, C1, HZ.target);
  if (case2A?.gdmError) {
    check('Case 2 采集本身成功', false, case2A.gdmError);
  } else {
    check(
      'Case 2 deviceId 是 loopbackWithoutChrome（不是普通 loopback）',
      case2A.audio?.deviceId === 'loopbackWithoutChrome',
      `实际 ${case2A.audio?.deviceId}`,
    );
    check('Case 2 目标应用 420 Hz **有**', heard(case2A, HZ.target, HZ.target));
    check(
      'Case 2 别的应用 720 Hz **有**（整机声音就该包含它）',
      heard(case2A, HZ.bystander, HZ.target),
    );
    const selfIndex = C1.indexOf(HZ.self);
    const leak = case2A.peaks[selfIndex] - case2B.peaks[selfIndex];
    /**
     * **这一条只作观察，不作断言 —— 原因是它无歧义不了。**
     *
     * 在「多路声音同时在放」的条件下，某频点的能量有三个来源：自己漏进来的、
     * 别人在那儿的谐波、以及**几个别人的频率组合出的互调产物**。A/B（关掉自己）
     * 本意是抵掉后两者，但它抵不掉其中一类：**幅度正比于我们那一路的产物** ——
     * 任何非线性环节（限幅、重采样、DAC）都会生成 `f + t − t` 这种「自己那一路的
     * 畸变」，它随我们那一路一起消失。
     *
     * 实测撞到过：`1060` 同时是 `420 + 1360 − 720` 和 `1360 + 1740 − 2040` 的产物；
     * 试过把自己的频点挪到「所有组合都够不着的位置」，在 880~1280 Hz 内
     * **一个都没有**（5 个频点最多到 5 阶的组合太密）。
     *
     * 所以这一条会红，但它红了不代表「漏了」—— 于是写成观察：
     * 数字照打，不参与通过 / 不通过。真正作断言的是第 0 组那份**隔离条件下**的
     * A/B（只有自己在出声，不存在任何组合产物，结论无歧义）。
     * 观测到过大读数时要在设计评审里当风险处理，别当成脚本噪声删掉。
     */
    const observed = leak > 6 ? '⚠ 值得查' : '正常';
    console.log(
      `    【观察，不作断言】多声源下开 / 关自己的读数差：${leak.toFixed(1)} dB（${observed}）` +
        `  自己开着 ${f(case2A.peaks[selfIndex])} / 关掉 ${f(case2B.peaks[selfIndex])}`,
    );
  }

  /* ---- Case 3 ---- */
  const C3 = [HZ.parent, HZ.directChild, HZ.self, HZ.grandChild];
  console.log('\nCase 3  传**父**进程 pid：目标自己 + 它的直接子进程都该被采到');
  console.log('        期望：1360 有 / 1740 有 / 1060 无 / 2040 无');
  const case3 = await probe(srcParent?.id ?? '', { audioMode: 'application' }, C3);
  dump('Case 3', case3, C3, HZ.parent);
  if (case3?.gdmError) {
    check('Case 3 采集本身成功', false, case3.gdmError);
  } else {
    check('Case 3 父应用 1360 Hz **有**', heard(case3, HZ.parent, HZ.parent));
    if (python) {
      check(
        'Case 3 直接子进程 1740 Hz **有**（进程树含直接子进程 —— 这就是那条要求）',
        heard(case3, HZ.directChild, HZ.parent),
        `Python 自己持有音频流，对目标是儿子那一层`,
      );
    } else {
      console.log('    ⚠ 没有可用的 Python，跳过「直接子进程」那条断言');
    }
    check(
      'Case 3 本实例自己的 1060 Hz **无**（带进程树不等于放开整机）',
      suppressed(case3, HZ.self, HZ.parent, 25),
      quiet(case3, HZ.self, HZ.parent),
    );
    /**
     * 这条是**边界**，不是缺陷。
     *
     * Electron 子应用的音频出自**它的渲染进程**，而渲染进程对目标来说是孙子。
     * 实测进程树只含到**直接子进程**那一层，孙子进不来。写成断言是为了：
     * 哪天平台行为变了（或我们换了采集方式），这里会红，逼人重新判断，
     * 而不是让一句「已支持进程树」的注释慢慢变成谎话。
     */
    check(
      'Case 3 孙子的 2040 Hz **无** —— 进程树只到直接子进程那一层（Electron 子应用的音频出自它的渲染进程）',
      suppressed(case3, HZ.grandChild, HZ.parent, 25),
      quiet(case3, HZ.grandChild, HZ.parent),
    );
  }

  /* ---- Case 4 ---- */
  const C4 = [HZ.grandChild, HZ.parent, HZ.directChild, HZ.self];
  console.log('\nCase 4  传**子**进程 pid：只能采到子进程自己');
  console.log('        期望：2040 有 / 1360 无 / 1740 无 / 1060 无');
  const case4 = await probe(srcGrandChild?.id ?? '', { audioMode: 'application' }, C4);
  dump('Case 4', case4, C4, HZ.grandChild);
  if (case4?.gdmError) {
    check('Case 4 采集本身成功', false, case4.gdmError);
  } else {
    check(
      'Case 4 子应用 2040 Hz **有**（子窗口的 HWND 解析出的就是子进程，采到的是它自己的渲染进程）',
      heard(case4, HZ.grandChild, HZ.grandChild),
    );
    check(
      'Case 4 父应用 1360 Hz **无**（隔离的是自己这棵树，不含祖先）',
      suppressed(case4, HZ.parent, HZ.grandChild, 25),
      quiet(case4, HZ.parent, HZ.grandChild),
    );
    check(
      'Case 4 兄弟进程 1740 Hz **无**（父应用下的另一个子进程不在这棵树里）',
      suppressed(case4, HZ.directChild, HZ.grandChild, 25),
      quiet(case4, HZ.directChild, HZ.grandChild),
    );
    check(
      'Case 4 本实例自己的 1060 Hz **无**',
      suppressed(case4, HZ.self, HZ.grandChild, 25),
      quiet(case4, HZ.self, HZ.grandChild),
    );
  }

  /* ---- 三次「按应用」拿到的 device id 之间的关系 ---- */
  /**
   * 为什么只能比「关系」不能比字面量：Chromium 把 `applicationLoopback:<pid>`
   * 在 `getSettings().deviceId` 里换成了一个**加盐哈希**（`loopback` /
   * `loopbackWithoutChrome` 倒是原样返回，这也是下面第 2 条能那样写的原因）。
   * 盐是随机的，哈希算不出来 —— 但「同一个 pid 稳定、不同 pid 不同」这两条，
   * 恰恰就是「pid 真的进了 device id」的可观测证据，比字符串相等更有意义。
   */
  console.log('\ndevice id 关系（applicationLoopback:<pid> 的 pid 真的进了那一路 id）');
  const id1 = case1?.audio?.deviceId ?? null;
  const id3 = case3?.audio?.deviceId ?? null;
  const id4 = case4?.audio?.deviceId ?? null;
  const again = await probe(srcTarget?.id ?? '', { audioMode: 'application' }, [HZ.self], 400);
  check(
    '同一个目标进程采两次，device id 一致（说明它是这个 pid 的确定性映射）',
    id1 !== null && again?.audio?.deviceId === id1,
    `${String(id1).slice(0, 16)}… / ${String(again?.audio?.deviceId).slice(0, 16)}…`,
  );
  check(
    '三个不同 pid 的 device id 两两不同（同一个就说明 pid 没进到 id 里）',
    id1 !== null && id3 !== null && id4 !== null && id1 !== id3 && id3 !== id4 && id1 !== id4,
    [id1, id3, id4].map((x) => String(x).slice(0, 10)).join(' / '),
  );
  check(
    '按应用采到的那一路 id 既不是 loopback 也不是 loopbackWithoutChrome（确实是另一个 device）',
    id1 !== null && id1 !== 'loopback' && id1 !== 'loopbackWithoutChrome',
    String(id1).slice(0, 16),
  );

  /* ------------------------------------------------------------------ *
   * 第 4 组：不可用 / 拒绝路径
   * ------------------------------------------------------------------ */

  console.log('\n不可用路径组（这几条必须**失败**，静默降级是最危险的失败模式）');

  // (a) 屏幕源 + application：屏幕没有「所属应用」
  if (srcScreen) {
    const r = await probe(srcScreen.id, { audioMode: 'application' }, [HZ.self], 400);
    check(
      '(a) 屏幕源请求「按应用」→ 整次采集失败，不是静默给一路无声画面',
      Boolean(r?.gdmError) && r.audio === undefined,
      r?.gdmError ? r.gdmError.slice(0, 60) : '居然采到了',
    );
    check(
      '(a) 失败原因带 failedMode=application + suggestion=system（只给建议，不替调用方换）',
      r?.failure?.failedMode === 'application' && r?.failure?.suggestion === 'system',
      r?.failure ? `failedMode=${r.failure.failedMode} suggestion=${r.failure.suggestion}` : '没取到失败信息',
    );
    check(
      '(a) 失败文案说得清是「屏幕源没有所属应用」',
      /屏幕源|所属应用/.test(r?.failure?.message ?? ''),
      (r?.failure?.message ?? '').slice(0, 50),
    );
  } else {
    check('(a) 需要至少一个屏幕源', false, '源列表里没有 screen:*');
  }

  // (b) 没有环境变量时请求普通 loopback：门禁必须拦住
  const rRaw = await probe(srcTarget?.id ?? '', { audioMode: 'loopback' }, [HZ.self], 400);
  check(
    '(b) 没开 GAMESHARE_ALLOW_RAW_LOOPBACK 时请求 loopback → 失败',
    Boolean(rRaw?.gdmError) && rRaw.audio === undefined,
    rRaw?.gdmError ? rRaw.gdmError.slice(0, 60) : '居然采到了',
  );
  check(
    '(b) 失败原因带 failedMode=loopback，且**没有**建议直接换成它',
    rRaw?.failure?.failedMode === 'loopback' && rRaw?.failure?.suggestion === null,
    rRaw?.failure
      ? `failedMode=${rRaw.failure.failedMode} suggestion=${String(rRaw.failure.suggestion)}`
      : '没取到失败信息',
  );

  // (c) 不认识的模式：宁可炸在这一点上，也不要静默挑一个顶上
  const badMode = await js(
    `window.probe(${JSON.stringify(srcTarget?.id ?? '')}, { audioMode: 'window' }, [], 200)
       .then((r) => ({ selectError: r.selectError ?? null }))`,
  );
  check(
    '(c) 不认识的音频模式 → select-source 直接抛错（不猜一个顶上）',
    typeof badMode?.selectError === 'string' && badMode.selectError.length > 0,
    (badMode?.selectError ?? '').slice(0, 60),
  );

  // (d) 老布尔 withAudio:true 必须翻译成 system（**不是** 普通 loopback）
  //     频点带上 420：它在本模式里一定在，用来给 1060 的「无」做定标
  const CD = [HZ.self, HZ.target];
  const legacy = await probe(srcTarget?.id ?? '', { withAudio: true }, CD, 1500);
  check(
    '(d) 老界面那个 withAudio:true 翻译成 system，不是普通 loopback',
    legacy?.audio?.deviceId === 'loopbackWithoutChrome',
    `实际 ${legacy?.audio?.deviceId ?? legacy?.gdmError ?? '无音轨'}`,
  );
  check(
    '(d) 翻译出来的那一路确实有声音（420 听得见）—— 「没采到自己」那条由 Case 2 的 A/B 对照负责',
    legacy?.audio !== undefined && heard(legacy, HZ.target, HZ.target),
    legacy?.audio ? `420 ${readings(legacy, CD, HZ.target)}` : '无音轨',
  );

  // (e) none：显式要画面不要声音，不该有音轨
  const noAudio = await probe(srcTarget?.id ?? '', { audioMode: 'none' }, [HZ.self], 700);
  check(
    '(e) none 模式：拿到画面、**没有**音轨',
    (noAudio?.video?.width ?? 0) > 0 && noAudio.audio === undefined,
    `tracks=${JSON.stringify(noAudio?.tracks ?? null)}`,
  );

  /* ------------------------------------------------------------------ *
   * 第 5 组：对照组（反向验证整套测量装置）
   * ------------------------------------------------------------------ */

  console.log('\n对照组（显式打开 GAMESHARE_ALLOW_RAW_LOOPBACK=1）');
  console.log('        前几组判的是「1060 Hz 不在」。这一组必须判出「在」——');
  console.log('        否则「不在」可能只是这套 FFT 根本听不见 1060 Hz。');
  process.env.GAMESHARE_ALLOW_RAW_LOOPBACK = '1';
  const capsRaw = await js('window.gameShare.capture.getAudioCapabilities()');
  check(
    '开了环境变量之后 loopback 变成可用（门禁两个方向都对，不是一个写死的 false）',
    capsRaw.modes.find((m) => m.mode === 'loopback')?.available === true,
  );
  const CC = [HZ.self, HZ.target, HZ.bystander];
  const control = await probe(srcTarget?.id ?? '', { audioMode: 'loopback' }, CC);
  dump('对照组', control, CC, HZ.self);
  if (control?.gdmError) {
    check('对照组采集成功', false, control.gdmError);
  } else {
    check('对照组 deviceId 就是普通 loopback', control.audio?.deviceId === 'loopback', `实际 ${control.audio?.deviceId}`);
    check(
      '对照组**听得见本实例自己的 1060 Hz** → 前面几组的「1060 无」是真隔离，不是装置失灵',
      heard(control, HZ.self, HZ.self),
    );
    check(
      '对照组同时也听得见 420 / 720（整机混音，符合普通 loopback 的定义）',
      heard(control, HZ.target, HZ.self) && heard(control, HZ.bystander, HZ.self),
    );
  }
  delete process.env.GAMESHARE_ALLOW_RAW_LOOPBACK;

  /* ------------------------------------------------------------------ *
   * 第 6 组：策略层（纯函数级）
   * ------------------------------------------------------------------ */

  /**
   * 这一组补的是采集链路**够不着**的那半段。
   *
   * 真采集只能证明「采回来的内容对」，证明不了「主进程回的是哪个字符串」——
   * Chromium 会把 `applicationLoopback:<pid>` 在 `getSettings().deviceId` 里
   * 换成一个**加盐哈希**（`loopback` / `loopbackWithoutChrome` 倒是原样返回），
   * 所以那个 id 没法从渲染层读回来核对。于是把策略层单独打一份直接调，
   * 「模式 + 目标 → device id」这个映射在此处是确定的、可断言的。
   */
  console.log('\n策略层（真模块的纯函数：模式 + 目标 → device id）');
  const strategies = require(path.join(CACHE, 'strategies.cjs'));
  const deviceIds = require(path.join(CACHE, 'device-ids.cjs'));
  const win = (pid) => ({ sourceId: 'window:123456:0', kind: 'window', pid });
  const screen = { sourceId: 'screen:0:0', kind: 'screen', pid: null };

  check(
    'application + 窗口 pid → applicationLoopback:<pid>',
    strategies.resolveAudioDevice('application', win(4321)).deviceId === 'applicationLoopback:4321',
    strategies.resolveAudioDevice('application', win(4321)).deviceId,
  );
  check(
    'system → loopbackWithoutChrome（与选了哪个源无关：屏幕源也给这个）',
    strategies.resolveAudioDevice('system', screen).deviceId === 'loopbackWithoutChrome',
  );
  check('none → null（不要音频）', strategies.resolveAudioDevice('none', win(4321)).deviceId === null);

  const thrown = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  const eScreen = thrown(() => strategies.resolveAudioDevice('application', screen));
  check(
    'application + 屏幕源 → 抛 pid-unavailable，并给 suggestion=system（建议而非替换）',
    eScreen?.code === 'pid-unavailable' && eScreen?.suggestion === 'system',
    eScreen ? `code=${eScreen.code} suggestion=${eScreen.suggestion}` : '居然没抛',
  );
  const eNoPid = thrown(() => strategies.resolveAudioDevice('application', { ...win(null) }));
  check(
    'application + 取不到 pid → 同样抛错（**不**退到普通 loopback）',
    eNoPid?.code === 'pid-unavailable' && /没有绑定到具体的应用窗口|取不到/.test(eNoPid?.message ?? ''),
    eNoPid?.message ?? '居然没抛',
  );
  const eRaw = thrown(() => strategies.resolveAudioDevice('loopback', win(4321)));
  check(
    'loopback 未显式开启 → 抛 raw-loopback-not-allowed',
    eRaw?.code === 'raw-loopback-not-allowed',
    eRaw?.code ?? '居然没抛',
  );
  check(
    'device-ids：source id → HWND（`window:1708206:0` → 1708206；屏幕源与畸形串一概 null，不猜）',
    deviceIds.parseHwndFromSourceId('window:1708206:0') === 1708206 &&
      deviceIds.parseHwndFromSourceId('screen:0:0') === null &&
      deviceIds.parseHwndFromSourceId('window:abc:0') === null,
  );
  check(
    'device-ids：applicationLoopbackDeviceId 对非法 pid 抛 RangeError（不生成一个坏字符串）',
    thrown(() => deviceIds.applicationLoopbackDeviceId(0)) instanceof RangeError &&
      thrown(() => deviceIds.applicationLoopbackDeviceId(1.5)) instanceof RangeError,
  );

  /* ------------------------------------------------------------------ *
   * 第 7 组：静态断言
   * ------------------------------------------------------------------ */

  console.log('\n静态断言组');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  /**
   * 去掉注释再做「字符串散落」检查。
   *
   * 这几条静态断言盯的是**代码里的字面量**，而 `types.ts` / `preload.ts` /
   * `global.d.ts` 的**注释**里到处都在提 `applicationLoopback:<pid>`
   * （那是刻意的：读代码的人必须知道底层用的是哪个 id）。
   * 不剥注释的话，这些断言第一次跑就会红，然后被人当成噪声删掉 —— 那才是真正的损失。
   *
   * 手写状态机而不是正则：注释里带反引号（markdown 行内代码），
   * 单靠「引号配对」会把 `` `xxx` `` 当成模板串、把后面的代码整段吃掉。
   */
  function stripComments(src) {
    let out = '';
    let i = 0;
    let state = 'code';
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') { state = 'line'; i += 2; out += '  '; continue; }
        if (c === '/' && n === '*') { state = 'block'; i += 2; out += '  '; continue; }
        if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue; }
        out += c; i += 1; continue;
      }
      if (state === 'line') {
        if (c === '\n') { state = 'code'; out += c; } else out += ' ';
        i += 1; continue;
      }
      if (state === 'block') {
        if (c === '*' && n === '/') { state = 'code'; i += 2; out += '  '; continue; }
        out += c === '\n' ? '\n' : ' ';
        i += 1; continue;
      }
      if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
      if (c === state) state = 'code';
      out += c; i += 1;
    }
    return out;
  }

  const strategiesSrc = read('apps/desktop/electron/audio/strategies.ts');
  const captureSrc = read('apps/desktop/electron/capture.ts');
  const buildSrc = read('apps/desktop/scripts/build-electron.mjs');
  const desktopPkg = JSON.parse(read('apps/desktop/package.json'));

  const strays = [];
  for (const file of [...walk(path.join(DESKTOP, 'electron')), ...walk(path.join(DESKTOP, 'src'))]) {
    if (path.basename(file) === 'device-ids.ts') continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (/['"`](loopbackWithoutChrome|applicationLoopback)/.test(code)) {
      strays.push(path.relative(ROOT, file));
    }
  }
  check(
    'device id 字面量没有散落到 device-ids.ts 之外（业务层只表达模式，不拼字符串）',
    strays.length === 0,
    strays.join(' '),
  );

  const applicationBlock =
    /ApplicationAudioCapture[\s\S]*?\n};/.exec(stripComments(strategiesSrc))?.[0] ?? '';
  check(
    'application 拿不到目标进程时**只抛错**，块里不出现普通 loopback（不自动降级）',
    applicationBlock.length > 0 &&
      !applicationBlock.includes('LEGACY_LOOPBACK_DEVICE_ID') &&
      applicationBlock.includes('AudioCaptureError'),
  );
  check('application 的失败带 suggestion: system（给建议，不是替换）', /suggestion:\s*'system'/.test(applicationBlock));
  check(
    '普通 loopback 被环境变量门禁挡住（rawLoopbackAllowed 读的是那个显式开关）',
    /rawLoopbackAllowed\(\)/.test(strategiesSrc) && /GAMESHARE_ALLOW_RAW_LOOPBACK/.test(strategiesSrc),
  );
  check(
    'resolveAudioDevice 解析失败时主进程回调空对象（不给画面），不静默降级',
    /\} catch \(err\) \{[\s\S]{0,1600}?callback\(\{\}\);\s*return;/.test(captureSrc),
  );
  check(
    'capture.ts 用的是策略层，没有自己拼 device id',
    /resolveAudioDevice\(/.test(captureSrc) &&
      !/['"`](loopbackWithoutChrome|applicationLoopback)/.test(stripComments(captureSrc)),
  );

  /**
   * 打包相关的三条 —— **dev 跑通 ≠ 打包后跑通**。
   *
   * koffi 是原生模块：esbuild 打不进 bundle（打进就是把 `.node` 的加载路径写死），
   * 而打包后它不在 asar 里，靠 extraResources 放到 resources/audio-ffi/。
   * 少任何一条，症状都只是「按应用共享声音不可用」——
   * 跟「打包漏了文件」这种原因在界面上长得一模一样。
   */
  check(
    'koffi 在 build-electron.mjs 里是 external（不然 bundle 里会写死加载路径）',
    /external:\s*\[[^\]]*'koffi'/.test(buildSrc),
  );
  const extra = desktopPkg.build?.extraResources ?? [];
  const koffiEntry = extra.find((e) => typeof e.to === 'string' && e.to === 'audio-ffi/node_modules/koffi');
  const koromixEntry = extra.find(
    (e) => typeof e.to === 'string' && e.to === 'audio-ffi/node_modules/@koromix/koffi-win32-x64',
  );
  check('extraResources 把 koffi 放进 resources/audio-ffi/node_modules/koffi', Boolean(koffiEntry), koffiEntry?.from ?? '');
  check(
    'extraResources 把 @koromix/koffi-win32-x64 放在**同一个 node_modules 下**（嵌套是硬要求）',
    Boolean(koromixEntry) && /win32_x64\/koffi\.node/.test(JSON.stringify(koromixEntry?.filter ?? [])),
    koromixEntry?.to ?? '缺',
  );

  /**
   * 上面两条看的是**配置文本**。但配置写着不等于跑过 —— 第一次查产物时发现
   * `release-4/win-unpacked/resources/` 下只有 app.asar / cloudflared.exe /
   * elevate.exe，**根本没有 audio-ffi**：那几条 extraResources 是后来补上的，
   * 补完从没真正打过一次包。这条失败在界面上只表现为「按应用共享声音不可用」，
   * 与「这台机器上就是没有 koffi」长得一模一样，不专门看一眼发现不了。
   *
   * 所以这里直接去看**产物**，而且不止看文件在不在：真 `require` 进来、
   * `load('user32.dll')` 再调一次 `IsWindow`。koffi 是按
   * `../../../@koromix/koffi-<platform>-<arch>` 找自己的二进制的 ——
   * 目录摆错位置时「文件都在、加载就炸」，只数文件数是看不出来的。
   *
   * 没有产物目录时**不算失败**（不是每台机器都打过包），只提示一句。
   * `GAMESHARE_CHECK_RELEASE_DIR=release-4` 可以指定看哪一份产物 ——
   * 既方便回查旧包，也是这两条断言的**反向验证**入口（指向没有 audio-ffi 的旧包
   * 就该红，实测 release-4 恰好红这两条）。
   */
  const overrideRelease = process.env.GAMESHARE_CHECK_RELEASE_DIR;
  const releaseDirs = (overrideRelease
    ? [path.join(DESKTOP, overrideRelease)]
    : fs
        .readdirSync(DESKTOP)
        .filter((name) => name.startsWith('release'))
        .map((name) => path.join(DESKTOP, name))
  )
    .filter((dir) => fs.existsSync(path.join(dir, 'win-unpacked', 'resources')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (releaseDirs.length === 0) {
    console.log(
      '  （提示）没找到打包产物，跳过「产物里到底有没有 koffi」这两条；' +
        '有条件就跑一次 npm run build:exe 再看',
    );
  } else {
    const newest = releaseDirs[0];
    const audioFfi = path.join(newest, 'win-unpacked', 'resources', 'audio-ffi', 'node_modules');
    const koffiDir = path.join(audioFfi, 'koffi');
    const nativeDir = path.join(audioFfi, '@koromix', 'koffi-win32-x64');
    const nativeNode = path.join(nativeDir, 'win32_x64', 'koffi.node');
    const wanted = [
      ['koffi/package.json', path.join(koffiDir, 'package.json')],
      ['koffi/index.cjs', path.join(koffiDir, 'index.cjs')],
      ['@koromix/koffi-win32-x64/index.js', path.join(nativeDir, 'index.js')],
      ['win32_x64/koffi.node', nativeNode],
    ];
    const missing = wanted.filter(([, file]) => !fs.existsSync(file));
    check(
      `最新打包产物（${path.basename(newest)}）的 resources/audio-ffi 里有 koffi 与原生二进制`,
      missing.length === 0,
      missing.length ? `缺 ${missing.map(([name]) => name).join(' / ')}` : '4 个文件都在',
    );

    let packagedLoadError = null;
    try {
      if (missing.length > 0) throw new Error('文件不全，不试加载');
      // 在 Electron 运行时里 require —— 与客户端启动后走的是同一条加载路径
      const packagedKoffi = require(koffiDir);
      const user32 = packagedKoffi.load('user32.dll');
      const isWindow = user32.func('bool IsWindow(void *hWnd)');
      if (typeof isWindow(0) !== 'boolean') throw new Error('IsWindow 没返回布尔值');
    } catch (err) {
      packagedLoadError = err instanceof Error ? err.message : String(err);
    }
    check(
      `最新打包产物里的 koffi 真的能加载并调到 Win32（嵌套没被摊平）`,
      packagedLoadError === null,
      packagedLoadError ?? path.relative(ROOT, nativeNode),
    );
  }

  /* ---------- 收尾 ---------- */
  console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项未通过`}（通过 ${passed}）`);

  for (const a of apps) killTree(a.pid);
  if (!host.isDestroyed()) host.destroy();
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200);
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

/**
 * 主窗口页面。它同时扮演两个角色：
 *
 *   · 「本软件自己播的声音」—— 持续 1060 Hz。前面几组都要求它**不被采到**，
 *     对照组要求它**被采到**。同一个声源同时充当正反两面的判据。
 *   · 采集端 —— `window.probe` 走真 preload 的 IPC 面，再调真 `getDisplayMedia`。
 *
 * 用 `<script>` 写在文件里而不是 `executeJavaScript` 拼字符串：这一段一百多行，
 * 拼字符串的话每加一句都要重新数转义，而且报错行号指向拼接结果、没法调试。
 */
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>APP-AUDIO-CHECK</title>
<body style="margin:0;background:#0e1418;color:#cfe;font:14px sans-serif">
<div style="padding:12px">APP-AUDIO-CHECK —— 本实例持续播放 ${HZ.self} Hz（代表「收到的远端语音」）</div>
<script>
  /* 本实例自己播的那一路。前面几组都要求它不被采到。 */
  const selfCtx = new AudioContext();
  const selfOsc = selfCtx.createOscillator();
  const selfGain = selfCtx.createGain();
  selfOsc.type = 'sine';
  selfOsc.frequency.value = ${HZ.self};
  selfGain.gain.value = 0.25;
  selfOsc.connect(selfGain).connect(selfCtx.destination);
  selfOsc.start();

  /** 数字静音时 WebAudio 给的是 -Infinity；统一成 -999，结构化克隆与判据都好处理 */
  const san = (v) => (Number.isFinite(v) ? v : -999);

  /**
   * 把「本实例自己播的声音」开 / 关。
   *
   * 这是这一整套里唯一真正管用的对照手段。频谱上「某个频点有一点能量」可能来自
   * 三种东西：自己漏进来的、别人在这儿的谐波、以及**几个别人的频率组合出来的
   * 互调产物**（实测碰上过：1360 + 1740 − 2040 正好等于 1060）。前两种没法靠
   * 「换个频率」躲干净，第三种更是换了频率还会撞上别的组合。
   *
   * 但把自己这一路一关，互调与谐波**两轮里一模一样** —— 相减就抵掉了，
   * 剩下的差值只可能是自己贡献的那一份。
   */
  window.setSelfTone = (on) => {
    selfGain.gain.value = on ? 0.25 : 0;
    return selfGain.gain.value;
  };

  /**
   * 采一次并量频域能量。
   *
   * 走的是**真链路**：preload 的 selectSource → capture.ts 的 handler →
   * setDisplayMediaRequestHandler → getDisplayMedia。任何一步失败都原样返回，
   * 不 catch 成一句日志 —— 失败原因本身就是判据的一部分。
   */
  window.probe = async (sourceId, options, hzList, ms) => {
    const out = { hzList };
    try {
      await window.gameShare.capture.selectSource(sourceId, options);
    } catch (e) {
      out.selectError = String((e && e.message) || e);
      return out;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      out.gdmError = String((e && e.name) || '') + ': ' + String((e && e.message) || e);
      // 主进程那侧才说得清「到底为什么没采到」，取走即清空
      out.failure = await window.gameShare.capture.takeFailure();
      return out;
    }

    out.tracks = stream.getTracks().map((t) => t.kind);
    const at = stream.getAudioTracks()[0] || null;
    const vt = stream.getVideoTracks()[0] || null;

    // 画面：数帧。只看「有没有 video track」会把「采到一帧就冻住」判成通过
    let frames = 0;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    try { await v.play(); } catch (e) { /* 只是数帧，播不动也不影响音频判据 */ }
    if (typeof v.requestVideoFrameCallback === 'function') {
      const tick = () => { frames += 1; v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
    }
    if (vt) {
      const s = vt.getSettings();
      out.video = { label: vt.label, width: s.width || 0, height: s.height || 0 };
    }

    if (at) {
      const s = at.getSettings();
      out.audio = {
        label: at.label,
        deviceId: s.deviceId || null,
        sampleRate: s.sampleRate || null,
        channelCount: s.channelCount || null,
        readyState: at.readyState,
      };

      const ac = new AudioContext();
      const an = ac.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      ac.createMediaStreamSource(new MediaStream([at])).connect(an);
      const bins = new Float32Array(an.frequencyBinCount);
      const binHz = ac.sampleRate / an.fftSize;
      const idx = (hz) => Math.round(hz / binHz);
      const binRange = (lo, hi) => [
        Math.max(0, Math.floor(lo / binHz)),
        Math.min(bins.length - 1, Math.ceil(hi / binHz)),
      ];

      /**
       * 每个 bin 取**逐帧中位数**，不是时间峰值。
       *
       * 这里踩过一次，代价是整套 A/B 判据全部失效，所以值得写清楚：
       *
       * 第一版取的是「时间峰值」（一窗里每个 bin 取最大值），想法是「有过能量就算有」。
       * 结果在**只有本实例在播 1060 Hz** 的隔离条件下，频谱里最响的几个 bin 落在
       * 744~797 Hz 与 1860~1880 Hz —— 播放频点自己反而不在榜上。那不是别人的声音，
       * 是回环链在近静音下的**瞬态**（缓冲边界那点咔哒 / 一次 underrun）：一次咔哒
       * 是宽带的，用峰值统计就会在同一瞬间把**全频段**一起抬起来，抬起的形状由咔哒
       * 决定、跟谁在播什么无关。于是「某个频点的读数」变成了本底形状的一部分，
       * 开 / 关自己的 A/B 也抵不掉（两轮里咔哒落在不同位置）。
       *
       * 中位数要求能量**持续存在**才留得下痕迹 —— 单频音本来就是持续 100% 的，
       * 而咔哒只占一两帧。这一条把「有没有这个声音」重新变成它本来该有的意思。
       * 真漏进来的声音不会因为换成中位数就消失（下面内部对照那条盯着这件事：
       * 「loopback」下自己那一路必须仍然读得出来，否则这套装置就是聋的）。
       * 注意：这一段注释在 HOST_PAGE 这个模板字符串**里面**，反引号会提前把字符串截断，
       * 所以这里的代码标识一律用「」。
       */
      const frames = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 60));
        an.getFloatFrequencyData(bins);
        frames.push(Float32Array.from(bins));
      }
      if (frames.length === 0) {
        an.getFloatFrequencyData(bins);
        frames.push(Float32Array.from(bins));
      }
      const perBin = new Float32Array(bins.length);
      const col = [];
      for (let i = 0; i < bins.length; i += 1) {
        col.length = 0;
        for (let k = 0; k < frames.length; k += 1) col.push(frames[k][i]);
        col.sort((a, b) => a - b);
        perBin[i] = col[col.length >> 1];
      }
      out.frameCount = frames.length;

      const maxIn = (lo, hi) => {
        const [a, b] = binRange(lo, hi);
        let p = -Infinity;
        for (let i = a; i <= b; i += 1) if (perBin[i] > p) p = perBin[i];
        return p;
      };
      /**
       * 局部本底：该频点两侧 55~170 Hz 那圈里「每 bin 时间峰值」的**中位数**。
       *
       * 用中位数而不是最大值，是为了不让落在这圈里的某一条互调产物把本底抬起来 ——
       * 一条线拉不动一堆 bin 的中位数。
       */
      const floorNear = (hz) => {
        const left = binRange(hz - 170, hz - 55);
        const right = binRange(hz + 55, hz + 170);
        const vals = [];
        for (let i = left[0]; i <= left[1]; i += 1) vals.push(perBin[i]);
        for (let i = right[0]; i <= right[1]; i += 1) vals.push(perBin[i]);
        vals.sort((a, b) => a - b);
        return vals.length ? vals[Math.floor(vals.length / 2)] : -Infinity;
      };

      out.peaks = hzList.map((hz) => san(maxIn(hz - ${25}, hz + ${25})));
      out.floors = hzList.map((hz) => san(floorNear(hz)));
      out.overall = san(maxIn(200, 6000));
      /**
       * 最响的几个 bin。
       *
       * 这是排查时唯一能回答「这一个 dB 到底是个干净的窄峰，还是本底形状的一部分」
       * 的东西 —— 只看某个频点的读数，两者长得一模一样。
       */
      out.topBins = (() => {
        const [a, b] = binRange(200, 6000);
        const rows = [];
        for (let i = a; i <= b; i += 1) rows.push([i * binHz, perBin[i]]);
        rows.sort((x, y) => y[1] - x[1]);
        return rows.slice(0, 10).map(([hz, db]) => [Math.round(hz), san(db)]);
      })();
      out.ctxSampleRate = ac.sampleRate;
      await ac.close();
    } else {
      // 没有音轨时不值得等完整测量窗口，但要给帧计数一点时间
      await new Promise((r) => setTimeout(r, Math.min(ms, 600)));
    }

    out.videoFrames = frames;
    v.srcObject = null;
    for (const t of stream.getTracks()) t.stop();
    return out;
  };
</script>
</body>`;

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 兜底：任何一步卡死都不该让自动化挂在那里等 */
setTimeout(() => {
  console.error('[check:app-audio] 超时（180s），强制退出');
  app.exit(1);
}, 180000);

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[check:app-audio] 崩了：', err);
    app.exit(1);
  });
});
