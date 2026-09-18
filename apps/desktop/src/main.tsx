import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import FloatTile from './FloatTile';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器');
}

/**
 * 拆分模式下的小窗和主窗口加载的是**同一个** `index.html`，
 * 靠 URL 上的 `floatTile` 参数分流（主进程 loadFile 的 query 带过来的）。
 *
 * 为什么用 URL 当判据、而不是「问主进程我是谁」：这条判据不依赖任何外部状态，
 * 页面重载、热更新、多开客户端都不会认错 —— 而认错的后果是把小窗渲染成一整个
 * 客户端界面，且它会跟着去连信令。
 */
const isFloatTile = new URLSearchParams(window.location.search).has('floatTile');

createRoot(container).render(
  <StrictMode>{isFloatTile ? <FloatTile /> : <App />}</StrictMode>,
);
