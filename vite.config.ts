import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 离线纯前端：所有依赖本地打包，不引入任何外部 CDN
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
