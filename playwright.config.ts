import { defineConfig } from '@playwright/test';

// 端到端测试：需求验收（tests/e2e/features/<F-编号>.spec.ts）。用本机已安装的 Chrome，不下载浏览器。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    // pnpm e2e:evidence 打开录屏，平时不录
    video: process.env.PW_VIDEO ? 'on' : 'off',
  },
  webServer: {
    command: 'pnpm dev:web --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
