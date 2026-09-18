#!/usr/bin/env node
/**
 * 打包 Windows 安装包（根 package.json 的 `npm run build:exe` 指向这里）。
 *
 * 存在的唯一理由：electron-builder 用环境变量 ELECTRON_BUILDER_CACHE 决定
 * 去哪里找它自己下载的构建工具（winCodeSign / nsis），而本机完整缓存在
 * E:/electron-builder-cache。默认位置 %LOCALAPPDATA%\electron-builder\Cache
 * 是空的，于是它会联网去 github.com 下载 winCodeSign —— 本机访问 github.com
 * 返回 502，打包就会在 rcedit 阶段莫名其妙地失败：
 *
 *   ⨯ Get ".../winCodeSign-2.6.0.7z": Bad Gateway
 *   ⨯ app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
 *
 * 看着像网络问题，实际是缓存路径问题（缓存命中时根本不联网）。
 *
 * 两条走不通的路，别再试：
 *   1. `.npmrc` 里写 electron_builder_cache —— 无效，builder-util 只读
 *      process.env.ELECTRON_BUILDER_CACHE，没有 npm_config_ 前缀的回退。
 *   2. build.directories.cache —— electron-builder 25.x 的 schema 不认，
 *      直接报 "directories has an unknown property 'cache'"。
 *
 * 所以只剩「在启动子进程之前把变量设好」这一条路。
 *
 * 用法：
 *   npm run build:exe
 *   node scripts/build-exe.mjs -c.directories.output=release-backup   # 产物目录被锁时绕开
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');

/** 本机完整缓存在这里（含 winCodeSign-2.6.0 与 nsis）。可用环境变量覆盖。 */
const CACHE_DIR = process.env.ELECTRON_BUILDER_CACHE ?? 'E:/electron-builder-cache';

const env = { ...process.env, ELECTRON_BUILDER_CACHE: CACHE_DIR };

/** 剩余参数原样转给 electron-builder，例如 -c.directories.output=xxx */
const ebArgs = process.argv.slice(2);

/** 在给定位置中挑第一个存在的文件，都找不到就返回 null */
function firstExisting(candidates) {
  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * 判断某个产物目录是不是已经被锁死。
 *
 * 为什么需要这个：本机每次 electron-builder 打包成功后，都会残留一个持有
 * `<output>\win-unpacked\resources\app.asar` 句柄的子进程（进程本身已退出，
 * tasklist 里查不到，但重命名/删除都报 EPERM/EBUSY，重启才释放）。
 * 结果是固定用 release/ 的话，第二次打包就必然在
 * `remove ...\app.asar` 这一步失败。release2 / release3 就是这么攒出来的。
 *
 * 判据用「能否重命名」而不是「是否存在」：文件存在但没被锁是正常的。
 */
function isOutputLocked(dir) {
  const asar = path.join(dir, 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(asar)) return false;
  const probe = `${asar}.lockprobe`;
  try {
    renameSync(asar, probe);
    renameSync(probe, asar);
    return false;
  } catch {
    return true;
  }
}

/** 默认 release/，被锁就顺延 release-2、release-3 … */
function pickOutputDir() {
  const base = path.join(DESKTOP, 'release');
  if (!isOutputLocked(base)) return 'release';
  for (let i = 2; i <= 20; i += 1) {
    const name = `release-${i}`;
    if (!isOutputLocked(path.join(DESKTOP, name))) return name;
  }
  return null;
}

function run(args, cwd, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败，退出码 ${code}`));
    });
  });
}

/** 把安装包投递到 release/ —— README 里写的交付路径，方便直接双击安装 */
function deliver(fromDir) {
  const deliverDir = path.join(DESKTOP, 'release');
  if (path.resolve(fromDir) === path.resolve(deliverDir)) return;

  const setup = readdirSync(fromDir).find((file) => /^GameShare Setup .*\.exe$/.test(file));
  if (!setup) {
    console.warn('\n⚠ 没找到安装包，跳过投递');
    return;
  }

  try {
    mkdirSync(deliverDir, { recursive: true });
    const target = path.join(deliverDir, setup);
    copyFileSync(path.join(fromDir, setup), target);
    console.log(`\n交付物  ${path.relative(ROOT, target)}`);
  } catch (err) {
    const produced = path.relative(ROOT, path.join(fromDir, setup));
    console.warn(`\n⚠ 投递到 release/ 失败（${err.code}），安装包留在 ${produced}`);
  }
}

async function main() {
  console.log(`构建缓存  ${CACHE_DIR}`);
  if (!existsSync(CACHE_DIR)) {
    console.warn('⚠ 该缓存目录不存在，electron-builder 会尝试联网下载构建工具（本机 github.com 不通）');
  }

  // apps/desktop/package.json 的 build.extraResources 会把 tools/cloudflared.exe 塞进
  // resources/ —— 那是异地访问隧道的唯一实现。缺失时 electron-builder 只会甩一句
  // 看不出所以然的 ENOENT，所以在这里先拦住，顺便说清怎么补。
  const cloudflared = path.join(ROOT, 'tools', 'cloudflared.exe');
  if (!existsSync(cloudflared)) {
    throw new Error(
      '找不到 tools/cloudflared.exe —— 安装包必须内嵌它才能提供异地访问。\n' +
        '  在仓库根执行：\n' +
        '  node scripts/fetch-github-release.mjs ' +
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe ' +
        'tools/cloudflared.exe',
    );
  }
  console.log(
    `异地隧道  内嵌 cloudflared.exe ${(statSync(cloudflared).size / 1048576).toFixed(1)} MB`,
  );

  const buildElectron = path.join(DESKTOP, 'scripts', 'build-electron.mjs');
  const viteBin = firstExisting([
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'),
  ]);
  const ebCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

  if (!existsSync(buildElectron)) throw new Error(`找不到 ${buildElectron}`);
  if (!viteBin) throw new Error('找不到 vite，先在仓库根跑 npm install');
  if (!existsSync(ebCli)) throw new Error('找不到 electron-builder，先在仓库根跑 npm install');

  // 输出目录：显式传了 -c.directories.output 就听参数的，否则自动挑一个没被锁的
  let outputDir = null;
  if (!ebArgs.some((arg) => /directories[.=]output/.test(arg))) {
    const name = pickOutputDir();
    if (!name) throw new Error('release 到 release-20 全被占用，重启机器后再打包');
    outputDir = path.join(DESKTOP, name);
    if (name === 'release') {
      console.log('输出目录  apps/desktop/release');
    } else {
      console.log(`输出目录  apps/desktop/${name}（release 被上次打包的残留句柄锁住，自动顺延）`);
    }
    ebArgs.push(`-c.directories.output=${name}`);
  }

  // 不走 `npm run build -w`：本机 npm 被 shim 拦截，且子进程再套一层 npm 只会
  // 多一个失败点。这两个构建脚本本来就是 node 入口，直接调更直白。
  await run([buildElectron], DESKTOP, '构建主进程（esbuild）');
  await run([viteBin, 'build'], DESKTOP, '构建渲染进程（vite）');
  await run([ebCli, ...ebArgs], DESKTOP, 'electron-builder 打包');

  if (outputDir) deliver(outputDir);

  console.log('\n✓ 打包完成');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
