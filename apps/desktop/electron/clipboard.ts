import { clipboard, ipcMain } from 'electron';

/**
 * 剪贴板（复制房间码 / 复制邀请信息）。
 *
 * 单独成模块有两个理由：
 *   1. 和 `window-mode.ts` / `float-tiles.ts` 一致 —— 主进程的 IPC 注册各自成文件；
 *   2. **能被校验脚本 require 到编译产物**（`scripts/check-float-tiles.cjs` 的 `prepare()`
 *      会把它单独打成 `.cache/work/clipboard.cjs`），于是那条断言跑的是
 *      「真 preload → 真 handler → 真系统剪贴板」的完整链路。把 handler 写在 main.ts
 *      里的话，校验脚本只能自己抄一份 —— 那等于自己给自己发合格证。
 *
 * 为什么不让渲染层直接用 `navigator.clipboard`，实测见 `scripts/_probe-clipboard.cjs`：
 *
 * | 场景 | 结果 |
 * | --- | --- |
 * | 权限放行 + 窗口聚焦 | 写入成功，系统剪贴板 50ms 后读回一致 |
 * | 用 main.ts 那个权限白名单 | `NotAllowedError: Write permission denied` |
 * | 权限放行 + `setFocusable(false)`（浮窗） | `NotAllowedError: Document is not focused` |
 * | 主进程 `clipboard.writeText` | 写读一致，不看权限、不看焦点 |
 *
 * 第 2 行就是「复制 / 复制邀请两个按钮完全没反应」的原因（调用方把它 catch 成了一行
 * 日志）。**光放开白名单也不够** —— 第 3 行说明浮窗模式照样失败，而浮窗恰恰是最想
 * 复制房间码发给朋友的场景。所以主进程这条路是唯一入口，权限白名单保持不动。
 */
export function registerClipboardHandlers(): void {
  ipcMain.handle('clipboard:write-text', (_event, text: unknown): boolean => {
    // 只收非空字符串：`clipboard.writeText(undefined)` 会把 "undefined" 四个字塞进剪贴板，
    // 用户粘出来是垃圾还找不到原因
    if (typeof text !== 'string' || text.length === 0) return false;
    clipboard.writeText(text);
    return true;
  });
}
