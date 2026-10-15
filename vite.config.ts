/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.json';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
  ],
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
