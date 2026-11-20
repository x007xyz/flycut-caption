import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { ProjectOpenResult } from '../../shared/projects';
import type { TrackDubResult } from '../../shared/tts/dubbing';

async function freePort(): Promise<number> {
  const { createServer } = await import('node:http');
  return await new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); }); });
}

test('F-0036/AC-1 AC-2 AC-4 aligns each cue, speeds within range and leaves unresolved cues unsaved', async () => {
  const port = await freePort();
  const tts: ChildProcess = spawn(process.execPath, ['scripts/examples/tts-provider-server.mjs', '--port', String(port)], { stdio: 'ignore' });
  await new Promise(done => setTimeout(done, 500));
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0036-'));
  const ctx = await createHost({ home, token: 'f0036-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop', patches: [{ source: 'f0036', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0036-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    await call('endpoints.save', { name: 'tts-ref', label: 'TTS Reference', protocol: 'flycut', baseUrl: `http://127.0.0.1:${port}`, timeoutSeconds: 30 });
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0036', videoName: 'a.mp4', durationSeconds: 4, media: { assetId: await (async () => {
        const response = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0036-token' }, body: new Uint8Array(Buffer.from('x')) });
        return ((await response.json()) as { assetId: string }).assetId;
      })(), mimeType: 'video/mp4' } });
    const chunks = [
      { id: 'c1', text: '中文一', timestamp: [0, 2] },
      { id: 'c2', text: '中文二', timestamp: [2, 3] },
      { id: 'c3', text: '中文三', timestamp: [3, 4] },
    ];
    const languageTracks = [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
      c1: { text: 'Short cue text', sourceText: '中文一', updatedAt: '2026-11-17T00:00:00Z' },
      c2: { text: 'This is a much longer translation that should need speed control but is still too long for one second', sourceText: '中文二', updatedAt: '2026-11-17T00:00:00Z' },
      c3: { text: 'Reasonable cue', sourceText: '中文三', updatedAt: '2026-11-17T00:00:00Z' },
    } }];
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 4, transcript: { text: '中文一中文二中文三', language: 'zh', duration: 4, chunks } });
    await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
      edits: { chunks, deletedWordIds: [], languageTracks, activeLanguageTrackId: 'en' } });
    const opened = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    if (opened.status !== 'ok') throw new Error('open failed');
    const job = await call<JobSnapshot>('dubbing.alignTrack', {
      projectId: created.projectId, videoId: created.videoId, trackId: 'en', baseVideoRevision: opened.video.revision, maxSpeed: 1.25,
      cues: chunks.map(chunk => ({ chunkId: chunk.id, expectedText: languageTracks[0].entries[chunk.id as 'c1'].text })),
      request: { providerId: 'flycut:tts-ref', modelId: 'kokoro-demo', language: 'en', voiceId: 'af_heart' },
    });
    let result: TrackDubResult | undefined;
    for (let i = 0; i < 400; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result as TrackDubResult; break; }
      if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(result);
    if (!result || result.status !== 'saved') throw new Error('not saved');
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].chunkId, 'c2');
    const after = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    if (after.status !== 'ok') throw new Error('open after failed');
    assert.equal(after.edits?.dubbings?.length, 2);
    assert.ok(after.edits?.dubbings?.every(item => item.alignment && item.durationSeconds <= item.cueDurationSeconds + 0.01));
    assert.ok(after.edits?.dubbings?.some(item => item.alignment?.mode === 'speed' && (item.alignment.speed ?? 0) > 1));
  } finally {
    await ctx.fiber.dispose();
    tts.kill();
    await rm(home, { recursive: true, force: true });
  }
});
