// F-0028 AC-3 benchmark: run with F0028_BENCH=1 MINUTES=20 tsx tests/architecture/subtitle-bench-f0028.ts
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app.ts';
import { emptySubtitleGraphicStyle, type SubtitleGraphicScene } from '../../shared/subtitle-graphics/index.ts';

const ffmpeg = resolve('src-tauri/binaries/ffmpeg');
const minutes = Number(process.env.MINUTES ?? 20);
const assetIdOverride = process.env.ASSET_ID;
const kindFilter = process.env.KIND as 'scene' | 'ass' | undefined;
const root = join('/tmp', 'flycut-f0028-bench');
await mkdir(root, { recursive: true });
const source = join(root, `source-${minutes}.mp4`);
const run = (args: string[]) => {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result;
};
const exists = assetIdOverride ? true : await stat(source).then(() => true).catch(() => false);
if (!exists) {
  console.log('generating source', minutes, 'minutes');
  const base = join(root, 'source-20.mp4');
  const baseExists = await stat(base).then(() => true).catch(() => false);
  if (!baseExists) run(['-f', 'lavfi', '-i', 'color=c=0x202020:size=1920x1080:rate=30:duration=1200',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1200',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base]);
  if (minutes === 20) await import('node:fs/promises').then(({ copyFile }) => copyFile(base, source));
  else run(['-stream_loop', String(Math.ceil(minutes / 20) - 1), '-i', base, '-t', String(minutes * 60), '-c', 'copy', source]);
}

function scene(durationSeconds: number): SubtitleGraphicScene {
  const primary = { ...emptySubtitleGraphicStyle(), fontFamily: 'FlyCutNotoSansSC', fontSizeRatio: 0.05 };
  const cues = [];
  for (let start = 0.5; start + 2.5 < durationSeconds; start += 3) {
    cues.push({ id: `c${cues.length}`, start, end: start + 2.5, text: '今天我们来聊一聊字幕渲染和视频导出的性能表现' });
  }
  return { version: 1, width: 1920, height: 1080, fps: 30, duration: durationSeconds,
    fontId: 'noto-sans-sc', fontFamily: 'FlyCutNotoSansSC', displayMode: 'Main', maxWidthRatio: 0.9,
    primary, cues };
}
function ass(durationSeconds: number): string {
  const time = (seconds: number) => {
    const h = Math.floor(seconds / 3600); const m = Math.floor(seconds % 3600 / 60); const s = (seconds % 60).toFixed(2).padStart(5, '0');
    return `${h}:${String(m).padStart(2, '0')}:${s}`;
  };
  const events = [];
  for (let start = 0.5; start + 2.5 < durationSeconds; start += 3) {
    events.push(`Dialogue: 0,${time(start)},${time(start + 2.5)},Default,,0,0,0,,今天我们来聊一聊字幕渲染和视频导出的性能表现`);
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans SC,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,20,20,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}`;
}

const home = join(root, 'host');
const ctx = await createHost({ home, token: 'bench', port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
const baseUrl = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
const call = async (method: string, payload: unknown) => {
  const response = await fetch(baseUrl + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer bench', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'bench', method, payload }) });
  const envelope = await response.json(); if (!envelope.result.ok) throw new Error(JSON.stringify(envelope.result)); return envelope.result.value;
};
const asset = assetIdOverride ? { assetId: assetIdOverride }
  : await (await fetch(baseUrl + '/assets', { method: 'POST', headers: { Authorization: 'Bearer bench' }, body: await readFile(source) })).json();
const durationSeconds = minutes * 60;

async function exportOnce(kind: 'scene' | 'ass') {
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const started = performance.now();
  const job = await call('export.start', { assetId: asset.assetId, segments: [{ start: 0, end: durationSeconds, keep: true }],
    options: kind === 'scene'
      ? { format: 'mp4', quality: 'medium', preserveAudio: true, subtitleProcessing: 'hard', subtitleTransport: 'skia-band', subtitleScene: scene(durationSeconds) }
      : { format: 'mp4', quality: 'medium', preserveAudio: true, subtitleProcessing: 'hard', assContent: ass(durationSeconds) } });
  let state = job;
  while (state.status === 'running' || state.status === 'queued') { await new Promise(r => setTimeout(r, 200)); state = await call('jobs.get', { id: job.id }); }
  clearInterval(timer);
  if (state.status !== 'complete') throw new Error(state.error);
  const wall = (performance.now() - started) / 1000;
  const output = ctx.assets.path(state.result.assetId);
  const size = (await stat(output)).size;
  console.log(JSON.stringify({ kind, minutes, wallSec: +wall.toFixed(1), speedX: +(minutes * 60 / wall).toFixed(1),
    nodePeakMB: +(peak / 1048576).toFixed(0), outputMB: +(size / 1048576).toFixed(1), cues: scene(durationSeconds).cues.length }));
  return { kind, wall };
}

try {
  const sceneResult = kindFilter === 'ass' ? undefined : await exportOnce('scene');
  const assResult = kindFilter === 'scene' ? undefined : await exportOnce('ass');
  if (sceneResult && assResult) console.log(JSON.stringify({ minutes, sceneSec: +sceneResult.wall.toFixed(1), assSec: +assResult.wall.toFixed(1),
    ratio: +(sceneResult.wall / assResult.wall).toFixed(2) }));
} finally {
  await ctx.fiber.dispose();
}

