import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app.ts';
import { emptySubtitleGraphicStyle, type SubtitleGraphicScene } from '../../shared/subtitle-graphics/index.ts';

const ffmpeg = resolve('src-tauri/binaries/ffmpeg');
function run(args: string[]) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function scene(width: number, height: number): SubtitleGraphicScene {
  const primary = { ...emptySubtitleGraphicStyle(), fontFamily: 'FlyCutNotoSansSC', fontSizeRatio: 0.08, bottomOffsetRatio: 40 / height };
  return {
    version: 1, width, height, fps: 30, duration: 6,
    fontId: 'noto-sans-sc', fontFamily: 'FlyCutNotoSansSC', displayMode: 'Bilingual', maxWidthRatio: 0.9,
    primary, secondary: { ...primary, fontSizeRatio: 0.05 },
    cues: [
      { id: 'a', start: 0.5, end: 2.5, text: 'HELLO 字幕测试' },
      { id: 'b', start: 3, end: 5, text: 'SECOND LINE', secondText: '副字幕' },
    ],
  };
}
const duration = (info: string) => { const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info)!; return +m[1] * 3600 + +m[2] * 60 + +m[3]; };
const grayFrame = (file: string, time: number, width: number, height: number) => {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, width * height);
  return result.stdout;
};

test('F-0028/AC-3 real Host renders the shared scene with a Skia band and no ASS', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0028-host-'));
  const ctx = await createHost({ home, token: 'f0028', port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0028', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json(); assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result)); return envelope.result.value;
  };
  try {
    const source = join(home, 'source.mp4');
    run(['-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: 'Bearer f0028' }, body: await readFile(source) })).json();
    const job = await call('export.start', { assetId: asset.assetId, segments: [{ start: 0, end: 6, keep: true }],
      options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'hard', subtitleTransport: 'skia-band', subtitleScene: scene(640, 360) } });
    let state = job;
    const deadline = Date.now() + 60_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'export timeout'); await new Promise(r => setTimeout(r, 20)); state = await call('jobs.get', { id: job.id });
    }
    assert.equal(state.status, 'complete', state.error);
    const output = ctx.assets.path(state.result.assetId);
    const info = run(['-i', output, '-t', '0', '-f', 'null', '-']).stderr;
    assert.ok(Math.abs(duration(info) - 6) < 0.1, 'duration preserved');
    const cue = grayFrame(output, 1.5, 640, 360);
    const gap = grayFrame(output, 2.8, 640, 360);
    const bright = (buffer: Buffer) => buffer.reduce((count, value) => count + (value > 220 ? 1 : 0), 0);
    assert.ok(bright(cue) > 100, 'subtitle pixels present in the cue frame');
    assert.ok(bright(gap) < 10, 'subtitle layer is transparent outside cues');
    const files = await readdir(join(home, 'exports'));
    assert.deepEqual(files.filter(file => file.endsWith('.ass')), [], 'no ASS temp file for the new path');
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('F-0028/AC-8 missing bundled fonts fail the export with a readable reason', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0028-font-'));
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = ffmpeg;
  const ctx = await createHost({ home, token: 'f0028-font', port: 0, resourceRoot: home }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0028-font', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json(); assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result)); return envelope.result.value;
  };
  try {
    const source = join(home, 'source.mp4');
    run(['-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', source]);
    const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: 'Bearer f0028-font' }, body: await readFile(source) })).json();
    const job = await call('export.start', { assetId: asset.assetId, segments: [{ start: 0, end: 2, keep: true }],
      options: { format: 'mp4', quality: 'low', preserveAudio: false, subtitleProcessing: 'hard', subtitleTransport: 'skia-band', subtitleScene: scene(320, 180) } });
    let state = job;
    while (state.status === 'running' || state.status === 'queued') { await new Promise(r => setTimeout(r, 20)); state = await call('jobs.get', { id: job.id }); }
    assert.equal(state.status, 'error');
    assert.match(state.error, /字幕渲染不可用/);
  } finally {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
    await rm(home, { recursive: true, force: true });
  }
});

