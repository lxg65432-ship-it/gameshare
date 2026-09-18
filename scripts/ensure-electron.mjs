#!/usr/bin/env node
/**
 * 保证 `npm install` 之后 Electron 二进制一定是齐的，且落在 E 盘缓存里。
 *
 * 为什么需要这个文件（**Electron 43 升级带来的回归，不是可选项**）：
 *
 * Electron 42 起，npm 包**去掉了 postinstall** —— 二进制改成「第一次
 * `require('electron')` 时惰性下载」。这条上游改动同时踩掉了本机两件事：
 *
 *   1. **`.npmrc` 的 `electron_mirror` 只在 npm 生命周期脚本里生效**
 *      （npm 把它注入成 `npm_config_electron_mirror`）。而惰性下载发生在 npm 之外 ——
 *      `node scripts/run-electron.cjs …`、任何直接 `require('electron')` 的场合都拿不到它，
 *      于是回落到默认的 github.com，**本机必然 502**，报错只有一句
 *      `TypeError: fetch failed` + `Electron failed to install correctly`。
 *   2. **`electron_config_cache` 这条 E 盘重定向一起失效**：electron 的 install.js 读的是
 *      **小写无前缀**的 `process.env.electron_config_cache`，而 npm 注入的是
 *      `npm_config_electron_config_cache`。缓存于是回落到 C 盘的
 *      `%LOCALAPPDATA%\electron\Cache` —— 与 README「Electron 二进制已重定向到 E 盘、
 *      避免 C 盘被百余兆撑满」的约定相反。
 *
 * 这里把两件事一起补上：显式调用 electron 自带的 install.js，并按 `.npmrc` 的意图
 * 把缓存目录与镜像塞进环境变量。装完即用，`dev.bat` / `build-exe.bat` 不必再等一次下载。
 *
 * 幂等：install.js 自己会比对 `dist/version` 与包版本，已就绪时直接退出（毫秒级）。
 * 由根 `package.json` 的 `postinstall` 触发；也可以手动跑：
 *
 *   node scripts/ensure-electron.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);

/**
 * 取一个配置项：优先环境变量（npm 生命周期里是 `npm_config_<key>`），
 * 其次直接读仓库根的 `.npmrc`。
 *
 * 为什么不只依赖环境变量：这个脚本可能被手动执行（修安装问题时），
 * 那种场合没有任何 `npm_config_*`，只认环境变量就会静默退化成「直连 GitHub」。
 */
function readConfig(key) {
  const fromEnv = process.env[`npm_config_${key}`] ?? process.env[key];
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(path.join(ROOT, '.npmrc'), 'utf8')
      .split(/\r?\n/)
      .find((raw) => raw.trim().startsWith(`${key}=`));
    const value = line?.slice(line.indexOf('=') + 1).trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

let electronDir;
try {
  // 用 require.resolve 而不是 require：resolve 只解析路径、不执行模块，
  // 不会反过来触发一次惰性下载（那正是这个脚本要避免的行为）。
  electronDir = path.dirname(require.resolve('electron/package.json'));
} catch {
  console.log('[ensure-electron] 未安装 electron，跳过');
  process.exit(0);
}

const installer = path.join(electronDir, 'install.js');
if (!existsSync(installer)) {
  console.log('[ensure-electron] 这个 electron 版本没有 install.js，跳过');
  process.exit(0);
}

const version = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const exePath = path.join(electronDir, 'dist', exeName);
const installedVersion = (() => {
  try {
    return readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8').trim();
  } catch {
    return null;
  }
})();

if (installedVersion === version && existsSync(exePath)) {
  console.log(`[ensure-electron] Electron ${version} 二进制已就绪`);
  process.exit(0);
}

const cacheDir = readConfig('electron_config_cache');
const mirror = readConfig('electron_mirror');

const env = { ...process.env };
// install.js 读的就是这个小写名字，别改成 npm_config_ 形式（它不认）
if (cacheDir) env.electron_config_cache = cacheDir;
if (mirror) {
  env.ELECTRON_MIRROR = mirror;
  env.npm_config_electron_mirror = mirror;
}
// 本机预设了 ELECTRON_RUN_AS_NODE=1，虽然对下载没有影响，但保持和其他启动器一致
delete env.ELECTRON_RUN_AS_NODE;

console.log(
  `[ensure-electron] 下载 Electron ${version} 二进制` +
    `${mirror ? `（镜像 ${mirror}）` : ''}${cacheDir ? `（缓存 ${cacheDir}）` : ''} …`,
);

const result = spawnSync(process.execPath, [installer], { cwd: ROOT, env, stdio: 'inherit' });

if (result.status !== 0 || !existsSync(exePath)) {
  console.error(
    `\n✗ Electron ${version} 二进制没装上。dev.bat 与打包都要用它，先解决这一条：\n` +
      '    node scripts/ensure-electron.mjs\n' +
      '  再失败就查网络到不到镜像（.npmrc 里的 electron_mirror）。',
  );
  process.exit(1);
}

console.log(`[ensure-electron] ✓ Electron ${version} 二进制就绪`);
