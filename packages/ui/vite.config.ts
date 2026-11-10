import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 相对 base：Electron 生产模式以 file:// 加载 dist/index.html
  base: './',
  // 端口固定：desktop 包 dev 流程按 5173 等待/加载
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
