import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FFmpegEngine } from '../../src/services/videoEngines/FFmpegEngine';
import type { VideoProcessingOptions } from '../../src/types/videoEngine';
import type { VideoSegment } from '../../src/types/video';
import { createHost } from '../../server/app';
import { createEdl, exportSegments, outputDuration, outputToSource, deriveKept } from '../../shared/editing/edl';

const ffmpeg = resolve('src-tauri/binaries/ffmpeg');
function run(args: string[]) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stderr;
}
function decode(path: string, audio: boolean): Buffer {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-i', path,
    ...(audio ? ['-vn', '-ac', '1', '-ar', '48000', '-f', 's16le'] : ['-an', '-pix_fmt', 'gray', '-f', 'rawvideo']), '-'],
    { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
function verifyContent(source: string, output: string, edl: ReturnType<typeof createEdl>, audio: boolean) {
  const original = decode(source, false); const rendered = decode(output, false); const frameSize = 160 * 90;
  // Compare decoded pictures throughout the output, including every join, allowing one source frame of quantization.
  for (let frame = 0; frame < Math.floor(rendered.length / frameSize) - 1; frame++) {
    const expected = Math.floor(outputToSource(edl, frame / 25)! * 25);
    let best = Infinity;
    const candidates = new Set<number>();
    // CFR may repeat the preceding retained picture until the next frame boundary, including across a cut.
    for (const t of [Math.max(0, (frame - 1) / 25), frame / 25, (frame + 1) / 25]) {
      const sourceFrame = outputToSource(edl, t)! * 25;
      candidates.add(Math.floor(sourceFrame)); candidates.add(Math.ceil(sourceFrame));
    }
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= 150) continue;
      let difference = 0;
      for (let pixel = 0; pixel < frameSize; pixel += 16) difference += Math.abs(original[candidate * frameSize + pixel] - rendered[frame * frameSize + pixel]);
      best = Math.min(best, difference / (frameSize / 16));
    }
    assert.ok(best < 12, `output frame ${frame} does not match retained source near frame ${expected}: MAE=${best}`);
  }
  if (!audio) return;
  const input = decode(source, true); const sound = decode(output, true);
  const sample = (buffer: Buffer, index: number) => buffer.readInt16LE(index * 2);
  // Seeded noise makes each source position identifiable. Correlate after each join; a constant tone would hide drift.
  for (const kept of deriveKept(edl)) {
    if (kept.endUs - kept.startUs < 160000) continue;
    const out = Math.round((kept.outputStartUs / 1e6 + 0.08) * 48000);
    const src = Math.round((kept.startUs / 1e6 + 0.08) * 48000);
    let best = -Infinity; let shift = 0;
    for (let offset = -4000; offset <= 4000; offset++) {
      if (src + offset < 0 || src + offset + 512 >= input.length / 2 || out + 512 >= sound.length / 2) continue;
      let cross = 0; let norm = 0;
      for (let i = 0; i < 512; i += 2) { const a = sample(input, src + offset + i); const b = sample(sound, out + i); cross += a * b; norm += a * a; }
      const score = cross / Math.sqrt(norm || 1);
      if (score > best) { best = score; shift = offset; }
    }
    assert.ok(Math.abs(shift) / 48000 <= 1 / 25 + 1024 / 48000,
      `audio drift at output ${out / 48000}s: ${shift / 48000}s`);
  }
}
const duration = (info: string) => { const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info)!; return +m[1] * 3600 + +m[2] * 60 + +m[3]; };

test('F-0005/AC-5 real Host: tail trims, silent video and multiple cut points use the captured plan', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-edl-export-'));
  const ctx = await createHost({ home, token: 'edl-test', port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as {port: number}).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer edl-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json(); assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result)); return envelope.result.value;
  };
  try {
    for (const audio of [true, false]) {
      const source = join(home, `source-${audio}.mp4`);
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=6',
        ...(audio ? ['-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.5:sample_rate=48000:duration=6:seed=42'] : []),
        '-c:v', 'libx264', '-preset', 'ultrafast', ...(audio ? ['-c:a', 'aac'] : ['-an']), source]);
      const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: 'Bearer edl-test' }, body: await readFile(source) })).json();
      for (const edl of [createEdl(6, [{ start: 2, end: 6 }]), createEdl(6,
        Array.from({ length: 12 }, (_, i) => ({ start: i * 0.5 + 0.123, end: i * 0.5 + 0.267 })))]) {
        const job = await call('export.start', { assetId: asset.assetId, edl, segments: exportSegments(edl),
          options: { format: 'mp4', quality: 'medium', preserveAudio: true, subtitleProcessing: 'none' } });
        let state = job;
        const deadline = Date.now() + 30_000;
        while (state.status === 'running' || state.status === 'queued') {
          assert.ok(Date.now() < deadline, 'export timeout'); await new Promise(r => setTimeout(r, 20)); state = await call('jobs.get', { id: job.id });
        }
        assert.equal(state.status, 'complete', state.error);
        const output = ctx.assets.path(state.result.assetId);
        const info = run(['-i', output, '-t', '0', '-f', 'null', '-']);
        const actual = duration(info); const expected = outputDuration(edl);
        assert.ok(Math.abs(actual - expected) <= 1 / 25 + (audio ? 1024 / 48000 : 0) + 0.005,
          `${audio ? 'audio' : 'silent'} ${edl.deleted.length} cuts: ${actual}s != ${expected}s`);
        assert.equal(/Stream.*Audio:/.test(info), audio);
        verifyContent(source, output, edl, audio);
        const local = new FFmpegEngine() as unknown as { buildFFmpegCommand(input: string, output: string, segments: VideoSegment[], options: VideoProcessingOptions): string[] };
        const localOutput = join(home, `local-${audio}-${edl.deleted.length}.mp4`);
        run(local.buildFFmpegCommand(source, localOutput, exportSegments(edl), { edl, format: 'mp4', quality: 'medium', preserveAudio: audio }));
        const localDuration = duration(run(['-i', localOutput, '-t', '0', '-f', 'null', '-']));
        assert.ok(Math.abs(localDuration - expected) <= 1 / 25 + (audio ? 1024 / 48000 : 0) + 0.005);
        verifyContent(source, localOutput, edl, audio);
        console.log(`F-0005 real export: audio=${audio}, cuts=${edl.deleted.length}, target=${expected}, actual=${actual}`);
      }
    }
    const edl = createEdl(6, [{ start: 2, end: 6 }]);
    // Deliberately inconsistent snapshots must fail before encoding.
    const source = join(home, 'source-false.mp4');
    const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: 'Bearer edl-test' }, body: await readFile(source) })).json();
    const bad = await call('export.start', { assetId: asset.assetId, edl, segments: [{ start: 0, end: 6, keep: true }],
      options: { format: 'mp4', quality: 'medium', preserveAudio: false } });
    let state = bad;
    while (state.status === 'running' || state.status === 'queued') { await new Promise(r => setTimeout(r, 20)); state = await call('jobs.get', { id: bad.id }); }
    assert.equal(state.status, 'error'); assert.match(state.error, /disagree/);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});
