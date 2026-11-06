// 在 Chromium（Playwright 自带）里跑同一份绘制代码，导出取样时间点的字幕层 PNG。
// 用法：node consistency/snap-chromium.mjs [--layouts-from skia] [outDir]
// --layouts-from skia：使用 Skia 端算好的排版数据（测「排版一次、两端渲染」）。
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../shared/chromium-path.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from '../shared/variants.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const useSkiaLayouts = args.includes('--layouts-from');
const outDir = args.filter((a) => !a.startsWith('--') && a !== 'skia')[0] ?? `${root}out/snap-chromium${useSkiaLayouts ? '-skialayout' : ''}`;
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:4716/?mode=snap');
await page.waitForFunction(() => window.ready === true);
for (const v of VARIANTS) {
  const layouts = useSkiaLayouts ? readFileSync(`${root}out/layouts-skia/${v.id}.json`, 'utf8') : null;
  const shots = await page.evaluate(([id, l]) => window.snap(id, l), [v.id, layouts]);
  mkdirSync(`${outDir}/${v.id}`, { recursive: true });
  for (const { t, png } of shots) writeFileSync(`${outDir}/${v.id}/${t.toFixed(3)}.png`, Buffer.from(png.split(',')[1], 'base64'));
  if (!useSkiaLayouts) {
    mkdirSync(`${root}out/layouts-chromium`, { recursive: true });
    writeFileSync(`${root}out/layouts-chromium/${v.id}.json`, await page.evaluate((id) => window.layouts(id), v.id));
  }
}
console.log('done', outDir, await browser.version());
await browser.close();
