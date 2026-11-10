import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 端口固定：desktop 包 dev 流程按 5173 等待/加载
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
