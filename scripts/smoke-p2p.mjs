/**
 * P2P 验收脚本。
 *
 * 本机自动化跑「N 个真实客户端互连」，替代「两台电脑手工看」——
 * 结论来自 RTCPeerConnection.getStats() 的解码帧数，而不是肉眼看。
 *
 * 流程：
 *   1. esbuild 打包验收页面
 *   2. 起信令服务（临时端口）
 *   3. 起静态服务托管验收页面
 *   4. 拉起 N 个 Electron 渲染进程跑真实 WebRTC 协商
 *   5. 汇总每个窗口上报的统计做断言
 *
 * 覆盖 M1 的两条验收：
 *   · 双向看到对方画面（解码帧数 / 像素尺寸 / 帧数持续增长）
 *   · 断开一端后对端正确清理（主进程真实销毁一个窗口，其余窗口断言清理完成）
 *
 * 用法：
 *   node scripts/smoke-p2p.mjs                  # 2 人 + 断开场景，M1 验收
 *   node scripts/smoke-p2p.mjs --peers 2,4      # 先跑 2 人再跑 4 人
 *   node scripts/smoke-p2p.mjs --peers 4 --visible 0
 *   node scripts/smoke-p2p.mjs --no-leave       # 跳过断开场景
 */

import { spawn } from 'node:child_process';
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
const RESULT_MARKER = '__HARNESS_RESULT__';

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

const peerCounts = String(argValue('peers', '2'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n >= 2 && n <= 4);
const visible = argValue('visible', '1') !== '0';
const verbose = argv.includes('--verbose');
const runLeave = !argv.includes('--no-leave');
const leavePeers = Number(argValue('leave-peers', '3'));

if (peerCounts.length === 0) {
  console.error('--peers 需要 2~4 之间的整数，例如 --peers 2 或 --peers 2,4');
  process.exit(2);
}
if (runLeave && (!Number.isInteger(leavePeers) || leavePeers < 3 || leavePeers > 4)) {
  console.error('--leave-peers 需要 3~4 之间的整数（断开场景至少要有 3 个客户端）');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function createStaticServer(root) {
  const server = http.createServer((req, res) => {
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
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* ------------------------------------------------------------------ *
 * 单轮验收
 * ------------------------------------------------------------------ */

async function runRound(total, ctx, opts = {}) {
  const leave = opts.leave === true;
  console.log('');
  console.log(`━━━ ${leave ? `${total} 人 · 断开一端` : `${total} 人 P2P`} 验收 ━━━`);
  console.log('');

  const harnessUrl = `http://127.0.0.1:${ctx.staticPort}/harness.html`;
  const env = { ...process.env };
  // 本机预设了这个变量，不清掉 Electron 会退化成纯 Node，主进程直接崩
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(ctx.electronPath, [path.join(TEST_DIR, 'electron', 'main.js')], {
    cwd: DESKTOP,
    env: {
      ...env,
      GAMESHARE_HARNESS_TOTAL: String(total),
      GAMESHARE_HARNESS_URL: harnessUrl,
      GAMESHARE_SIGNALING_URL: ctx.signalingUrl,
      GAMESHARE_HARNESS_VISIBLE: visible ? '1' : '0',
      GAMESHARE_HARNESS_LEAVE: leave ? '1' : '0',
      GAMESHARE_HARNESS_TIMEOUT_MS: '150000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (line.includes(RESULT_MARKER)) continue;
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
    return { pass: false };
  }

  let result;
  try {
    result = JSON.parse(markerLine.slice(markerLine.indexOf(RESULT_MARKER) + RESULT_MARKER.length));
  } catch (err) {
    console.error(`  结果解析失败：${err.message}`);
    return { pass: false };
  }

  return { pass: verify(result, { leave }), result, exitCode };
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

function verify(result, opts = {}) {
  const leave = opts.leave === true;
  const problems = [];
  const total = result.total;
  // 断开场景下被销毁的窗口不会上报，期望数与链路数都要相应减一
  const expectedReporters = leave ? total - 1 : total;
  const expectedLinks = leave ? total - 2 : total - 1;

  if (result.peers.length !== expectedReporters) {
    problems.push(`只收到 ${result.peers.length}/${expectedReporters} 个客户端的报告`);
  }

  for (const peer of result.peers) {
    const tag = `P${peer.index}`;
    if (!peer.ok) problems.push(`${tag} 自检未通过：${peer.failure ?? '未知'}`);
    if (!peer.peerId) problems.push(`${tag} 没有 peerId`);
    if (!peer.roomCode) problems.push(`${tag} 没有加入房间`);

    if (leave && peer.checks?.peerLeaveCleanup !== true) {
      problems.push(`${tag} 没有验证「对端断开后清理完成」`);
    }

    if (peer.links.length !== expectedLinks) {
      problems.push(`${tag} 链路数 ${peer.links.length}，期望 ${expectedLinks}`);
    }

    for (const link of peer.links) {
      const short = link.peerId.slice(0, 6);
      if (link.state !== 'connected') {
        problems.push(`${tag} → ${short} 链路状态 ${link.state}`);
        continue;
      }
      if (!link.inbound) {
        problems.push(`${tag} → ${short} 没有收到远端轨道`);
        continue;
      }
      if (link.inbound.framesDecoded < 10) {
        problems.push(`${tag} → ${short} 只解码了 ${link.inbound.framesDecoded} 帧`);
      }
      if (link.inbound.bytesReceived <= 0) {
        problems.push(`${tag} → ${short} 收不到字节`);
      }
      if (link.videoWidth <= 0) {
        problems.push(`${tag} → ${short} <video> 没拿到画面尺寸`);
      }
      if (!link.framesAdvancing) {
        problems.push(`${tag} → ${short} 帧数已停止增长（画面冻住）`);
      }
      // 断言的正确形式是「实际落下去的值 == 协议按源高算出来的值」。
      // 不能笼统要求 scaleResolutionDownBy > 1：FOCUS 在 720p 源上按设计就等于 1
      // （源低于目标档位时不放大），那样写会把正确结果判成失败。
      if (link.sourceHeight == null) {
        problems.push(`${tag} → ${short} 读不到采集源高度，无法确认换算是按源而不是按显示器分辨率`);
      }
      if (!link.encoding) {
        problems.push(`${tag} → ${short} 读不到编码参数，画质档位没有落下去`);
      } else if (link.expectedScaleResolutionDownBy != null) {
        const actual = link.encoding.scaleResolutionDownBy;
        const expected = link.expectedScaleResolutionDownBy;
        if (Math.abs(actual - expected) > 1e-6) {
          problems.push(
            `${tag} → ${short} scaleResolutionDownBy=${actual}，` +
              `档位 ${link.qualityLevel ?? '?'} / 源高 ${link.sourceHeight} 应为 ${expected}，` +
              `源高度换算可能没生效`,
          );
        }
      }
    }
  }

  // 每条链路必须双向都对上：只看单边可能掩盖「一边通了另一边没通」
  const peerIds = new Set(result.peers.map((p) => p.peerId));
  for (const peer of result.peers) {
    for (const link of peer.links) {
      if (!peerIds.has(link.peerId)) {
        problems.push(`P${peer.index} 有一条指向未知 peer ${link.peerId.slice(0, 6)} 的链路`);
      }
    }
  }

  if (problems.length > 0) {
    console.log('');
    console.log(`  ✗ ${problems.length} 项未通过：`);
    for (const p of problems) console.log(`      · ${p}`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

function printSummary(result, label, opts = {}) {
  const leave = opts.leave === true;
  const scope = leave
    ? `${result.total} 人 → 断开 1 人 · 剩余 ${result.total - 2} 条有向链路`
    : `${result.total} 人 · ${result.total * (result.total - 1)} 条有向链路`;
  console.log('');
  console.log(`  房间码 ${result.peers[0]?.roomCode ?? '?'} · ${scope}`);
  console.log('');

  // 「解码分辨率」往往小于「档位标称值」：scaleResolutionDownBy 只是我们设的下限，
  // Chrome 还会按带宽估计继续自适应降分辨率（qualityLimitationReason=bandwidth）。
  // 两列都打出来，才分得清「档位没生效」和「生效了但被带宽压下去」。
  const header = ['客户端', '链路', '对端', '状态', '档位', '解码分辨率', '出分辨率', 'FPS', '收码率', '解码帧数', '出码率上限', '缩放', '路径'];
  const rows = [];

  for (const peer of result.peers) {
    if (peer.links.length === 0) {
      rows.push([`P${peer.index}`, '-', '-', '无链路', ...Array(9).fill('-')]);
    }
    for (const link of peer.links) {
      const inb = link.inbound;
      const out = link.outbound;
      rows.push([
        `P${peer.index}`,
        link.state,
        link.peerId.slice(0, 6),
        link.state === 'connected' ? '✓' : '✗',
        link.qualityLevel ?? '-',
        inb ? `${inb.frameWidth}x${inb.frameHeight}` : '-',
        out ? `${out.frameWidth}x${out.frameHeight}` : '-',
        inb ? String(inb.framesPerSecond) : '-',
        inb ? `${Math.round(inb.bitrateBps / 1000)}k` : '-',
        inb ? String(inb.framesDecoded) : '-',
        link.encoding?.maxBitrate ? `${Math.round(link.encoding.maxBitrate / 1000)}k` : '-',
        link.encoding ? link.encoding.scaleResolutionDownBy.toFixed(3) : '-',
        link.route ? (link.route.relay ? `TURN/${link.route.localType}` : `P2P/${link.route.localType}`) : '未知',
      ]);
    }
  }

  printTable(header, rows);

  // 失败时把客户端自己的日志打出来 —— 否则只能看到「未达成」，无从下手
  const failed = result.peers.filter((p) => !p.ok);
  if (failed.length > 0) {
    for (const peer of failed) {
      console.log('');
      console.log(`  ── P${peer.index} 日志（末尾 30 行）──`);
      for (const line of (peer.logs ?? []).slice(-30)) console.log(`      ${line}`);
    }
  }

  // 断开场景下没有提档动作，跳过 M5 预演
  if (result.total >= 3 && !leave) {
    const focusRows = [];
    for (const peer of result.peers) {
      for (const link of peer.links) {
        if (link.encoding?.maxBitrate === 4_000_000) {
          focusRows.push(`P${peer.index} → ${link.peerId.slice(0, 6)} 已是 4 Mbps（FOCUS）`);
        }
      }
    }
    if (focusRows.length > 0) {
      console.log('');
      console.log('  按观看者独立控画质（M5 预演）：');
      for (const line of focusRows) console.log(`      · ${line}`);
      // encoding 只能由发送方读到，所以这里直接数有向链路，不折算成「对」
      const gridCount = result.peers.reduce(
        (n, p) => n + p.links.filter((l) => l.encoding?.maxBitrate === 1_500_000).length,
        0,
      );
      console.log(`      · 其余 ${gridCount} 条有向链路仍保持 1.5 Mbps（GRID）`);
    } else {
      console.log('');
      console.log('  ⚠ 没有观察到任何链路被提到 4 Mbps（FOCUS）——按观看者控画质这一条没验证到');
    }
  }

  if (leave) {
    console.log('');
    console.log('  断开一端后的清理（M1 第二条验收）：');
    for (const peer of result.peers) {
      console.log(
        `      · P${peer.index} 已确认：链路与远端流移除、成员列表缩减、` +
          `RTCPeerConnection 已 close`,
      );
    }
  }

  console.log('');
  console.log(`  ${label}`);
  console.log('');
}

function printTable(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(
      displayWidth(h),
      ...rows.map((r) => displayWidth(String(r[i] ?? ''))),
    ),
  );

  const line = (cells, pad = ' ') =>
    cells.map((c, i) => padTo(String(c ?? ''), widths[i], pad)).join('  ');

  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
  return width;
}

function padTo(text, width, pad) {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + pad.repeat(diff) : text;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('');
  console.log('GameShare · P2P 链路验收');
  console.log(
    `  node ${process.version} · 目标 ${peerCounts.join(' / ')} 人` +
      (runLeave ? ` + 断开场景 ${leavePeers} 人` : '') +
      ` · 窗口${visible ? '可见' : '隐藏'}`,
  );

  /* 1. 打包验收页面 */
  console.log('');
  console.log('  打包验收页面 …');
  const { build } = await import('esbuild');
  await build({
    entryPoints: [path.join(TEST_DIR, 'harness.ts')],
    outfile: path.join(TEST_DIR, 'dist', 'harness.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  console.log('  ✓ 打包完成');

  /* 2. 信令服务 */
  const signalingPort = await findFreePort();
  const signalingEnv = { ...process.env, PORT: String(signalingPort), HOST: '127.0.0.1', LOG_LEVEL: 'warn' };
  delete signalingEnv.ELECTRON_RUN_AS_NODE;

  const signaling = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'apps', 'signaling', 'src', 'index.ts')],
    { cwd: ROOT, env: signalingEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let signalingErr = '';
  signaling.stderr.on('data', (c) => {
    signalingErr += String(c);
  });

  const healthUrl = `http://127.0.0.1:${signalingPort}/health`;
  if (!(await waitHealth(healthUrl, 30_000))) {
    console.error('  信令服务启动失败');
    if (signalingErr.trim()) console.error(signalingErr.trim());
    signaling.kill();
    process.exit(1);
  }
  console.log(`  ✓ 信令服务就绪 :${signalingPort}`);

  /* 3. 静态服务 */
  const staticPort = await findFreePort();
  const staticServer = createStaticServer(TEST_DIR);
  await listen(staticServer, staticPort);
  console.log(`  ✓ 验收页面就绪 :${staticPort}`);

  /* 4. 逐轮跑 */
  const electronPath = require('electron');
  let allPassed = true;
  const summary = [];

  try {
    for (const total of peerCounts) {
      const { pass, result } = await runRound(total, {
        staticPort,
        electronPath,
        signalingUrl: `http://127.0.0.1:${signalingPort}`,
      });
      allPassed = allPassed && pass;
      if (result) printSummary(result, pass ? '✓ 通过' : '✗ 未通过');
      summary.push({ total, pass, leave: false });
      await sleep(500);
    }

    if (runLeave) {
      const { pass, result } = await runRound(
        leavePeers,
        {
          staticPort,
          electronPath,
          signalingUrl: `http://127.0.0.1:${signalingPort}`,
        },
        { leave: true },
      );
      allPassed = allPassed && pass;
      if (result) printSummary(result, pass ? '✓ 通过' : '✗ 未通过', { leave: true });
      summary.push({ total: leavePeers, pass, leave: true });
      await sleep(500);
    }
  } finally {
    staticServer.close();
    signaling.kill('SIGTERM');
    await sleep(300);
    if (signaling.exitCode === null) signaling.kill('SIGKILL');
  }

  console.log('══════════════════════════════════════');
  for (const entry of summary) {
    console.log(`  ${entry.pass ? '✓' : '✗'} ${entry.total} 人${entry.leave ? '（断开一端）' : ''}`);
  }
  console.log('══════════════════════════════════════');
  console.log('');

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
