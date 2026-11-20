import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { ClipBatchSnapshot } from '../../shared/clips';

test('F-0049/AC-1 AC-2 Host persists a batch, deduplicates requestId and writes all outputs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0049-'));
  const media = join(home, 'src.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0049-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0049-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0049-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0049', videoName: 'a.mp4', durationSeconds: 6, media: { assetId, mimeType: 'video/mp4' } });
    const clips = [1, 2, 3].map(index => ({ id: randomUUID(), name: `clip ${index}`, start: index, end: index + 1,
      score: 80, text: `clip ${index}`, reasons: ['test'], createdAt: new Date().toISOString() }));
    await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
      edits: { chunks: [], deletedWordIds: [], clips } });
    const requestId = randomUUID();
    const started = await call<ClipBatchSnapshot>('clips.batchStart', { projectId: created.projectId, videoId: created.videoId, requestId,
      items: clips.map(clip => ({ clipId: clip.id, name: clip.name, segments: [{ start: clip.start, end: clip.end, keep: true }],
        subtitleProcessing: 'none' })) });
    assert.equal(started.requestId, requestId);
    let snapshot = started;
    for (let i = 0; i < 600; i += 1) {
      snapshot = (await call<ClipBatchSnapshot | null>('clips.batchStatus', { projectId: created.projectId, requestId }))!;
      if (['completed', 'partial', 'cancelled', 'failed'].includes(snapshot.status)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot.items));
    assert.equal(snapshot.items.filter(item => item.status === 'saved').length, 3);
    for (const clip of clips) {
      await stat(join(home, 'projects', created.projectId, 'videos', created.videoId, 'clips', `${clip.id}.mp4`));
    }
    const replay = await call<ClipBatchSnapshot>('clips.batchStart', { projectId: created.projectId, videoId: created.videoId, requestId,
      items: clips.map(clip => ({ clipId: clip.id, name: clip.name, segments: [{ start: clip.start, end: clip.end, keep: true }], subtitleProcessing: 'none' })) });
    assert.equal(replay.requestId, requestId);
    assert.equal(replay.items.length, 3);
    console.log(`batch=${snapshot.status} saved=${snapshot.items.filter(item => item.status === 'saved').length}`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
