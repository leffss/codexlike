import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';
// highlight.js token 色不再全局导入 github-dark.css：
// 已在 styles.css 以 --hl-* 变量随 data-theme 主题化（ADR 0006）

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
