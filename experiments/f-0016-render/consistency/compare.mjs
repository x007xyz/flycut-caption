// 比较两组字幕层 PNG（同名文件一一对应）以及两端的排版数据。
// 用法：node consistency/compare.mjs <dirA> <dirB> [layoutsA layoutsB] [--json out.json]
// 指标（Q-C 阈值：包围盒偏移 ≤ 2 px、换行位置完全相同；逐像素差异只记录）：
//   bboxOffset   不透明像素包围盒四条边的最大偏移（px）
//   diffRatio    两图任一方不透明的像素里，颜色差（按 alpha 预乘后任一通道 > 32）超过阈值的比例
//   severeRatio  同上，差值 > 96 的比例（明显可见的差异；抗锯齿边缘通常在 32–96 之间）
//   mae          上述像素的平均最大通道差（0–255）
//   lineBreaks   两端排版的换行位置是否完全相同（逐条字幕比较每行的字词下标）
//   maxWordDx    同一字词在两端排版里的 x 位置最大差（px）
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
// --bg RRGGBB：比较的是合成到纯色背景上的不透明帧，把「与背景色差 > 24」的像素当作字幕像素
const bgHex = args.includes('--bg') ? args[args.indexOf('--bg') + 1] : null;
const bg = bgHex ? [0, 2, 4].map((i) => parseInt(bgHex.slice(i, i + 2), 16)) : null;
const [dirA, dirB, layA, layB] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json' && args[i - 1] !== '--bg');

async function pixels(file) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  if (bg) for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 24 ? 255 : 0;
  return { w: img.width, h: img.height, d };
}
function bbox({ w, h, d }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (d[(y * w + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
function diff(a, b) {
  let union = 0, bad = 0, severe = 0, sum = 0;
  for (let i = 0; i < a.d.length; i += 4) {
    const aa = a.d[i + 3], ba = b.d[i + 3];
    if (aa <= 16 && ba <= 16) continue;
    union += 1;
    let m = Math.abs(aa - ba);
    for (let k = 0; k < 3; k += 1) m = Math.max(m, Math.abs((a.d[i + k] * aa) / 255 - (b.d[i + k] * ba) / 255));
    if (m > 32) bad += 1;
    if (m > 96) severe += 1;
    sum += m;
  }
  return union ? { r: bad / union, s: severe / union, mae: sum / union } : { r: 0, s: 0, mae: 0 };
}

const results = [];
for (const variant of readdirSync(dirA).sort()) {
  const row = { variant, frames: 0, maxBboxOffset: 0, meanDiffRatio: 0, maxDiffRatio: 0, severeRatio: 0, mae: 0, missing: 0 };
  const files = readdirSync(`${dirA}/${variant}`).filter((f) => f.endsWith('.png'));
  for (const f of files) {
    if (!existsSync(`${dirB}/${variant}/${f}`)) { row.missing += 1; continue; }
    const a = await pixels(`${dirA}/${variant}/${f}`);
    const b = await pixels(`${dirB}/${variant}/${f}`);
    const ba = bbox(a), bb = bbox(b);
    const off = ba && bb ? Math.max(...ba.map((v, i) => Math.abs(v - bb[i]))) : ba || bb ? Infinity : 0;
    const dr = diff(a, b);
    row.frames += 1;
    row.maxBboxOffset = Math.max(row.maxBboxOffset, off);
    row.meanDiffRatio += dr.r;
    row.maxDiffRatio = Math.max(row.maxDiffRatio, dr.r);
    row.severeRatio = Math.max(row.severeRatio, dr.s);
    row.mae += dr.mae;
  }
  row.meanDiffRatio = +(row.meanDiffRatio / Math.max(1, row.frames)).toFixed(4);
  row.maxDiffRatio = +row.maxDiffRatio.toFixed(4);
  row.severeRatio = +row.severeRatio.toFixed(4);
  row.mae = +(row.mae / Math.max(1, row.frames)).toFixed(2);
  if (layA && layB) {
    const la = JSON.parse(readFileSync(`${layA}/${variant}.json`, 'utf8'));
    const lb = JSON.parse(readFileSync(`${layB}/${variant}.json`, 'utf8'));
    let breakDiff = 0, maxWordDx = 0, maxLineWidthDx = 0;
    la.forEach((cueA, ci) => {
      const cueB = lb[ci];
      const sigA = cueA.lines.map((l) => l.words.map((w) => w.i).join(',')).join('|');
      const sigB = cueB.lines.map((l) => l.words.map((w) => w.i).join(',')).join('|');
      if (sigA !== sigB) { breakDiff += 1; return; }
      cueA.lines.forEach((l, li) => {
        maxLineWidthDx = Math.max(maxLineWidthDx, Math.abs(l.width - cueB.lines[li].width));
        l.words.forEach((w, wi) => { maxWordDx = Math.max(maxWordDx, Math.abs(w.x - cueB.lines[li].words[wi].x)); });
      });
    });
    Object.assign(row, { cues: la.length, lineBreakDiffCues: breakDiff, maxWordDx: +maxWordDx.toFixed(2), maxLineWidthDx: +maxLineWidthDx.toFixed(2) });
  }
  row.pass = row.maxBboxOffset <= 2 && !row.missing && (row.lineBreakDiffCues ?? 0) === 0;
  results.push(row);
}
console.table(results);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
