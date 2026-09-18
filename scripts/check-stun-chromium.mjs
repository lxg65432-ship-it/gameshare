#!/usr/bin/env node
/**
 * 在 Chromium（真正跑视频的那个运行时）里体检候选 STUN 服务器。
 *
 * 为什么单独做这件事：
 * Node 层手写 UDP 探测 STUN 会通，但 Chromium 的 ICE 实现有自己的 DNS
 * 解析器和套接字，两者可能得出相反结论。而候选能力必须用真正跑视频的
 * 那个运行时来验，不能用 Node 的结论替代。
 *
 * 两个容易误判的点：
 *   1. `code=701` 的原文是「STUN host lookup received error」，是 DNS 解析
 *      失败，不是 STUN 服务不可达。同一个服务器完全可能一边报 701
 *      一边成功拿到 srflx —— 判据只能是**有没有 srflx**，不是有没有报错。
 *   2. 列表里放不可达的服务器不只是没用，还会拖慢 ICE 收集：每个失败的
 *      目标都要等一轮超时。国内环境下 Google 的节点属于这一类。
 *
 * 用法：
 *   node scripts/check-stun-chromium.mjs
 *   GAMESHARE_STUN_CANDIDATES="stun.a.com:3478,stun.b.com:3478" node scripts/check-stun-chromium.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const probeScript = path.join(root, 'apps', 'desktop', 'test', 'electron', 'stun-probe.js');

const RESULT_MARKER = '__PROBE_RESULT__';
const TIMEOUT_MS = 120_000;

function resolveElectronPath() {
  try {
    // 在纯 Node 环境下，electron 包导出的是可执行文件路径（字符串）
    const resolved = require('electron');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}

function run() {
  const electronPath = resolveElectronPath();
  if (!electronPath) {
    console.error('找不到 electron 可执行文件，先在仓库根跑 npm install');
    process.exit(1);
  }

  const env = { ...process.env };
  // 本机预设了这个变量，不清掉的话 electron.exe 会退化成纯 Node 进程，
  // 主进程里 require('electron') 拿不到 app/BrowserWindow
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`\nElectron   ${electronPath}`);
  console.log('逐个收集候选（每个 5 秒）…\n');

  return new Promise((resolve) => {
    const child = spawn(electronPath, [probeScript], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, reason: `超时 ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.includes(RESULT_MARKER));
      if (!line) {
        resolve({ ok: false, reason: '没有拿到探测结果', stdout, stderr });
        return;
      }
      try {
        const json = line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length);
        resolve({ ok: true, results: JSON.parse(json) });
      } catch (err) {
        resolve({ ok: false, reason: `结果解析失败：${err.message}`, stdout });
      }
    });
  });
}

function report(results) {
  console.log('── 逐个候主体检 ────────────────────────────────────────\n');

  const usable = [];
  const unusable = [];

  for (const item of results) {
    if (!item.ok) {
      console.log(`  ✗ ${item.label.padEnd(30)} ${item.reason}`);
      unusable.push(item.label);
      continue;
    }

    const types = Object.entries(item.counts)
      .map(([type, count]) => `${type}×${count}`)
      .join(' ');
    const got = item.srflx.length > 0;

    console.log(`  ${got ? '✓' : '✗'} ${item.label.padEnd(30)} ${types || '（无候选）'}`);
    if (got) {
      usable.push(item.label);
      const address = item.srflx[0].match(/udp \d+ \S+ ([\d.]+) (\d+) typ srflx/);
      if (address) console.log(`      公网映射 ${address[1]}:${address[2]}`);
    } else {
      unusable.push(item.label);
    }

    // 701 有 srflx 时只是噪音，单独标注免得被误读成失败
    const errorCodes = [...new Set(item.errors.map((e) => e.code))];
    if (errorCodes.length > 0) {
      const hasSrflx = item.srflx.length > 0;
      console.log(
        `      报错 code=${errorCodes.join(',')}${hasSrflx ? '（不影响：已拿到 srflx）' : '（未能拿到 srflx）'}`,
      );
    }
    console.log('');
  }

  console.log('── 结论 ────────────────────────────────────────────────\n');
  console.log(`  可用    ${usable.join('、') || '无'}`);
  console.log(`  不可用  ${unusable.join('、') || '无'}`);

  if (usable.length === 0) {
    console.log('\n  ✗ 没有任何可用的 STUN —— 拿不到 srflx 候选。');
    console.log('    异地 P2P 只能靠 TURN 中继（M8），打洞这条路走不通。');
  } else {
    console.log(`\n  ✓ 有 ${usable.length} 个可用。建议默认列表只保留这些，`);
    console.log('    不可达的节点会拖慢 ICE 收集（每个都要等一轮超时）。');
  }

  const listLiteral = usable.map((s) => `  'stun:${s}',`).join('\n');
  if (usable.length > 0) {
    console.log('\n  可直接粘进 packages/shared/src/constants.ts：\n');
    console.log('export const DEFAULT_STUN_SERVERS: readonly string[] = [');
    console.log(listLiteral);
    console.log('];');
  }
  console.log('');
}

run()
  .then((outcome) => {
    if (!outcome.ok) {
      console.error(`\n探测未完成：${outcome.reason}`);
      if (outcome.stderr?.trim()) console.error(outcome.stderr.trim());
      process.exit(1);
    }
    report(outcome.results);
  })
  .catch((err) => {
    console.error('脚本出错：', err);
    process.exit(1);
  });
