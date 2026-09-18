import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildElectron } from './build-electron.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

async function waitForDevServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(DEV_SERVER_URL, { method: 'GET' });
      if (res.status < 500) return;
    } catch {
      // dev server 尚未监听，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 Vite dev server 超时：${DEV_SERVER_URL}`);
}

await waitForDevServer();
await buildElectron();

const electronPath = require('electron');

// 某些 CI / 容器 / 终端环境会预设 ELECTRON_RUN_AS_NODE=1。
// 该变量会让 Electron 退化成纯 Node 进程，主进程里的 require('electron')
// 只返回可执行文件路径字符串，症状是启动即报：
//   TypeError: Cannot read properties of undefined (reading 'whenReady')
// 这里显式剔除，保证 Electron 以正常 GUI 模式启动。
const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL };
delete electronEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: desktopRoot,
  stdio: 'inherit',
  env: electronEnv,
});

const shutdown = () => {
  if (!child.killed) child.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
