import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createHost } from '../../server/app';
import { ProjectStore } from '../../server/projects/store';
import { startExampleTtsServer } from '../../scripts/examples/tts-provider-server.mjs';
import type { JobSnapshot } from '../../shared/protocol';
import { projectEditsSchema } from '../../shared/projects';
import { validateTtsAudio } from '../../shared/tts/audio';
import type { CueDubbingArtifact, DubCueResult } from '../../shared/tts/dubbing';

async function bootHost(home: string, token = 'f0035-token') {
  const ctx = await createHost({ home, token, port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await setTimeout(25);
    }
    throw new Error('Job timeout');
  };
  const upload = async (bytes: Uint8Array) => {
    const res = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: bytes,
    });
    return (await res.json()).assetId as string;
  };
  return { ctx, base, token, call, waitJob, upload, close: () => ctx.fiber.dispose() };
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

test('F-0035/AC-1 AC-2 AC-3 AC-4 AC-7 project cue dubbing persists in project dir, streams via Range, deduplicates retries, keeps media untouched, and survives Host restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0035-arch-'));
  const example = await startExampleTtsServer({ port: 0, token: 'tts-demo-secret' });
  let host = await bootHost(home, 'token-1');
  try {
    // Legacy format-4 edits compatibility
    const legacy = projectEditsSchema.parse({ chunks: [{ id: 'c1', text: 'hi', timestamp: [0, 2] }], deletedWordIds: [] });
    assert.equal(legacy.dubbings, undefined);

    await host.call('endpoints.save', {
      name: 'example-tts',
      label: 'Example TTS',
      protocol: 'flycut',
      baseUrl: example.url,
      apiKey: 'tts-demo-secret',
    });

    const mediaBytes = new Uint8Array(await readFile(resolve('tests/media/clips/dub/ref-zh-podcast-host.wav')));
    const mediaHash = sha256(mediaBytes);
    const assetId = await host.upload(mediaBytes);
    const created = await host.call<{ projectId: string; videoId: string; revision: number }>('projects.create', {
      name: 'Dubbing Project',
      videoName: 'host.wav',
      durationSeconds: 8,
      media: { assetId, mimeType: 'audio/wav' },
    });

    const chunks = [
      { id: 'c1', text: '大家好，欢迎来到本期节目', timestamp: [0, 3.5] as [number, number] },
      { id: 'c2', text: 'Let us test English dubbing here', timestamp: [3.5, 5.0] as [number, number] },
    ];
    await host.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: { text: chunks.map(c => c.text).join(' '), chunks, language: 'zh', duration: 8 },
    });

    const trackEn = {
      id: 'track-en',
      name: 'English',
      languageCode: 'en',
      origin: 'manual' as const,
      entries: {
        c1: { text: 'Hello everyone, welcome to this episode.', sourceText: chunks[0].text, updatedAt: '2026-11-13T10:00:00.000Z' },
      },
    };
    const trackZh = {
      id: 'track-zh',
      name: '中文',
      languageCode: 'zh',
      origin: 'manual' as const,
      entries: {
        c2: { text: '我们来测试中文配音效果，这一句会故意写得很长以超过一秒半的字幕区间', sourceText: chunks[1].text, updatedAt: '2026-11-13T10:00:00.000Z' },
      },
    };

    const saveEdits = await host.call<any>('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'project',
      baseRevision: 0,
      edits: { chunks, deletedWordIds: [], languageTracks: [trackEn, trackZh], activeLanguageTrackId: 'track-en' },
    });
    assert.equal(saveEdits.status, 'saved');
    assert.equal(saveEdits.revision, 1);

    // Reject cloning on F-0035 endpoint
    await assert.rejects(() => host.call('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 'track-en',
      chunkId: 'c1',
      baseVideoRevision: 1,
      expectedText: trackEn.entries.c1.text,
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'cosyvoice-demo',
        text: trackEn.entries.c1.text,
        language: 'en',
        cloneReferenceAssetId: assetId,
      },
    }), /不支持声音克隆/);

    // English cue synthesis
    const opEn = crypto.randomUUID();
    const enJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 'track-en',
      chunkId: 'c1',
      baseVideoRevision: 1,
      expectedText: trackEn.entries.c1.text,
      operationId: opEn,
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'kokoro-demo',
        text: trackEn.entries.c1.text,
        voiceId: 'af_heart',
        language: 'en',
        speed: 1.0,
      },
    })).id);
    assert.equal(enJob.status, 'complete', enJob.error);
    const enResult = enJob.result as Extract<DubCueResult, { status: 'saved' }>;
    assert.equal(enResult.status, 'saved');
    assert.equal(enResult.videoRevision, 2);
    assert.ok(enResult.artifact.file.startsWith('dubbing/'));

    // Chinese cue synthesis (duration > 1.5s cue duration)
    const zhJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 'track-zh',
      chunkId: 'c2',
      baseVideoRevision: 2,
      expectedText: trackZh.entries.c2.text,
      operationId: crypto.randomUUID(),
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'kokoro-demo',
        text: trackZh.entries.c2.text,
        voiceId: 'zf_xiaobei',
        language: 'zh',
        speed: 1.0,
      },
    })).id);
    assert.equal(zhJob.status, 'complete', zhJob.error);
    const zhResult = zhJob.result as Extract<DubCueResult, { status: 'saved' }>;
    assert.equal(zhResult.status, 'saved');
    assert.equal(zhResult.videoRevision, 3);
    assert.ok(zhResult.artifact.durationSeconds > zhResult.artifact.cueDurationSeconds);

    // Idempotent retry by operationId even with stale baseVideoRevision
    const dupJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 'track-en',
      chunkId: 'c1',
      baseVideoRevision: 1,
      expectedText: trackEn.entries.c1.text,
      operationId: opEn,
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'kokoro-demo',
        text: trackEn.entries.c1.text,
        voiceId: 'af_heart',
        language: 'en',
      },
    })).id);
    const dupResult = dupJob.result as Extract<DubCueResult, { status: 'saved' }>;
    assert.equal(dupResult.status, 'saved');
    assert.equal(dupResult.artifact.id, enResult.artifact.id);

    // HTTP streaming + Range request + auth enforcement
    const streamUrl = `${host.base}/projects/${created.projectId}/videos/${created.videoId}/dubbing/${enResult.artifact.id}`;
    const unauth = await fetch(streamUrl);
    assert.equal(unauth.status, 401);
    const fullRes = await fetch(streamUrl, { headers: { Authorization: `Bearer ${host.token}` } });
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('cache-control'), 'no-store');
    const fullBytes = new Uint8Array(await fullRes.arrayBuffer());
    assert.equal(validateTtsAudio(fullBytes, 'audio/wav').format, 'wav');

    const rangeRes = await fetch(streamUrl, { headers: { Authorization: `Bearer ${host.token}`, Range: 'bytes=0-43' } });
    assert.equal(rangeRes.status, 206);
    assert.equal((await rangeRes.arrayBuffer()).byteLength, 44);

    // Redo replaces old file on disk
    const redoJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 'track-en',
      chunkId: 'c1',
      baseVideoRevision: 3,
      expectedText: trackEn.entries.c1.text,
      operationId: crypto.randomUUID(),
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'kokoro-demo',
        text: trackEn.entries.c1.text,
        voiceId: 'af_heart',
        language: 'en',
        speed: 1.2,
      },
    })).id);
    const redoResult = redoJob.result as Extract<DubCueResult, { status: 'saved' }>;
    assert.equal(redoResult.status, 'saved');
    assert.notEqual(redoResult.artifact.id, enResult.artifact.id);
    const dubDirFiles = await readdir(join(home, 'projects', created.projectId, 'videos', created.videoId, 'dubbing'));
    assert.equal(dubDirFiles.length, 2);
    assert.ok(!dubDirFiles.includes(`${enResult.artifact.id}.wav`));

    // Original video media is untouched
    const storedMediaPath = join(home, 'projects', created.projectId, 'media', `${created.videoId}.wav`);
    assert.equal(sha256(new Uint8Array(await readFile(storedMediaPath))), mediaHash);

    // Duplicate copies dubbing directory too
    const dupProj = await host.call<{ projectId: string; videoId: string }>('projects.duplicate', {
      projectId: created.projectId,
      videoId: created.videoId,
      name: 'Dubbing Copy',
    });
    const dupDubFiles = await readdir(join(home, 'projects', dupProj.projectId, 'videos', dupProj.videoId, 'dubbing'));
    assert.equal(dupDubFiles.length, 2);

    // Host restart + second client read consistency
    await host.close();
    host = await bootHost(home, 'token-2');
    const reopened = await host.call<any>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    assert.equal(reopened.status, 'ok');
    assert.equal(reopened.video.revision, 4);
    assert.equal(reopened.edits.dubbings.length, 2);
    const reopenedStream = await fetch(`${host.base}/projects/${created.projectId}/videos/${created.videoId}/dubbing/${redoResult.artifact.id}?token=token-2`);
    assert.equal(reopenedStream.status, 200);

    // Removing video deletes its dubbing folder
    await host.call('projects.removeVideo', { projectId: dupProj.projectId, videoId: dupProj.videoId });
    await assert.rejects(() => stat(join(home, 'projects', dupProj.projectId, 'videos', dupProj.videoId)));
  } finally {
    await host.close().catch(() => undefined);
    await example.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0035/AC-3 AC-6 AC-8 dubbing.synthesizeCue blocks revision/text conflicts before TTS, aborts mid-flight conflicts, and supports cancellation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0035-conflict-'));
  let ttsRequests = 0;
  let mode: 'fast' | 'slow' | 'mp3' = 'fast';
  let onSynthStart: (() => void) | undefined;

  const mp3TempDir = await mkdtemp(join(tmpdir(), 'flycut-f0035-mp3-'));
  const wavSource = resolve('tests/media/clips/dub/ref-zh-podcast-host.wav');
  const mp3File = join(mp3TempDir, 'sample.mp3');
  const ff = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-i', wavSource, '-t', '1.2', mp3File]);
  const mp3Bytes = ff.status === 0 ? await readFile(mp3File) : null;

  const upstream = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/v1/health') return json(200, { protocol: 'flycut-provider', version: 1, name: 'Mock TTS', capabilities: ['tts'] });
    if (req.url === '/v1/models') {
      return json(200, {
        models: [{
          id: 'test-tts',
          name: 'Test TTS',
          role: 'tts',
          languages: ['en', 'zh'],
          status: 'ready',
          tts: { voices: [{ id: 'v1', name: 'V1' }], voiceCloning: false, outputFormats: ['wav', 'mp3'] },
        }],
      });
    }
    if (req.url === '/v1/tts/jobs' && req.method === 'POST') {
      ttsRequests += 1;
      for await (const chunk of req) void chunk;
      onSynthStart?.();
      return json(202, { id: 'job-1' });
    }
    if (req.url === '/v1/jobs/job-1') {
      if (mode === 'slow') return json(200, { id: 'job-1', status: 'running', progress: 50 });
      if (mode === 'mp3' && mp3Bytes) {
        return json(200, { id: 'job-1', status: 'complete', result: { audioUrl: '/v1/jobs/job-1/audio', mimeType: 'audio/mpeg', format: 'mp3' } });
      }
      return json(200, { id: 'job-1', status: 'complete', result: { audioUrl: '/v1/jobs/job-1/audio', mimeType: 'audio/wav', format: 'wav', durationSeconds: 0.5 } });
    }
    if (req.url === '/v1/jobs/job-1/audio') {
      if (mode === 'mp3' && mp3Bytes) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Bytes.byteLength });
        res.end(mp3Bytes);
        return;
      }
      const buf = Buffer.alloc(44 + 16000);
      buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + 16000, 4); buf.write('WAVE', 8, 'ascii');
      buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36, 'ascii'); buf.writeUInt32LE(16000, 40);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.byteLength });
      res.end(buf);
      return;
    }
    if (req.url === '/v1/jobs/job-1/cancel' && req.method === 'POST') return json(200, { id: 'job-1', status: 'cancelled' });
    json(404, { error: 'Not found' });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  const host = await bootHost(home, 'c-token');
  try {
    await host.call('endpoints.save', { name: 'mock', label: 'Mock', protocol: 'flycut', baseUrl: upstreamUrl });
    const assetId = await host.upload(new Uint8Array(await readFile(wavSource)));
    const created = await host.call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'Conflict Test',
      videoName: 'clip.wav',
      durationSeconds: 5,
      media: { assetId, mimeType: 'audio/wav' },
    });
    const chunks = [{ id: 'c1', text: '原文', timestamp: [0, 2] as [number, number] }];
    await host.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: { text: '原文', chunks, language: 'zh', duration: 5 },
    });
    const track = { id: 't1', name: 'English', languageCode: 'en', origin: 'manual' as const, entries: { c1: { text: 'Old translation', sourceText: '原文', updatedAt: '2026-11-13T10:00:00.000Z' } } };
    await host.call('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'project',
      baseRevision: 0,
      edits: { chunks, deletedWordIds: [], languageTracks: [track], activeLanguageTrackId: 't1' },
    });

    // 1. Pre-check rejects stale revision without calling upstream TTS
    const staleJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 't1',
      chunkId: 'c1',
      baseVideoRevision: 0,
      expectedText: 'Old translation',
      request: { providerId: 'flycut:mock', modelId: 'test-tts', text: 'Old translation', voiceId: 'v1', language: 'en' },
    })).id);
    assert.equal(staleJob.status, 'complete');
    assert.equal((staleJob.result as DubCueResult).status, 'conflict');
    assert.equal((staleJob.result as Extract<DubCueResult, { status: 'conflict' }>).reason, 'revision-mismatch');
    assert.equal(ttsRequests, 0);

    // 2. Pre-check rejects text mismatch without calling upstream TTS
    const textMismatchJob = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 't1',
      chunkId: 'c1',
      baseVideoRevision: 1,
      expectedText: 'Different text',
      request: { providerId: 'flycut:mock', modelId: 'test-tts', text: 'Different text', voiceId: 'v1', language: 'en' },
    })).id);
    assert.equal((textMismatchJob.result as Extract<DubCueResult, { status: 'conflict' }>).reason, 'text-changed');
    assert.equal(ttsRequests, 0);

    // 3. Mid-flight revision bump during slow synthesis aborts commit and writes nothing
    mode = 'slow';
    let synthStarted!: () => void;
    const startedPromise = new Promise<void>(resolve => { synthStarted = resolve; });
    onSynthStart = synthStarted;
    const slowJob = await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 't1',
      chunkId: 'c1',
      baseVideoRevision: 1,
      expectedText: 'Old translation',
      request: { providerId: 'flycut:mock', modelId: 'test-tts', text: 'Old translation', voiceId: 'v1', language: 'en' },
    });
    await startedPromise;
    // Concurrent client edits translation while TTS is running
    const updatedTrack = { ...track, entries: { c1: { text: 'New translation', sourceText: '原文', updatedAt: '2026-11-13T10:01:00.000Z' } } };
    const bumped = await host.call<any>('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'project',
      baseRevision: 1,
      edits: { chunks, deletedWordIds: [], languageTracks: [updatedTrack], activeLanguageTrackId: 't1' },
    });
    assert.equal(bumped.revision, 2);
    mode = 'fast';
    const settledMid = await host.waitJob(slowJob.id);
    assert.equal(settledMid.status, 'complete');
    assert.equal((settledMid.result as DubCueResult).status, 'conflict');
    const dubFilesAfterConflict = await readdir(join(home, 'projects', created.projectId, 'videos', created.videoId, 'dubbing')).catch(() => []);
    assert.equal(dubFilesAfterConflict.length, 0);

    // 4. Cancellation stops slow job cleanly
    mode = 'slow';
    const cancelJob = await host.call<JobSnapshot>('dubbing.synthesizeCue', {
      projectId: created.projectId,
      videoId: created.videoId,
      trackId: 't1',
      chunkId: 'c1',
      baseVideoRevision: 2,
      expectedText: 'New translation',
      request: { providerId: 'flycut:mock', modelId: 'test-tts', text: 'New translation', voiceId: 'v1', language: 'en' },
    });
    await setTimeout(100);
    const cancelled = await host.call<JobSnapshot>('jobs.cancel', { id: cancelJob.id });
    assert.equal(cancelled.status, 'cancelled');

    // 5. MP3 format probes duration via FFmpeg when available
    if (mp3Bytes) {
      mode = 'mp3';
      const mp3Job = await host.waitJob((await host.call<JobSnapshot>('dubbing.synthesizeCue', {
        projectId: created.projectId,
        videoId: created.videoId,
        trackId: 't1',
        chunkId: 'c1',
        baseVideoRevision: 2,
        expectedText: 'New translation',
        request: { providerId: 'flycut:mock', modelId: 'test-tts', text: 'New translation', voiceId: 'v1', language: 'en' },
      })).id);
      assert.equal(mp3Job.status, 'complete', mp3Job.error);
      const mp3Res = mp3Job.result as Extract<DubCueResult, { status: 'saved' }>;
      assert.equal(mp3Res.artifact.format, 'mp3');
      assert.ok(mp3Res.artifact.durationSeconds > 1.0 && mp3Res.artifact.durationSeconds < 1.5);
    }

    // 6. ProjectStore.writeEdits rejects invalid dubbings references
    const store = new ProjectStore(home);
    const validArt: CueDubbingArtifact = {
      id: crypto.randomUUID(),
      trackId: 'unknown-track',
      chunkId: 'c1',
      file: `dubbing/${crypto.randomUUID()}.wav`,
      mimeType: 'audio/wav',
      format: 'wav',
      byteLength: 100,
      durationSeconds: 1,
      cueDurationSeconds: 2,
      text: 'New translation',
      model: { providerId: 'flycut:mock', modelId: 'test-tts' },
      language: 'en',
      createdAt: '2026-11-13T10:00:00.000Z',
    };
    await assert.rejects(() => store.writeEdits(created.projectId, created.videoId, {
      chunks,
      deletedWordIds: [],
      languageTracks: [updatedTrack],
      activeLanguageTrackId: 't1',
      dubbings: [validArt],
    }), /unknown language track/);
  } finally {
    await host.close().catch(() => undefined);
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(mp3TempDir, { recursive: true, force: true });
  }
});
