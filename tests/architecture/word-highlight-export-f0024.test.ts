import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app.ts';
import { buildExportSubtitleScene } from '../../src/subtitle/graphicsScene.ts';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';
import type { SubtitleChunk } from '../../src/types/subtitle.ts';

const ffmpeg = resolve('src-tauri/binaries/ffmpeg');

function run(args: string[]) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function frame(file: string, time: number) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, 640 * 360 * 3);
  return result.stdout;
}

function pixels(buffer: Buffer, kind: 'red' | 'white' | 'redCentroid') {
  let count = 0;
  let xTotal = 0;
  for (let offset = 0; offset < buffer.length; offset += 3) {
    const r = buffer[offset]; const g = buffer[offset + 1]; const b = buffer[offset + 2];
    const matches = kind === 'white' ? r > 190 && g > 190 && b > 190 : r > 140 && r > g * 1.8 && r > b * 1.8;
    if (!matches) continue;
    count += 1;
    xTotal += (offset / 3) % 640;
  }
  if (kind === 'redCentroid') return count ? xTotal / count : -1;
  return count;
}

test('F-0024/AC-3 AC-4 real Host export changes fill by word and falls back without words', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0024-host-'));
  const token = 'f0024-word-highlight';
  const ctx = await createHost({ home, token, port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'f0024', method, payload }),
    });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  try {
    const source = join(home, 'source.mp4');
    run(['-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=30:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', source]);
    const chunks: SubtitleChunk[] = [
      { id: 's1', text: '大家好', timestamp: [0.1, 1.9], wordIds: ['w1', 'w2', 'w3'] },
      { id: 's2', text: '整句降级', timestamp: [2.1, 3.9] },
    ];
    const words: SubtitleChunk[] = [
      { id: 'w1', text: '大', timestamp: [0.1, 0.6], sentenceId: 's1' },
      { id: 'w2', text: '家', timestamp: [0.7, 1.2], sentenceId: 's1' },
      { id: 'w3', text: '好', timestamp: [1.2, 1.7], sentenceId: 's1' },
    ];
    const primary = {
      ...defaultSubtitleStylePair.primary,
      fontSizeRatio: 0.18,
      bottomOffsetRatio: 40 / 360,
      borderWidth: 0,
      color: '#FFFFFF',
      wordHighlightMode: 'word' as const,
      wordHighlightColor: '#FF0000',
    };
    const scene = buildExportSubtitleScene({
      chunks,
      wordChunks: words,
      hasWordTimestamps: true,
      stylePair: { primary, secondary: defaultSubtitleStylePair.secondary },
      keptSegments: [{ start: 0, end: 4, keep: true }],
      videoWidth: 640,
      videoHeight: 360,
      fps: 30,
      duration: 4,
    });

    const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: await readFile(source) })).json();
    const queued = await call('export.start', {
      assetId: asset.assetId,
      segments: [{ start: 0, end: 4, keep: true }],
      options: {
        format: 'mp4', quality: 'low', preserveAudio: false, subtitleProcessing: 'hard',
        subtitleTransport: 'skia-band', subtitleScene: scene,
      },
    });
    let state = queued;
    const deadline = Date.now() + 90_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'export timeout');
      await new Promise(done => setTimeout(done, 20));
      state = await call('jobs.get', { id: queued.id });
    }
    assert.equal(state.status, 'complete', state.error);
    const output = ctx.assets.path(state.result.assetId);

    const first = frame(output, 0.35);
    const gap = frame(output, 0.65);
    const second = frame(output, 0.95);
    const fallback = frame(output, 2.5);
    assert.ok(pixels(first, 'red') > 80, 'first word is highlighted');
    assert.ok(pixels(second, 'red') > 80, 'second word is highlighted');
    assert.ok(pixels(first, 'white') > 80, 'other words keep the base color');
    assert.ok(pixels(gap, 'red') < 8, 'word gap has no invented highlight');
    assert.ok(pixels(gap, 'white') > 80, 'the sentence remains visible in the gap');
    assert.ok(pixels(fallback, 'red') > pixels(first, 'red') * 2, 'missing words highlight the whole sentence');
    const firstX = pixels(first, 'redCentroid');
    const secondX = pixels(second, 'redCentroid');
    assert.ok(secondX - firstX > 25, `word centroid advances horizontally (${firstX} -> ${secondX})`);

    const files = await readdir(join(home, 'exports'));
    assert.deepEqual(files.filter(file => file.endsWith('.ass')), [], 'highlight export stays on the Skia scene path');
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
