#!/usr/bin/env node
/**
 * 一键启动信令服务器（本地开发用），自动打印「另一台设备该填什么地址」。
 *
 * 为什么不用 `npm run dev:signaling`：
 * 那条命令只打印 http://localhost:PORT。真机联调时另一台设备要填的可能是
 * 内网地址或公网 IPv6，让用户自己去 ipconfig 里翻很容易填错，而填错的表现
 * 是「连接中」一直不动——排查成本高，不如启动时直接列出来。
 *
 * 为什么绕开 tsx CLI：
 * 本机项目路径含中文，tsx 的 CLI 包装层处理不了；用 `node --import tsx`
 * 直接加载 TS 入口更稳（smoke 脚本也是这么做的）。
 *
 * 地址清单不在这里拼——由服务端 src/index.ts 统一枚举并输出，
 * 避免本地脚本、独立服务、内嵌服务三处格式各写一份。
 * 这里只补一条它没覆盖的使用前提。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'apps', 'signaling', 'src', 'index.ts');

const env = { ...process.env };
// 本机预设了这个变量，混用 Node / Electron 时会出问题，顺手清掉
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, ['--import', 'tsx', entry], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));

// 等服务器把自己的启动日志打完再补这段，否则提示会夹在日志中间看不清
setTimeout(() => {
  console.log(
    [
      '──────────────────────────────────────────────',
      '  使用前提',
      '',
      '  · 首次启动时 Windows 防火墙会弹窗，必须点「允许访问」',
      '  · 内网地址要求双方连同一个路由器 / 热点',
      '  · 公网 IPv6 地址跨网络可用，但需要路由器放行该端口入站；',
      '    没放行的话外网仍然连不上，验证方法见 docs/REMOTE-TESTING.md',
      '  · 本机没有公网地址时，异地测试需要内网穿透或云服务器',
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}, 1_500);
