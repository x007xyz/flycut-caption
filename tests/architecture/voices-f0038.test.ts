import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { VoiceProfile } from '../../shared/tts/voices';

test('F-0038/AC-1 AC-2 AC-4 creates an authorized project voice sample and deletes it locally', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0038-'));
  const media = join(home, 'src.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0038-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0038-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0038-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await (await import('node:fs/promises')).readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0038', videoName: 'a.mp4', durationSeconds: 3, media: { assetId, mimeType: 'video/mp4' } });
    const job = await call<JobSnapshot>('voices.create', { projectId: created.projectId, videoId: created.videoId, start: 0.5, end: 2.5, name: '我的音色',
      authorization: { confirmed: true, statement: '本人授权', confirmedAt: new Date().toISOString(), sourceLabel: '本人视频' } });
    let result: any;
    for (let i = 0; i < 200; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(result.status, 'saved');
    const profile = result.profile as VoiceProfile;
    assert.equal(profile.durationSeconds, 2);
    assert.equal(profile.authorization.confirmed, true);
    await stat(join(home, 'projects', created.projectId, 'videos', created.videoId, profile.file));
    const list = await call<VoiceProfile[]>('voices.list', { projectId: created.projectId });
    assert.equal(list.length, 1);
    const tts: ChildProcess = spawn(process.execPath, ['scripts/examples/tts-provider-server.mjs', '--port', '9078'], { stdio: 'ignore' });
    await new Promise(done => setTimeout(done, 400));
    try {
      await call('endpoints.save', { name: 'voice-ref', label: 'Voice Ref', protocol: 'flycut', baseUrl: 'http://127.0.0.1:9078', timeoutSeconds: 30 });
      const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }];
      await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 3,
        transcript: { text: '第一句', language: 'zh', duration: 3, chunks } });
      await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
        edits: { chunks, deletedWordIds: [], languageTracks: [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual',
          entries: { c1: { text: 'First cue', sourceText: '第一句', updatedAt: new Date().toISOString() } } }], activeLanguageTrackId: 'en' } });
      const opened = await call<any>('projects.open', { projectId: created.projectId, videoId: created.videoId });
      const dub = await call<JobSnapshot>('dubbing.alignTrack', { projectId: created.projectId, videoId: created.videoId, trackId: 'en',
        baseVideoRevision: opened.video.revision, voiceProfileId: profile.id, maxSpeed: 1.25,
        cues: [{ chunkId: 'c1', expectedText: 'First cue' }],
        request: { providerId: 'flycut:voice-ref', modelId: 'cosyvoice-demo', language: 'en' } });
      let dubResult: any;
      for (let i = 0; i < 300; i += 1) {
        const current = await call<JobSnapshot>('jobs.get', { id: dub.id });
        if (current.status === 'complete') { dubResult = current.result; break; }
        if (current.status === 'error') throw new Error(current.error);
        await new Promise(done => setTimeout(done, 20));
      }
      assert.equal(dubResult.status, 'saved');
      assert.equal(dubResult.artifacts[0].voiceProfileId, profile.id);
    } finally { tts.kill(); }
    const deleted = await call<{ deleted: boolean; remoteRetained: boolean }>('voices.delete', { projectId: created.projectId, id: profile.id });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.remoteRetained, true);
    assert.equal((await call<VoiceProfile[]>('voices.list', { projectId: created.projectId })).length, 0);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
