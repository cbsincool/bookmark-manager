/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.json';
import path from 'path';

/** `YYYY-MM-DD HH:mm:ss`，构建机本地时间 */
function formatLocalTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
  ],
  // 构建时间戳。用户是「导入 dist/ 测」的，而 Chrome 会缓存已加载的代码——
  // 重建后不点扩展卡片的 🔄 就还在跑旧代码。把它显示在设置页里，
  // 一眼就能确认测的是哪次构建，不用再靠猜。
  // 用构建机的本地时间，不是 UTC——省得对着 8 小时时差换算。
  define: {
    __BUILD_TIME__: JSON.stringify(formatLocalTime(new Date())),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // test/specs 下是 WebdriverIO 的 e2e spec（依赖 browser/$ 全局），
    // 由 wdio.conf.js 驱动，不属于 vitest 的单元测试范围。
    exclude: ['**/node_modules/**', '**/dist/**', 'test/specs/**'],
  },
});
