import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');

/**
 * 打包 Electron 主进程与 preload。
 *
 * 输出 CJS（.cjs 扩展名）：Electron 主进程对 ESM 的支持仍有约束，
 * 且 preload 在 sandbox 关闭时按 CJS 加载最稳。
 * electron 本身作为 external，不打包进产物。
 */
export async function buildElectron({ watch = false } = {}) {
  const context = {
    entryPoints: [
      path.join(desktopRoot, 'electron/main.ts'),
      path.join(desktopRoot, 'electron/preload.ts'),
      // 拆分模式下的小窗单独一个 preload：它跑在 contextIsolation: false 的窗口里
      // （要靠 MessagePort 收 ImageBitmap，contextBridge 传不了 DOM 对象）
      path.join(desktopRoot, 'electron/preload-tile.ts'),
    ],
    outdir: path.join(desktopRoot, 'dist-electron'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    /**
     * koffi 是**原生模块**（预编译的 `.node`），esbuild 打不进 bundle，
     * 必须留在运行时按需 require —— 见 `electron/audio/win32-window-pid.ts` 里
     * 那两条加载路径（开发走仓库根 node_modules，打包后走 resources/audio-ffi）。
     * 它是**可选能力**：拿不到只会让「按应用共享声音」不可用，客户端照常启动。
     */
    external: ['electron', 'koffi'],
    sourcemap: true,
    logLevel: 'info',
  };

  if (!watch) {
    await build(context);
    return null;
  }

  const { context: createContext } = await import('esbuild');
  const ctx = await createContext(context);
  await ctx.watch();
  return ctx;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  buildElectron().catch((err) => {
    console.error('[build-electron] 构建失败', err);
    process.exit(1);
  });
}
