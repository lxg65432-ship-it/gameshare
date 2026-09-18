/**
 * 在 Electron 主进程里跑一个脚本。
 *
 * 本机预设了 ELECTRON_RUN_AS_NODE=1，直接启动 Electron 会退化成纯 Node 进程
 * （require('electron') 只拿到可执行文件路径字符串），所以这里 spawn 之前必须删掉它。
 *
 * 用法：node scripts/run-electron.cjs scripts/diag-window-enum.cjs
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const target = process.argv[2];
if (!target) {
  console.error('用法：node scripts/run-electron.cjs <脚本路径> [参数...]');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [path.resolve(target), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env,
});

process.exit(result.status === null ? 1 : result.status);
