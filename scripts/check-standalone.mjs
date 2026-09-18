#!/usr/bin/env node
/**
 * 验证「独立部署产物」是否真的独立，以及信令服务是否真的双栈监听。
 *
 * 为什么必须拷到项目外：
 * Node 的模块解析会从文件所在目录逐级向上找 node_modules。只要产物还在
 * 仓库里，它引用的外部模块总能被根 node_modules 兜住——测出来的「能用」
 * 是假的。拷到一个上级目录也没有 node_modules 的地方，才是真实场景。
 *
 * 检查四项：
 *   1. 无 node_modules 环境下能启动
 *   2. IPv4（127.0.0.1）能连
 *   3. IPv6（::1）能连  ← 这是本次改造的核心，绑 0.0.0.0 时这一项必挂
 *   4. 启动日志里列出了可达地址清单
 *
 * 用法：node scripts/check-standalone.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const standaloneDir = path.join(root, 'apps', 'signaling', 'dist', 'standalone');

/** 刻意放在项目外的盘根目录下：这一层向上不存在任何 node_modules */
const sandboxDir = path.join(path.parse(root).root, 'gameshare-standalone-sandbox');
const PORT = 18080;

/** 产物名带扩展名，从目录里找，避免改了输出格式还要同步改本脚本 */
async function findBundle() {
  let entries = [];
  try {
    entries = await fs.readdir(standaloneDir);
  } catch {
    return null;
  }
  const order = ['.cjs', '.mjs', '.js'];
  const file = entries
    .filter((name) => /^signaling-server\.(cjs|mjs|js)$/.test(name))
    .sort((a, b) => order.indexOf(path.extname(a)) - order.indexOf(path.extname(b)))[0];
  return file ? path.join(standaloneDir, file) : null;
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function httpGet(host, port, urlPath, { family } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: urlPath, method: 'GET', timeout: 4000, ...(family ? { family } : {}) },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: '超时' });
    });
    req.on('error', (err) => resolve({ ok: false, detail: `${err.code ?? ''} ${err.message}` }));
    req.end();
  });
}

async function waitForHttp(attempts = 25) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await httpGet('127.0.0.1', PORT, '/health');
    if (res.ok) return res;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, detail: '启动后一直没响应' };
}

async function main() {
  const bundlePath = await findBundle();

  console.log(`\n产物   ${bundlePath ?? '（未找到）'}`);
  console.log(`沙箱   ${sandboxDir}\n`);

  if (!bundlePath) {
    console.error('✗ 找不独立产物，先跑 npm run bundle:signaling');
    process.exit(1);
  }

  await fs.rm(sandboxDir, { recursive: true, force: true });
  await fs.mkdir(sandboxDir, { recursive: true });
  const target = path.join(sandboxDir, path.basename(bundlePath));
  await fs.copyFile(bundlePath, target);

  const entries = await fs.readdir(sandboxDir);
  record('沙箱内无 node_modules', !entries.includes('node_modules'), `目录内容：${entries.join('、')}`);

  const env = { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(process.execPath, [target], { cwd: sandboxDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });

  let exitedEarly = null;
  child.on('exit', (code) => {
    if (exitedEarly === null) exitedEarly = code;
  });

  try {
    const health = await waitForHttp();

    if (exitedEarly !== null) {
      record('无依赖启动', false, `进程提前退出 code=${exitedEarly}`);
      console.log(stderr.trim().split('\n').slice(0, 6).join('\n'));
      return;
    }

    record('无依赖启动', health.ok, health.ok ? '进程存活并响应 /health' : health.detail);

    if (health.ok) {
      let payload = null;
      try {
        payload = JSON.parse(health.body);
      } catch {
        /* 保持 null */
      }
      record('健康检查返回协议信息', payload?.ok === true, payload ? `service=${payload.service} v=${payload.protocolVersion}` : '无法解析响应体');

      const v6 = await httpGet('::1', PORT, '/health', { family: 6 });
      record('IPv6 回环（::1）可达', v6.ok, v6.ok ? `HTTP ${v6.status}` : v6.detail);

      record('启动日志含地址清单', stdout.includes('在另一台设备'), stdout.split('\n').filter((l) => l.trim()).length + ' 行输出');
    } else {
      record('IPv4 回环可达', false, health.detail);
      if (stderr.trim()) console.log('  stderr:', stderr.trim().split('\n').slice(0, 6).join('\n'));
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    // 沙箱留着会误导后续判断，但删掉的话排查失败时就没现场了
    if (results.every((r) => r.ok)) {
      await fs.rm(sandboxDir, { recursive: true, force: true });
      console.log('\n  沙箱已清理');
    } else {
      console.log(`\n  沙箱保留供排查：${sandboxDir}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项未通过`}（${results.length} 项）\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('检查脚本出错：', err);
  process.exit(1);
});
