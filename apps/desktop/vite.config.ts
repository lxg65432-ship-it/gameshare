import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Electron 生产环境用 file:// 加载 dist/index.html，
  // 必须用相对路径，否则资源会解析到盘符根目录。
  base: './',
  // workspace 内这两个包是以 TS 源码形式直接引用的（package.json 的
  // exports 指向 ./src/index.ts）。必须排除预构建，让 Vite 走源码转换管线。
  optimizeDeps: {
    exclude: ['@game-share/protocol', '@game-share/shared'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
