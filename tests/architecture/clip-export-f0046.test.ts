import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';

test('F-0046/AC-2 AC-4 clip export crops to 1080x1920 and only the selected range', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0046-'));
  const media = join(home, 'src.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0046-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0046-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0046-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0046', videoName: 'a.mp4', durationSeconds: 4, media: { assetId, mimeType: 'video/mp4' } });
    const job = await call<JobSnapshot>('export.start', { operationId: randomUUID(), assetId: (await (async () => {
      const response = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0046-token', 'Content-Type': 'video/mp4' },
        body: new Uint8Array(await readFile(media)) });
      return ((await response.json()) as { assetId: string }).assetId;
    })()), segments: [{ start: 1, end: 3, keep: true }],
      options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'none', crop: '9:16', cropSamples: [{ time: 0, centerX: 200 }, { time: 1, centerX: 400 }] } });
    let result: { assetId: string } | undefined;
    for (let i = 0; i < 600; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result as { assetId: string }; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(result?.assetId);
    const bytes = Buffer.from(await (await fetch(`${base}/assets/${result.assetId}`, { headers: { Authorization: 'Bearer f0046-token' } })).arrayBuffer());
    const out = join(home, 'out.mp4'); await writeFile(out, bytes);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8' }));
    const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    const duration = Number(probe.format.duration);
    assert.ok(Math.abs(duration - 2) < 0.2, `duration ${duration}`);
    console.log(`crop=${video.width}x${video.height} duration=${duration}`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
