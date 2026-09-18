#!/usr/bin/env node
/**
 * 校验「客户端内置信令服务器」在**打包产物**里真的能起来。
 *
 * 为什么单独有这个脚本：这件事跨了构建边界 —— 服务器代码是被 esbuild
 * 打进 Electron 主进程的，开发模式跑通不代表打包后跑得通
 * （asar、socket.io 的打包方式、端口绑定都可能出岔）。
 * 而它失败时的表现是「另一台电脑连不上」，排查成本很高，所以直接拿产物验。
 *
 * 检查项：
 *   1. 启动打包后的客户端 → 8080 有监听，且 /health 在**回环与局域网地址都**返回 200。
 *      回环通只说明服务器起来了；局域网也通才说明绑的地址别的电脑够得到。
 *   2. /health 在 **IPv6 回环**也返回 200 —— 说明是双栈监听，公网 IPv6 那条路没被堵死。
 *   3. socket.io 握手正常（说明不只是个静态 HTTP 服务）。
 *   4. 关掉客户端后端口被释放，不留残余监听。
 *   5. 8080 已被占用时，第二个实例要能存活且不抛未捕获异常
 *      —— 否则「本机开两个客户端互看」这条联调路径直接不可用。
 *
 * 用法：
 *   node scripts/check-embedded-server.mjs
 *   node scripts/check-embedded-server.mjs --exe "apps/desktop/release/win-unpacked/GameShare.exe"
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const PORT = 8080;

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/**
 * 定位要验的 exe。
 *
 * 不写死 `release/`：产物目录会因为 `app.asar` 被运行中的客户端锁住而换名
 * （release2 / release3 …），写死会让这个脚本在真正需要它的时候指到空目录。
 * 有多个候选时取最新的那个。
 */
function findExe() {
  const explicit = argValue('exe', null);
  if (explicit) return path.resolve(ROOT, explicit);

  const fallback = path.join(DESKTOP, 'release', 'win-unpacked', 'GameShare.exe');
  if (!existsSync(DESKTOP)) return fallback;

  const candidates = readdirSync(DESKTOP)
    .filter((name) => name.startsWith('release'))
    .map((name) => path.join(DESKTOP, name, 'win-unpacked', 'GameShare.exe'))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  return candidates[0] ?? fallback;
}

const exe = findExe();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(host, requestPath, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port: PORT, path: requestPath, timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 170) }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: '超时' });
    });
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
    req.end();
  });
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** 监听目标端口的 PID；没有则返回 null */
function pidOnPort() {
  const out = run('netstat', ['-ano', '-p', 'tcp']);
  for (const line of out.split(/\r?\n/)) {
    const matched = line.match(
      new RegExp(`^\\s*TCP\\s+\\S+:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`),
    );
    if (matched) return matched[1];
  }
  return null;
}

function lanIps() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // 169.254.x.x 是没拿到 DHCP 时的自分配地址，别的机器路由不到
      if (addr.address.startsWith('169.254.')) continue;
      found.push(addr.address);
    }
  }
  return found;
}

function launch() {
  const env = { ...process.env };
  // 本机预设了这个变量，不清掉 Electron 会退化成纯 Node，主进程直接崩
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => (state.output += chunk));
  child.stderr.on('data', (chunk) => (state.output += chunk));
  return { child, state };
}

const problems = [];

async function main() {
  if (!existsSync(exe)) {
    console.error(`找不到产物：${exe}`);
    console.error('先执行 npm run build:exe（或用 --exe 指定路径）。');
    process.exit(2);
  }

  console.log('');
  console.log('内置信令服务器验收（针对打包产物）');
  console.log(`  产物 ${exe}`);
  console.log('');

  const preexisting = pidOnPort();
  if (preexisting) {
    console.log(`  8080 已被 PID ${preexisting} 占用，跳过「端口冲突」检查（不会动它）`);
  }

  /* ---- 1. 单实例：服务器要起来且绑在 0.0.0.0 ---- */
  const first = launch();
  await sleep(10_000);

  if (first.child.exitCode !== null) {
    problems.push(`客户端启动即退出（退出码 ${first.child.exitCode}）`);
  }

  const local = await probe('127.0.0.1', '/health');
  if (local.status !== 200) {
    problems.push(`127.0.0.1/health 未返回 200：${JSON.stringify(local)}`);
  } else {
    console.log(`  ✓ 回环 /health → ${local.body}`);
  }

  for (const ip of lanIps()) {
    const lan = await probe(ip, '/health');
    if (lan.status !== 200) {
      problems.push(
        `${ip}/health 未返回 200：${JSON.stringify(lan)}（多半没绑 0.0.0.0，别的电脑连不上）`,
      );
    } else {
      console.log(`  ✓ 局域网 /health → ${lan.body}`);
    }
  }

  // 双栈监听：IPv6 回环也要通。
  // 绑 '::' 时 IPv4 与 IPv6 都能连，只绑 '0.0.0.0' 则 ::1 直接被拒。
  // 这条不能省：公网 IPv6 是最省事的异地路径（不需要 NAT 打洞），
  // 服务器若只听 IPv4，哪怕对方有 IPv6 也够不到。
  const v6 = await probe('::1', '/health');
  if (v6.status !== 200) {
    problems.push(
      `::1/health 未返回 200：${JSON.stringify(v6)}（只监听了 IPv4，公网 IPv6 那条路不通）`,
    );
  } else {
    console.log('  ✓ IPv6 回环 /health → 双栈监听生效');
  }

  const handshake = await probe('127.0.0.1', '/socket.io/?EIO=4&transport=polling');  if (handshake.status !== 200 || !/^\d+\{/.test(handshake.body ?? '')) {
    problems.push(`socket.io 握手异常：${JSON.stringify(handshake)}`);
  } else {
    console.log('  ✓ socket.io 握手正常');
  }

  // 主进程的启动日志会经 stdout 透出来，作为「服务器确实由我们拉起」的旁证
  if (!/内置信令服务器已启动/.test(first.state.output)) {
    console.log('  · 未捕获到主进程启动日志（打包后 stdout 可能不挂到控制台，不视为失败）');
  }

  /* ---- 2. 端口冲突：第二个实例必须活着 ---- */
  if (!preexisting) {
    const second = launch();
    await sleep(9000);

    if (second.child.exitCode !== null) {
      problems.push(`端口冲突时第二个实例退出了（退出码 ${second.child.exitCode}）`);
    } else {
      console.log('  ✓ 8080 被占用时第二个实例仍存活');
    }
    if (/uncaughtException/.test(second.state.output)) {
      problems.push('第二个实例抛出了未捕获异常 —— 端口冲突没被 catch 住');
    }
    second.child.kill();
    await sleep(1200);
  }

  /* ---- 3. 退出后释放端口 ---- */
  // 只收掉**本脚本启动的**实例。8080 若从一开始就被外部进程占着，那个进程
  // 不是我们的 —— 拿它当「本次启动的」去 taskkill，会把用户正在用的客户端
  // 一起杀掉（2026-09-17 就是这么误杀了 PID 27664）。
  first.child.kill();
  await sleep(2500);

  const lingering = pidOnPort();
  if (lingering && lingering !== preexisting) {
    console.log(`  清理：杀掉本次启动的 PID ${lingering}`);
    run('taskkill', ['/F', '/PID', lingering, '/T']);
    await sleep(1000);
  }

  if (preexisting) {
    console.log(`  · 8080 全程由外部 PID ${preexisting} 提供，跳过「端口释放」检查`);
  } else if (pidOnPort()) {
    problems.push(`客户端退出后 8080 仍被 PID ${pidOnPort()} 占用（端口没释放）`);
  } else {
    console.log('  ✓ 退出后 8080 已释放');
  }

  console.log('');
  if (problems.length > 0) {
    for (const line of problems) console.error(`  ✗ ${line}`);
    console.log('');
    process.exit(1);
  }
  console.log('  ✓ 通过');
  console.log('');
}

main().catch((err) => {
  console.error('[check-embedded-server] 意外失败', err);
  process.exit(1);
});
