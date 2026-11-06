// 拆分方案 B 的耗时：页面内只绘制 / 绘制 + getImageData / 再加 base64，不经过传输。
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../shared/chromium-path.mjs';
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4716/?mode=export');
await page.waitForFunction(() => window.ready === true);
const r = await page.evaluate(async () => {
  const { buildScene } = await import('/shared/scene.mjs');
  const { drawFrame, frameKey, subtitleBand } = await import('/shared/draw.mjs');
  const scene = buildScene({ style: 'gradient', animation: 'pop', aspect: 'landscape', duration: 60, fps: 25 });
  const band = subtitleBand(scene);
  const img = new Image(); img.src = '/assets/sticker.png'; await img.decode();
  const out = {};
  for (const [name, wrf] of [['willReadFrequently', true], ['gpu', false]]) {
    const ctx = new OffscreenCanvas(scene.width, band.height).getContext('2d', { willReadFrequently: wrf });
    let td = 0, tr = 0, n = 0;
    for (let f = 0; f < 1500; f++) {
      const t = f / 25; let a = performance.now();
      drawFrame(ctx, scene, t, { sticker: img, layer: band }); let b = performance.now();
      ctx.getImageData(0, 0, scene.width, band.height); let c = performance.now();
      td += b - a; tr += c - b; n++;
    }
    out[name] = { drawMsPerFrame: +(td / n).toFixed(2), readbackMsPerFrame: +(tr / n).toFixed(2) };
  }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
