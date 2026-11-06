// 方案 E 可行性：Chromium 里用同一个 dotLottie WASM 渲染同一个 Lottie 的相同帧，输出 PNG 与 Node 端比较。
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../shared/chromium-path.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4716/?mode=snap');
await page.waitForFunction(() => window.ready === true);
const shots = await page.evaluate(async () => {
  const { DotLottie } = await import('/harness/vendor/dotlottie/index.js');
  DotLottie.setWasmUrl('/node_modules/@lottiefiles/dotlottie-web/dist/dotlottie-player.wasm');
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const data = await (await fetch('/e-lottie/badge.json')).text();
  const anim = new DotLottie({ canvas, data, autoplay: false, renderConfig: { devicePixelRatio: 1, autoResize: false } });
  await new Promise((r, j) => { anim.addEventListener('load', r); anim.addEventListener('loadError', (e) => j(String(e.error))); });
  const out = [];
  for (const f of [3, 6, 9, 20]) { anim.setFrame(f); await new Promise((r) => setTimeout(r, 30)); out.push({ f, png: canvas.toDataURL('image/png'), size: [canvas.width, canvas.height] }); }
  return out;
});
mkdirSync('out/lottie-chromium', { recursive: true });
for (const s of shots) writeFileSync(`out/lottie-chromium/${s.f}.png`, Buffer.from(s.png.split(',')[1], 'base64'));
console.log('ok', shots.map((s) => s.size.join('x')).join(' '));
await browser.close();
