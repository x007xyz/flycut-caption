// 方案 D：FFmpeg libass 把同一份 ASS 烧到纯色视频上，在取样时间点抽帧（与 JASSUB 预览比较）。
// 用法：node consistency/snap-ass.mjs [--no-fontsdir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScene, sampleTimes } from '../shared/scene.mjs';
import { sceneToAss } from '../shared/to-ass.mjs';
import { VARIANTS } from '../shared/variants.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const FF = fileURLToPath(new URL('../../../src-tauri/binaries/ffmpeg', import.meta.url));
const noFontsdir = process.argv.includes('--no-fontsdir');
const outDir = `${root}out/snap-ffass${noFontsdir ? '-nofontsdir' : ''}`;
for (const v of VARIANTS.filter((x) => !x.manualShadow)) {
  const scene = buildScene(v);
  if (scene.width !== 1920) continue; // 只用横屏素材
  const ass = `${root}out/${v.id}.ass`;
  writeFileSync(ass, sceneToAss(scene));
  mkdirSync(`${outDir}/${v.id}`, { recursive: true });
  for (const t of sampleTimes(scene)) {
    const tq = Math.floor(t * 25) / 25 + 0.004; // 与 JASSUB 端相同的帧对齐
    execFileSync(FF, ['-v', 'error', '-copyts', '-ss', String(tq), '-i', `${root}out/green.mp4`, '-frames:v', '1', '-vf', `ass=${ass}${noFontsdir ? '' : `:fontsdir=${root}fonts`}`, '-y', `${outDir}/${v.id}/${t.toFixed(3)}.png`]);
  }
}
console.log('done', outDir);
