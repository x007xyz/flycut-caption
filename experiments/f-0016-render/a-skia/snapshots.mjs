// 方案 A 后端：用 Skia（@napi-rs/canvas）按取样时间点导出字幕层 PNG，供一致性比较。
// 用法：node a-skia/snapshots.mjs [outDir]
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScene, sampleTimes, FONT_FAMILY } from '../shared/scene.mjs';
import { drawFrame, layoutCue } from '../shared/draw.mjs';
import { VARIANTS } from '../shared/variants.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
GlobalFonts.registerFromPath(`${root}fonts/NotoSansSC-Regular.otf`, FONT_FAMILY);
GlobalFonts.registerFromPath(`${root}fonts/NotoSansSC-Bold.otf`, FONT_FAMILY);
const sticker = await loadImage(`${root}assets/sticker.png`);
const args = process.argv.slice(2);
const fromChromium = args.includes('--layouts-from');
const outDir = args.filter((a) => !a.startsWith('--') && a !== 'chromium')[0] ?? `${root}out/snap-skia${fromChromium ? '-chromiumlayout' : ''}`;
for (const v of VARIANTS) {
  const scene = buildScene(v);
  if (fromChromium) scene.layouts = JSON.parse(readFileSync(`${root}out/layouts-chromium/${v.id}.json`, 'utf8'));
  const c = createCanvas(scene.width, scene.height); const ctx = c.getContext('2d');
  mkdirSync(`${outDir}/${v.id}`, { recursive: true });
  for (const t of sampleTimes(scene)) {
    drawFrame(ctx, scene, t, { sticker });
    writeFileSync(`${outDir}/${v.id}/${t.toFixed(3)}.png`, c.toBuffer('image/png'));
  }
  if (!fromChromium) {
    mkdirSync(`${root}out/layouts-skia`, { recursive: true });
    writeFileSync(`${root}out/layouts-skia/${v.id}.json`, JSON.stringify(scene.cues.map((cue) => layoutCue(ctx, scene, cue))));
  }
}
console.log('done', outDir);
