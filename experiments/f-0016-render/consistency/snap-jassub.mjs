// 方案 D 预览端：Chromium 里 JASSUB（libass WASM）叠加到纯色视频上，在取样时间点合成截图。
// WKWebView 版用 out/wkrunner + wkwebview/snap-jassub.js。
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../shared/chromium-path.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const ids = ['static-outline', 'static-shadow', 'static-box', 'anim-landscape'];
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
for (const id of ids) {
  const page = await browser.newPage({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:4716/?mode=play&engine=jassub&variant=${id}&video=/out/green.mp4`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  const shots = await page.evaluate(() => window.snapComposite());
  mkdirSync(`out/snap-jassub-chromium/${id}`, { recursive: true });
  for (const { t, png } of shots) writeFileSync(`out/snap-jassub-chromium/${id}/${t.toFixed(3)}.png`, Buffer.from(png.split(',')[1], 'base64'));
  console.log(id, shots[0].subCanvas);
  await page.close();
}
await browser.close();
