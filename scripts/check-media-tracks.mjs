/**
 * 三轨媒体结构验收（阶段三）。
 *
 * 与 `smoke-p2p.mjs` 的分工：
 *   smoke-p2p.mjs        验「画面通不通、画质档位对不对」
 *   check-media-tracks   验「三条轨各自的绑定、角色、生命周期、以及会不会串线」
 *
 * 两轮，缺一不可：
 *
 * ── 第 1 轮 `structure`：结构 + 生命周期 ──────────────────────────────
 *   四窗口、一个 Electron 进程。0 号用**合成源**共享（带一路 2825 Hz），
 *   其余只开麦；假麦克风设备喂一个 1200 Hz 的 WAV（`--use-file-for-fake-audio-capture`），
 *   这样两条音轨各带一个**已知且不同**的频率，才能断言「谁也没混进谁」。
 *   （2825 为什么必须落在 1200 那条旁带梳的缝里，见下面 `HZ.app` 的注释。）
 *   覆盖：m-line 顺序与类型、mid → 角色两端一致、三条轨各自挂对、
 *   关麦→再开、关应用声音但画面继续→再开、换源旧轨真的 ended、停止共享不关麦。
 *
 * ── 第 2 轮 `isolation`：真实回环下的数字反馈环 ──────────────────────
 *   这一轮才是「A 的 App Audio 里不得出现 Voice B/C/D」的正面回答。
 *   结构轮用的是合成源当应用声音 —— 那条轨里本来就不可能混进语音，断言必然绿，
 *   却什么也证明不了。所以这一轮让：
 *
 *     · 另起一个**独立 Electron 进程**（`_probe-audio-app.cjs`）持续播 2100 Hz，
 *       由 A 用**真实桌面捕获**共享它的窗口，音频模式取窗口共享的正式方案
 *       `application`（`applicationLoopback:<pid>`）—— 它同时是「必须被采到」的正对照；
 *     · 四个人各带一个不同的频率当语音（620 / 980 / 1300 / 1680，见 `HZ.voice`），
 *       并且每个人都把收到的远端语音**真的播到扬声器上**（`<audio>`，与产品同一套做法）
 *       —— 这正是反馈环的那半截：远端语音变成了本机的声学输出。
 *
 *   然后断言 A 的 appAudio 里**有** 2100、**没有**任何一路语音频率；
 *   并配**对照**两条：A 的 appAudio 里 2100 必须高于本底（否则是这套 FFT 聋了），
 *   A 的 voice 里必须有 A 自己的那个频率（否则语音链路压根没通，那些「没有」全是自证）。
 *
 * ⚠️ 这一轮**会真的出声**（2100 + 四路语音），跑之前把音量调小一点。
 * ⚠️ **没覆盖的**：真实游戏（用 Electron 冒充）、跨机、麦克风的声学回声（AEC）。
 *    真实的「双方都开声音会不会啸叫」只能两台机器实机听。
 *
 * 用法：
 *   npm run check:media-tracks
 *   node scripts/check-media-tracks.mjs --only isolation
 *   node scripts/check-media-tracks.mjs --visible 0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const TEST_DIR = path.join(DESKTOP, 'test');
const CACHE = path.join(ROOT, '.cache', 'check-media-tracks');
/** 产品主进程侧模块打到验收目录里（preload.cjs / capture.cjs），别混进 dist-electron */
const HARNESS_ELECTRON = path.join(TEST_DIR, 'dist-electron');
const RESULT_MARKER = '__HARNESS_RESULT__';

/* ------------------------------------------------------------------ *
 * 频点规划
 * ------------------------------------------------------------------ */

/**
 * 全部频点。**这里是唯一来源** —— 页面里的数值一律由命令行参数传过去，
 * 两边各写一份迟早漂移，而漂移会让断言悄悄失去意义（量的频率跟灌的不是一回事，
 * 读出来永远是「没有」，一路全绿）。
 */
const HZ = {
  /**
   * 四个人的语音，各不相干。
   *
   * 这组数是**搜出来的**：`verifyFreqPlan()` 会检查两两间隔，以及
   * 「任何两个同时在场的频率，它的二 / 三次谐波与和差产物都不落在别人的判定窗里」。
   * 第一版随手挑的 740/1080/1400/1700 就被它否掉了 —— `2×1080 − 740 = 1420`
   * 正好落进 1400 的窗里，那种互调产物会被判成「听见了 1400」。
   */
  voice: [620, 980, 1300, 1680],
  /** structure 轮：假麦克风 WAV */
  mic: 1200,
  /**
   * structure 轮：合成源那一路。
   *
   * 这个数**不是随手挑的，是量出来的**。用 `scripts/_probe-fake-mic.mjs` 单独量过
   * 假麦克风那条轨：灌进去一个纯正弦，量回来的是一条**旁带梳** ——
   * 主音的 ±250 Hz 倍数上都有一条（1200 那次：199 / 451 / 697 / 949 / 1201 /
   * 1447 / 1699 / 1951……正好全是 `1200 ± 250k`），而且幅度跟主音差不多少。
   *
   * 第一版用的 440 Hz 就撞在这条梳子上（`1200 − 750 = 450` 那条）。
   * 判据窗口只有 ±12 Hz（fftSize 8192 @48kHz），于是读出来是
   * 「voice 上的 440 比 1200 只低 0.7 dB」—— 看着像两条轨串了音，
   * 其实是**测量仪器自己的鬼影**，四个窗口一起假红。
   *
   * 2825 = 1200 + 1625 = 1200 + 6.5×250，**正落在两条旁带（2700 / 2950）正中**，
   * 离哪一条都有 125 Hz，是判据窗口的十倍。
   */
  app: 2825,
  /** isolation 轮：被共享的那个独立应用 */
  noise: 2100,
  /** 被共享窗口的标题。查找源列表时按它认人 */
  noiseTitle: 'PROBE-MEDIA-NOISE-2100',
};

/** 单个频点的「判定窗口」，与页面 FFT 取 ±2 bin 对应（48kHz / 8192 ≈ 5.9 Hz/bin） */
const GUARD_HZ = 25;
/** 两两之间至少要隔开这么多 */
const MIN_GAP_HZ = 300;

/**
 * 频点必须两两隔开，并且**任何两个同时在场的频率，它的二 / 三次谐波与和差产物
 * 都不能落进别人的判定窗口**。
 *
 * 这条是从 `check-app-audio.cjs` 那边学来的教训：实测撞到过
 * `1060 = 420 + 1360 − 720`，互调产物被当成「听见了那个频率」，
 * 于是「某条轨里没有别人的声音」这条判据直接变成假红 / 假绿。
 *
 * 返回问题清单（空数组 = 通过）。
 */
function verifyFreqPlan(freqs) {
  const problems = [];
  for (let i = 0; i < freqs.length; i += 1) {
    for (let j = i + 1; j < freqs.length; j += 1) {
      const gap = Math.abs(freqs[i] - freqs[j]);
      if (gap < MIN_GAP_HZ) problems.push(`${freqs[i]} 与 ${freqs[j]} 只差 ${gap} Hz`);
      if (gap <= GUARD_HZ * 2) problems.push(`${freqs[i]} 与 ${freqs[j]} 落在同一个判定窗里`);
    }
  }

  for (const f of freqs) {
    // 这个频率自己会产生的谐波 / 和差产物（以及与其它频率合出来的）
    const products = new Set([f * 2, f * 3]);
    for (const g of freqs) {
      if (g === f) continue;
      products.add(f + g);
      products.add(Math.abs(f - g));
      products.add(f * 2 + g);
      products.add(Math.abs(f * 2 - g));
    }
    for (const p of products) {
      for (const other of freqs) {
        if (other === f) continue;
        if (Math.abs(p - other) <= GUARD_HZ) {
          problems.push(`${f} Hz 的产物 ${p} Hz 落进了 ${other} Hz 的判定窗`);
        }
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
}

const visible = argValue('visible', '1') !== '0';
const only = argValue('only', '');
const verbose = argv.includes('--verbose');
const TOTAL = 4;
const ROUND_TIMEOUT_MS = Number(argValue('timeout', '240000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 假麦克风的 WAV
 * ------------------------------------------------------------------ */

/**
 * 生成一段循环播放的正弦波 WAV（48 kHz / 16 bit / 单声道）。
 *
 * 长度取**整数个周期**：文件是循环播的，首尾相位对不上就会每隔两秒咔哒一次，
 * 而一次瞬态会把整个频段同时抬起来 —— 那正是 `check-app-audio` 里
 * 「不能用时间峰值统计」那条教训的源头。
 */
function writeSineWav(file, hz, seconds = 2, rate = 48000, amp = 0.35) {
  const cycles = Math.max(1, Math.round(hz * seconds));
  const total = Math.round((cycles * rate) / hz);
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const v = Math.sin((2 * Math.PI * cycles * i) / total) * amp;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return { file, total, cycles };
}

/* ------------------------------------------------------------------ *
 * 小工具（与 smoke-p2p.mjs 同一套）
 * ------------------------------------------------------------------ */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

function createStaticServer(root) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** 本机预设了 ELECTRON_RUN_AS_NODE，不删掉子进程会退化成纯 Node、开不出窗口 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 带进程树一起杀掉（外部应用可能自己 spawn 了播放进程） */
function killTree(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 已经退出了 */
  }
}

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
  return width;
}

function padTo(text, width) {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function printTable(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(String(r[i] ?? '')))),
  );
  const line = (cells) => cells.map((c, i) => padTo(String(c ?? ''), widths[i])).join('  ');
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

/* ------------------------------------------------------------------ *
 * 打包验收页
 * ------------------------------------------------------------------ */

async function bundlePage() {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [path.join(TEST_DIR, 'media-tracks.ts')],
    outfile: path.join(TEST_DIR, 'dist', 'media-tracks.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });

  /**
   * 顺带把**产品**的主进程侧那两个模块也打一份出来给 harness 用。
   *
   * 隔离轮要跑真实桌面捕获，而这条链的正面就是「渲染层拿到
   * `window.gameShare.capture`，主进程挂上 `setDisplayMediaRequestHandler`
   * 与 `applicationLoopback:<pid>` 那一套」。验收脚本自己抄一份 handler 进去，
   * 验的就是抄件（`apps/desktop/electron/capture.ts` 的文件头对同一类问题
   * 已经写过一次），所以要直接引**这份源码**。
   *
   * 打包参数必须与 `apps/desktop/scripts/build-electron.mjs` 一致
   * （CJS、`electron` 与 `koffi` 留 external），否则验的又不是同一份东西。
   * 产物落在**验收目录**里，不进产品仓库的 `dist-electron/`。
   */
  await build({
    entryPoints: [
      path.join(DESKTOP, 'electron', 'preload.ts'),
      path.join(DESKTOP, 'electron', 'capture.ts'),
    ],
    outdir: HARNESS_ELECTRON,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    external: ['electron', 'koffi'],
    logLevel: 'warning',
  });
}

/* ------------------------------------------------------------------ *
 * 跑一轮 Electron 窗口
 * ------------------------------------------------------------------ */

async function runWindows(ctx, opts) {
  const env = cleanEnv();
  const child = spawn(ctx.electronPath, [path.join(TEST_DIR, 'electron', 'main.js')], {
    cwd: DESKTOP,
    env: {
      ...env,
      GAMESHARE_HARNESS_TOTAL: String(TOTAL),
      GAMESHARE_HARNESS_URL: `http://127.0.0.1:${ctx.staticPort}/media-tracks.html`,
      GAMESHARE_SIGNALING_URL: ctx.signalingUrl,
      GAMESHARE_HARNESS_VISIBLE: visible ? '1' : '0',
      GAMESHARE_HARNESS_TIMEOUT_MS: String(ROUND_TIMEOUT_MS),
      GAMESHARE_HARNESS_PHASE_MS: String(opts.phaseMs ?? 45000),
      GAMESHARE_HARNESS_EXTRA_QUERY: opts.query,
      /**
       * 产品的 preload 与采集 IPC。**两轮都挂**：结构轮虽然用合成源共享，
       * 但麦克风那一路走的是真 `getUserMedia`，而主进程一旦装了权限 handler，
       * 它就会连 `media` 一起判 —— 少挂这一份，反而会让结构轮的麦克风悄悄变成
       * 「权限被拒」。uniform 比「按轮开关」少一类只在某一轮出现的偏差。
       */
      GAMESHARE_HARNESS_PRODUCT_PRELOAD: path.join(HARNESS_ELECTRON, 'preload.cjs'),
      GAMESHARE_HARNESS_CAPTURE_MODULE: path.join(HARNESS_ELECTRON, 'capture.cjs'),
      ...(opts.fakeMic ? { GAMESHARE_HARNESS_FAKE_MIC: opts.fakeMic } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    for (const line of text.split('\n')) {
      if (!line.trim() || line.includes(RESULT_MARKER)) continue;
      console.log(`  ${line.replace(/^\[harness\]\s?/, '')}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (verbose) process.stderr.write(String(chunk));
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
    child.on('error', (err) => {
      console.error(`  Electron 启动失败：${err.message}`);
      resolve(-1);
    });
  });

  const markerLine = stdout.split('\n').find((l) => l.includes(RESULT_MARKER));
  if (!markerLine) {
    console.error('  未拿到验收结果。Electron 输出：');
    console.error(stdout.trim() || '(stdout 为空)');
    if (stderr.trim()) console.error(stderr.trim());
    return { result: null, exitCode };
  }
  try {
    return {
      result: JSON.parse(markerLine.slice(markerLine.indexOf(RESULT_MARKER) + RESULT_MARKER.length)),
      exitCode,
    };
  } catch (err) {
    console.error(`  结果解析失败：${err.message}`);
    return { result: null, exitCode };
  }
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

/** 某个窗口上报的检查项里，是否有 label 含 `needle` 且通过的那一条 */
function hasCheck(peer, needle) {
  return (peer.checks ?? []).some((c) => c.label.includes(needle) && c.ok);
}

function verifyStructure(result) {
  const problems = [];
  if (!result) return ['没有拿到验收结果'];
  if (result.peers.length !== TOTAL) {
    problems.push(`只收到 ${result.peers.length}/${TOTAL} 个客户端的报告`);
  }

  for (const peer of result.peers) {
    const tag = `P${peer.index}`;
    if (!peer.ok) problems.push(`${tag} 自检未通过：${peer.failure ?? '未知'}`);
    if (peer.mode !== 'structure') problems.push(`${tag} 跑的不是 structure 轮（${peer.mode}）`);

    // 断言「断言真的跑过了」：光看 ok 分不出「全绿」和「一条都没跑」。
    // 检查项按角色要求 —— 0 号是共享方，其余是接收方，两边该验的东西不一样。
    for (const needle of ['m-line 恰好', 'mid → 角色']) {
      if (!hasCheck(peer, needle)) problems.push(`${tag} 缺少检查项「${needle}」`);
    }
    if (peer.index === 0) {
      for (const needle of [
        '停止共享**没有**顺手关掉麦克风',
        '换源后旧的应用音轨',
        '用的是假麦克风设备',
        // 交叉串线两边都要量：0 号量的是**自己送出去**的两条轨，方向不同，
        // 但判据是同一件事（谁也没混进谁），所以这几条谁都缺不得
        '正对照',
        '没有**语音',
        'voice 里**没有**应用声音',
      ]) {
        if (!hasCheck(peer, needle)) problems.push(`${tag} 缺少检查项「${needle}」`);
      }
    } else {
      for (const needle of [
        '正对照',
        '没有**语音',
        'voice 里**没有**应用声音',
        '三条远端轨是三个不同的轨道对象',
        '旁观者见到过 0 号的语音轨变为静默',
        '观测窗口内见到了 0 号停止共享',
      ]) {
        if (!hasCheck(peer, needle)) problems.push(`${tag} 缺少检查项「${needle}」`);
      }
    }
  }
  return problems;
}

function verifyIsolation(result) {
  const problems = [];
  if (!result) return ['没有拿到验收结果'];
  if (result.peers.length !== TOTAL) {
    problems.push(`只收到 ${result.peers.length}/${TOTAL} 个客户端的报告`);
  }

  for (const peer of result.peers) {
    const tag = `P${peer.index}`;
    if (!peer.ok) problems.push(`${tag} 自检未通过：${peer.failure ?? '未知'}`);
    if (peer.mode !== 'isolation') problems.push(`${tag} 跑的不是 isolation 轮（${peer.mode}）`);

    // 这一轮的判据必须真的量过：正对照 + 反面对照 + 正题，缺一条就等于没验
    if (!hasCheck(peer, '正对照')) problems.push(`${tag} 缺少「必须被采到」的正对照`);
    if (!hasCheck(peer, '反面对照')) problems.push(`${tag} 缺少「语音链路是活的」的反面对照`);
    if (!hasCheck(peer, '数字反馈环真的断了')) {
      problems.push(`${tag} 缺少本轮的正题断言（数字反馈环真的断了）`);
    }
    if (peer.playingVoices !== TOTAL - 1) {
      problems.push(`${tag} 只把 ${peer.playingVoices}/${TOTAL - 1} 路远端语音播上了扬声器`);
    }
    if (peer.index === 0) {
      if (!hasCheck(peer, '本地量自己的 App Audio')) {
        problems.push('P0 缺少本地侧的同轨复核');
      }
      // 回环轨的 settings 那一条必须真的量过：它是这一轮里唯一能直接抓住
      // 「getDisplayMedia 的音频默认把 AEC/NS/AGC 全开」这类事故的断言 ——
      // 少了它，反馈环有没有断就只剩「被抵消器盖住」这一种解释。
      if (!hasCheck(peer, '回环没有被套上')) {
        problems.push('P0 缺少「回环没被套上麦克风那三件套」那条断言');
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 打印
 * ------------------------------------------------------------------ */

function printStructureSummary(result) {
  if (!result) return;
  console.log('');
  console.log(`  房间码 ${result.peers[0]?.roomCode ?? '?'} · ${TOTAL} 人 · 每人 3 条 m-line`);
  const rows = [];
  for (const peer of result.peers) {
    const total = (peer.checks ?? []).length;
    const bad = (peer.checks ?? []).filter((c) => !c.ok).length;
    rows.push([
      `P${peer.index}`,
      peer.index === 0 ? '共享 + 开麦' : '只开麦',
      `${total - bad}/${total}`,
      bad === 0 ? '✓' : `${bad} 项未通过`,
    ]);
  }
  printTable(['客户端', '角色', '检查项', '结果'], rows);
}

function printIsolationSummary(result) {
  if (!result) return;
  console.log('');
  console.log('  四人模型：A(P0) 共享独立应用的窗口 + 开麦，B/C/D 只开麦；');
  console.log(
    `  四路语音频率 ${HZ.voice.join(' / ')} Hz，被共享应用 ${HZ.noise} Hz，音频模式 application`,
  );
  console.log('');
  const rows = [];
  for (const peer of result.peers) {
    const bad = (peer.checks ?? []).filter((c) => !c.ok).length;
    const positive = (peer.checks ?? []).find((c) => c.label.includes('正对照'));
    rows.push([
      `P${peer.index}`,
      peer.index === 0 ? 'A' : '观众',
      positive?.detail ?? '-',
      bad === 0 ? '✓' : `${bad} 项未通过`,
    ]);
  }
  printTable(['客户端', '角色', 'appAudio 里噪声源高出本底', '结果'], rows);

  // 把正题的读数单独摊开 —— 失败时最需要的就是这几个数
  const witness = result.peers.find((p) => p.index !== 0);
  const verdict = (witness?.checks ?? []).find((c) => c.label.includes('数字反馈环真的断了'));
  if (verdict) {
    console.log('');
    console.log(`  A 的 App Audio 与四路语音的隔离度：${verdict.detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('');
  console.log('GameShare · 三轨媒体结构验收');
  console.log(`  node ${process.version} · ${TOTAL} 人 · 窗口${visible ? '可见' : '隐藏'}`);

  /* 0. 频点自检 —— 这一条必须最先跑，它坏了后面所有频谱断言都不成立 */
  console.log('');
  console.log('  频点规划自检 …');
  const structurePlan = [HZ.app, HZ.mic];
  const isolationPlan = [HZ.noise, ...HZ.voice];
  const planProblems = [
    ...verifyFreqPlan(structurePlan).map((p) => `structure：${p}`),
    ...verifyFreqPlan(isolationPlan).map((p) => `isolation：${p}`),
  ];
  if (planProblems.length > 0) {
    console.error(`  ✗ 频点规划不合法（互调产物会污染判据）：`);
    for (const p of planProblems) console.error(`      · ${p}`);
    process.exit(1);
  }
  console.log(
    `  ✓ structure [${structurePlan.join(', ')}] / isolation [${isolationPlan.join(', ')}] ` +
      `两两间隔 ≥${MIN_GAP_HZ}Hz，谐波与和差产物都在判定窗（±${GUARD_HZ}Hz）之外`,
  );

  /* 1. 假麦克风 WAV */
  console.log('');
  console.log('  准备假麦克风信号 …');
  const wav = writeSineWav(path.join(CACHE, `mic-${HZ.mic}.wav`), HZ.mic);
  console.log(
    `  ✓ ${wav.file}（${wav.total} 帧 / ${wav.cycles} 个周期，整数周期所以循环处不咔哒）`,
  );

  /* 2. 打包验收页 */
  console.log('');
  console.log('  打包验收页面 …');
  await bundlePage();
  console.log('  ✓ 打包完成');

  /* 3. 信令服务 */
  const signalingPort = await findFreePort();
  const signaling = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'apps', 'signaling', 'src', 'index.ts')],
    {
      cwd: ROOT,
      env: { ...cleanEnv(), PORT: String(signalingPort), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let signalingErr = '';
  signaling.stderr.on('data', (c) => {
    signalingErr += String(c);
  });
  if (!(await waitHealth(`http://127.0.0.1:${signalingPort}/health`, 30_000))) {
    console.error('  信令服务启动失败');
    if (signalingErr.trim()) console.error(signalingErr.trim());
    signaling.kill();
    process.exit(1);
  }
  console.log(`  ✓ 信令服务就绪 :${signalingPort}`);

  /* 4. 静态服务 */
  const staticPort = await findFreePort();
  const staticServer = createStaticServer(TEST_DIR);
  await listen(staticServer, staticPort);
  console.log(`  ✓ 验收页面就绪 :${staticPort}`);

  const ctx = {
    staticPort,
    signalingUrl: `http://127.0.0.1:${signalingPort}`,
    electronPath: require('electron'),
  };
  const summary = [];

  try {
    /* ---- 第 1 轮：结构 + 生命周期 ---- */
    if (only !== 'isolation') {
      console.log('');
      console.log('━━━ 第 1 轮 · 结构 + 生命周期（合成源 + 假麦克风）━━━');
      const query =
        `&mode=structure&fakemic=1&michz=${HZ.mic}&apphz=${HZ.app}` +
        `&voicehz=${HZ.voice.join(',')}&noisehz=${HZ.noise}`;
      const { result } = await runWindows(ctx, { query, fakeMic: wav.file, phaseMs: 45000 });
      const problems = verifyStructure(result);
      const ok = problems.length === 0;
      printStructureSummary(result);
      if (!ok) {
        console.log('');
        console.log(`  ✗ ${problems.length} 项未通过：`);
        for (const p of problems) console.log(`      · ${p}`);
      }
      check('第 1 轮 · 结构 + 生命周期', ok);
      summary.push({ label: '第 1 轮 · 结构 + 生命周期', ok });
      await sleep(800);
    }

    /* ---- 第 2 轮：真实回环下的数字反馈环 ---- */
    if (only !== 'structure') {
      console.log('');
      console.log('━━━ 第 2 轮 · 数字反馈环（真实桌面捕获 + 独立应用）━━━');
      console.log(`  拉起独立应用（${HZ.noise} Hz / 标题 ${HZ.noiseTitle}）…`);
      const noise = spawn(
        ctx.electronPath,
        [path.join(here, '_probe-audio-app.cjs'), `--freq=${HZ.noise}`, `--title=${HZ.noiseTitle}`],
        { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let noiseReady = false;
      noise.stdout.on('data', (chunk) => {
        const text = String(chunk);
        if (verbose) process.stdout.write(text);
        if (text.includes('窗口就绪')) noiseReady = true;
      });
      noise.stderr.on('data', (chunk) => {
        if (verbose) process.stderr.write(String(chunk));
      });

      const deadline = Date.now() + 20_000;
      while (!noiseReady && Date.now() < deadline) await sleep(200);
      if (!noiseReady) {
        console.error('  ✗ 独立应用窗口没能就绪，这一轮无法进行');
        killTree(noise.pid);
        check('第 2 轮 · 数字反馈环', false);
        summary.push({ label: '第 2 轮 · 数字反馈环', ok: false });
      } else {
        console.log('  ✓ 独立应用已就绪并开始发声');
        await sleep(1_000);

        const query =
          `&mode=isolation&appmode=application&noisehz=${HZ.noise}` +
          `&noisetitle=${encodeURIComponent(HZ.noiseTitle)}` +
          `&voicehz=${HZ.voice.join(',')}`;
        const { result } = await runWindows(ctx, { query, phaseMs: 60000 });
        const problems = verifyIsolation(result);
        const ok = problems.length === 0;
        printIsolationSummary(result);
        if (!ok) {
          console.log('');
          console.log(`  ✗ ${problems.length} 项未通过：`);
          for (const p of problems) console.log(`      · ${p}`);
        }
        check('第 2 轮 · 数字反馈环', ok);
        summary.push({ label: '第 2 轮 · 数字反馈环', ok });
      }

      killTree(noise.pid);
      await sleep(500);
    }
  } finally {
    staticServer.close();
    signaling.kill('SIGTERM');
    await sleep(300);
    if (signaling.exitCode === null) signaling.kill('SIGKILL');
  }

  console.log('');
  console.log('══════════════════════════════════════');
  for (const entry of summary) console.log(`  ${entry.ok ? '✓' : '✗'} ${entry.label}`);
  console.log('══════════════════════════════════════');
  console.log(`  合计 ${passed} 项通过 / ${failed} 项未通过`);
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
