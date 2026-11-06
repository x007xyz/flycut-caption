// 前端预览性能（有窗口的 Chrome for Testing）：播放 30 秒，记录 rVFC 回调、跳帧、浏览器丢帧、每帧绘制耗时；再测 20 次拖动进度条。
// 用法：node preview/bench-chrome.mjs
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../shared/chromium-path.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { SCENARIOS } from './scenarios.mjs';
mkdirSync('results', { recursive: true });
const browser = await chromium.launch({ headless: false, executablePath: CHROMIUM, args: ['--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
for (const s of SCENARIOS) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`http://127.0.0.1:4716/?mode=play&${s.query}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  const play = await page.evaluate(() => window.playFor(20, 30));
  const seek = await page.evaluate(() => window.seekTest(20));
  const row = { browser: `chrome ${browser.version()}`, scenario: s.id, ...play, seek, date: new Date().toISOString() };
  console.log(JSON.stringify(row));
  appendFileSync('results/preview-bench.jsonl', `${JSON.stringify(row)}\n`);
  await page.close();
}
await browser.close();
