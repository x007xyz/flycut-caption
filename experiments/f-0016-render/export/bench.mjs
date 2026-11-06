// 导出性能基准：同一段视频、同一个编码器（与 Host 导出一致：libx264 veryfast crf 23 + aac），比较字幕层的几种来源。
// 用法：node export/bench.mjs <engine> <durationSec> [variant] [--full-frame]
//   engine: none（不加字幕，编码基线）| ass（方案 D，libass 硬烧）| skia（方案 A）| chromium（方案 B，后端驱动无头浏览器）
// 输出：一行 JSON（耗时、相对实时倍数、峰值内存、CPU 时间），并追加到 results/export-bench.jsonl
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { buildScene } from '../shared/scene.mjs';
import { drawFrame, frameKey, subtitleBand, layoutCue } from '../shared/draw.mjs';
import { VARIANTS } from '../shared/variants.mjs';
import { sceneToAss } from '../shared/to-ass.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FFMPEG = fileURLToPath(new URL('../../../src-tauri/binaries/ffmpeg', import.meta.url));
const VIDEO = fileURLToPath(new URL('../../../tests/media/external/x-isnail-2115609565043597572.mp4', import.meta.url)); // 1920x1080 25fps 46 分钟
const flagValues = new Set(['--threads', '--enc'].map((k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)).filter(Boolean));
const [engine, durArg, variantId = 'anim-landscape'] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !flagValues.has(a));
const fullFrame = process.argv.includes('--full-frame');
// 优化实验开关（F-0016 第二轮）：
//   --threads N   FFmpeg 滤镜线程数（-filter_threads / -filter_complex_threads）
//   --tight       按实际排版收紧字幕条带高度
//   --premul      直接传 Skia 的预乘 alpha 缓冲区（canvas.data()），overlay alpha=premultiplied
//   --enc vt      用 VideoToolbox 硬件编码（-q:v 60）代替 libx264 veryfast
//   --yuv         overlay 强制 format=yuv420（默认 auto 遇到 RGBA 输入会把整个主画面转成 RGBA 再转回）
//   --sink        只把字幕层送进 FFmpeg 解码后丢弃，不读视频、不叠加、不编码（测管道本身）
const argVal = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const opt = { threads: argVal('--threads'), tight: process.argv.includes('--tight'), premul: process.argv.includes('--premul'), enc: argVal('--enc') ?? 'x264', sink: process.argv.includes('--sink'), yuv: process.argv.includes('--yuv') };
const globalArgs = opt.threads ? ['-filter_threads', opt.threads, '-filter_complex_threads', opt.threads] : [];
const duration = Number(durArg);
const v = VARIANTS.find((x) => x.id === variantId);
const scene = buildScene({ ...v, duration, fps: 25 });
mkdirSync(`${root}out/export`, { recursive: true });
const outFile = `${root}out/export/${engine}-${variantId}-${duration}${fullFrame ? '-full' : ''}.mp4`;

// 视频只有 46 分钟，60 分钟测试循环输入
const input = ['-stream_loop', duration > 2700 ? '1' : '0', '-t', String(duration), '-i', VIDEO];
const encode = [...(process.argv.includes('--enc') && process.argv[process.argv.indexOf('--enc') + 1] === 'vt' ? ['-c:v', 'h264_videotoolbox', '-q:v', '60'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']), '-c:a', 'aac', '-shortest', '-y', outFile];

let peakNodeRss = 0;
const rssTimer = setInterval(() => { peakNodeRss = Math.max(peakNodeRss, process.memoryUsage().rss); }, 500);

function runFfmpeg(args, feed) {
  return new Promise((resolve, reject) => {
    // /usr/bin/time -l 记录 ffmpeg 的峰值内存和 CPU 时间
    const child = spawn('/usr/bin/time', ['-l', FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostats', ...globalArgs, ...args], { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}\n${err.slice(-2000)}`));
      const rss = Number(err.match(/(\d+)\s+maximum resident set size/)?.[1] ?? 0);
      const user = Number(err.match(/([\d.]+) user/)?.[1] ?? 0);
      const sys = Number(err.match(/([\d.]+) sys/)?.[1] ?? 0);
      resolve({ ffmpegPeakMB: +(rss / 1048576).toFixed(0), ffmpegCpuSec: +(user + sys).toFixed(1) });
    });
    if (feed) feed(child.stdin).catch(reject);
  });
}

// 把字幕层逐帧写进 ffmpeg 的 stdin（rawvideo RGBA）；重复帧直接重写上一帧的缓冲区
async function pump(stdin, nextFrame, frames) {
  for (let f = 0; f < frames; f += 1) {
    const buf = await nextFrame(f);
    if (!stdin.write(buf)) await new Promise((r) => stdin.once('drain', r));
  }
  stdin.end();
}

const t0 = performance.now();
const cpu0 = process.cpuUsage();
const frames = Math.round(duration * scene.fps);
let band = fullFrame ? { y: 0, height: scene.height } : subtitleBand(scene);
const overlayArgs = (w, h) => (opt.sink
  ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(scene.fps), '-i', 'pipe:0', '-f', 'null', '-']
  : [...input, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(scene.fps), '-i', 'pipe:0',
    '-filter_complex', `[0:v][1:v]overlay=0:${band.y}:format=${opt.yuv ? 'yuv420' : 'auto'}${opt.premul ? ':alpha=premultiplied' : ''}[v]`, '-map', '[v]', '-map', '0:a?', ...encode]);

// 按实际排版算出字幕条带：所有字幕条里最多的行数 × 行高，加上动画放大、贴图和描边阴影的余量
function tightBand(ctx) {
  let maxLines = 1;
  let fontSize = 0;
  let lineHeight = 0;
  for (const cue of scene.cues) {
    const l = layoutCue(ctx, scene, cue);
    maxLines = Math.max(maxLines, l.lines.length);
    fontSize = l.fontSize; lineHeight = l.lineHeight;
  }
  const bottom = scene.height * (1 - scene.bottomRatio);
  const stickerRoom = scene.animation?.sticker ? scene.height * scene.animation.sticker.size * 0.65 : 0;
  const top = bottom - maxLines * lineHeight - Math.max(stickerRoom, fontSize * 0.5);
  const y = Math.max(0, Math.floor(top / 2) * 2);
  const end = Math.min(scene.height, Math.ceil((bottom + fontSize * 0.5) / 2) * 2);
  return { y, height: end - y };
}
let stats = { drawnFrames: 0 };
let ff;

if (engine === 'none') {
  ff = await runFfmpeg([...input, ...encode]);
} else if (engine === 'ass') {
  const assPath = `${root}out/export/${variantId}-${duration}.ass`;
  writeFileSync(assPath, sceneToAss(scene));
  const fontsdir = process.argv.includes('--no-fontsdir') ? '' : `:fontsdir=${root}fonts`;
  ff = await runFfmpeg([...input, '-vf', `ass=${assPath}${fontsdir}`, ...encode]);
} else if (engine === 'skia') {
  const { createCanvas, GlobalFonts, loadImage } = await import('@napi-rs/canvas');
  GlobalFonts.registerFromPath(`${root}fonts/NotoSansSC-Regular.otf`, scene.fontFamily);
  GlobalFonts.registerFromPath(`${root}fonts/NotoSansSC-Bold.otf`, scene.fontFamily);
  const sticker = await loadImage(`${root}assets/sticker.png`);
  if (opt.tight) band = tightBand(createCanvas(8, 8).getContext('2d'));
  stats.band = band;
  const canvas = createCanvas(scene.width, band.height);
  const ctx = canvas.getContext('2d');
  let lastKey = null;
  let last = null;
  ff = await runFfmpeg(overlayArgs(scene.width, band.height), (stdin) => pump(stdin, (f) => {
    const t = f / scene.fps;
    const key = frameKey(scene, t);
    if (key !== lastKey) {
      lastKey = key;
      drawFrame(ctx, scene, t, { sticker, layer: band });
      // getImageData 返回非预乘 RGBA，与 ffmpeg rawvideo rgba 一致
      last = opt.premul ? canvas.data() : Buffer.from(ctx.getImageData(0, 0, scene.width, band.height).data.buffer);
      stats.drawnFrames += 1;
    }
    return last;
  }, frames));
} else if (engine === 'chromium') {
  const { chromium } = await import('playwright-core');
  const { CHROMIUM } = await import('../shared/chromium-path.mjs');
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4716/?mode=export');
  await page.waitForFunction(() => window.ready === true);
  const info = await page.evaluate(([id, d, fps]) => window.exportInit(id, d, fps), [variantId, duration, scene.fps]);
  const BATCH = 50;
  let cache = [];
  let last = null;
  ff = await runFfmpeg(overlayArgs(info.width, info.height), (stdin) => pump(stdin, async (f) => {
    if (f % BATCH === 0) cache = await page.evaluate(([s, n]) => window.exportBatch(s, n), [f, Math.min(BATCH, frames - f)]);
    const b64 = cache[f % BATCH];
    if (b64) { last = Buffer.from(b64, 'base64'); stats.drawnFrames += 1; }
    return last;
  }, frames));
  await browser.close();
} else if (engine === 'chromium-post') {
  // 方案 B 优化版：页面自己循环，HTTP POST 二进制帧到本进程，本进程按帧号补齐重复帧后写给 ffmpeg
  const { createServer } = await import('node:http');
  const { chromium } = await import('playwright-core');
  const { CHROMIUM } = await import('../shared/chromium-path.mjs');
  const bandInfo = subtitleBand(scene);
  let stdin;
  let written = 0;
  let last = null;
  const writeBuf = async (buf) => { if (!stdin.write(buf)) await new Promise((r) => stdin.once('drain', r)); };
  let finish;
  const done = new Promise((r) => { finish = r; });
  const server = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const f = u.searchParams.get('f');
    const target = f != null ? Number(f) : Number(u.searchParams.get('end'));
    while (written < target) { await writeBuf(last); written += 1; }
    if (f != null) { last = Buffer.concat(chunks); await writeBuf(last); written += 1; stats.drawnFrames += 1; }
    else { stdin.end(); finish(); }
    res.writeHead(200, cors); res.end('ok');
  }).listen(4717, '127.0.0.1');
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4716/?mode=export');
  await page.waitForFunction(() => window.ready === true);
  const ffP = runFfmpeg(overlayArgs(scene.width, bandInfo.height), async (s) => { stdin = s; });
  await page.evaluate(([id, d, fps]) => window.exportRun(id, d, fps, 'http://127.0.0.1:4717/frame'), [variantId, duration, scene.fps]);
  await done;
  ff = await ffP;
  await browser.close();
  server.close();
}
clearInterval(rssTimer);
const wall = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const row = {
  engine, variant: variantId, duration, fullFrame, opt, frames, ...stats,
  wallSec: +wall.toFixed(1), speedX: +(duration / wall).toFixed(2),
  nodeCpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1), nodePeakMB: +(peakNodeRss / 1048576).toFixed(0),
  ...ff, cores: cpus().length, date: new Date().toISOString(),
};
console.log(JSON.stringify(row));
mkdirSync(`${root}results`, { recursive: true });
appendFileSync(`${root}results/${process.env.BENCH_OUT ?? 'export-bench.jsonl'}`, `${JSON.stringify(row)}\n`);
