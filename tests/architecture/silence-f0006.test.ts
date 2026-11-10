import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import { ProjectStore } from '../../server/projects/store';
import { DEFAULT_SILENCE_PARAMS } from '../../shared/editing/silence';
import { createEdl, exportSegments } from '../../shared/editing/edl';

test('F-0006 real Host: VAD analysis and export with join fade', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0006-host-'));
  const store = new ProjectStore(home);
  const source = resolve('tests/media/clips/silence/en-wikimania-gaps-2.5min.webm');
  const info = await stat(source);
  const project = await store.create({ name: 'F-0006 real', video: { name: 'demo.webm', durationSeconds: 157.11, model: undefined },
    media: async (_projectId, videoId) => ({ kind: 'stored', file: `media/${videoId}.mp4`, size: info.size, mimeType: 'video/mp4' }) });
  const video = project.videos[0];
  const media = store.mediaFile(project.id, video.media.kind === 'stored' ? video.media.file : '');
  await mkdir(dirname(media), { recursive: true });
  await copyFile(source, media);
  await store.writeTranscript(project.id, video.id, {
    text: 'demo', language: 'en', duration: 157.11, hasWordTimestamps: false,
    chunks: [{ id: 'c1', text: 'demo', timestamp: [0, 157.11] }], wordChunks: [],
  });
  const ctx = await createHost({ home, token: 'f0006', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0006', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  try {
    const job = await call('silence.analyze', { projectId: project.id, videoId: video.id,
      model: { providerId: 'sherpa-onnx', modelId: 'fsmn-vad' }, params: DEFAULT_SILENCE_PARAMS });
    let state = job;
    const deadline = Date.now() + 60_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'VAD analysis timeout');
      await new Promise(r => setTimeout(r, 50));
      state = await call('jobs.get', { id: job.id });
    }
    assert.equal(state.status, 'complete', state.error);
    assert.equal(state.result.vadType, 'fsmn');
    assert.ok(state.result.durationSeconds > 156 && state.result.durationSeconds < 158);
    assert.ok(state.result.candidates.length > 0);

    const edl = createEdl(157.11, [{ start: 30, end: 50 }]);
    const exportJob = await call('export.start', { assetId: (await (await fetch(base + '/assets', { method: 'POST',
      headers: { Authorization: 'Bearer f0006' }, body: await readFile(source) })).json()).assetId,
      edl, segments: exportSegments(edl),
      options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'none', joinFadeMs: 5 } });
    state = exportJob;
    const exportDeadline = Date.now() + 60_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < exportDeadline, 'export timeout');
      await new Promise(r => setTimeout(r, 50));
      state = await call('jobs.get', { id: exportJob.id });
    }
    assert.equal(state.status, 'complete', state.error);
    assert.ok(await stat(ctx.assets.path(state.result.assetId)).then(() => true, () => false));
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0006 real Host: a second real talking-head clip also analyzes', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0006-host2-'));
  const store = new ProjectStore(home);
  const source = resolve('tests/media/clips/dub/zh-podcast-host-1min.mp4');
  const info = await stat(source);
  const project = await store.create({ name: 'F-0006 real 2', video: { name: 'podcast.mp4', durationSeconds: 60, model: undefined },
    media: async (_projectId, videoId) => ({ kind: 'stored', file: `media/${videoId}.mp4`, size: info.size, mimeType: 'video/mp4' }) });
  const video = project.videos[0];
  const media = store.mediaFile(project.id, video.media.kind === 'stored' ? video.media.file : '');
  await mkdir(dirname(media), { recursive: true });
  await copyFile(source, media);
  await store.writeTranscript(project.id, video.id, {
    text: 'demo', language: 'zh', duration: 60, hasWordTimestamps: false,
    chunks: [{ id: 'c1', text: 'demo', timestamp: [0, 60] }], wordChunks: [],
  });
  const ctx = await createHost({ home, token: 'f0006b', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0006b', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  try {
    const job = await call('silence.analyze', { projectId: project.id, videoId: video.id,
      model: { providerId: 'sherpa-onnx', modelId: 'fsmn-vad' }, params: DEFAULT_SILENCE_PARAMS });
    let state = job;
    const deadline = Date.now() + 60_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'VAD analysis timeout');
      await new Promise(r => setTimeout(r, 50));
      state = await call('jobs.get', { id: job.id });
    }
    assert.equal(state.status, 'complete', state.error);
    assert.ok(state.result.durationSeconds > 59 && state.result.durationSeconds < 61);
    assert.ok(Array.isArray(state.result.candidates));
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0006 real Host: missing media and no-audio fail explicitly', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0006-errors-'));
  const store = new ProjectStore(home);
  const videoOnly = join(home, 'silent.mp4');
  const made = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-an', videoOnly], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const project = await store.create({ name: 'F-0006 errors', video: { name: 'silent.mp4', durationSeconds: 2, model: undefined },
    media: async (_projectId, videoId) => ({ kind: 'stored', file: `media/${videoId}.mp4`, size: 1, mimeType: 'video/mp4' }) });
  const video = project.videos[0];
  const media = store.mediaFile(project.id, video.media.kind === 'stored' ? video.media.file : '');
  await mkdir(dirname(media), { recursive: true });
  await copyFile(videoOnly, media);
  await store.writeTranscript(project.id, video.id, {
    text: 'demo', language: 'zh', duration: 2, hasWordTimestamps: false,
    chunks: [{ id: 'c1', text: 'demo', timestamp: [0, 2] }], wordChunks: [],
  });
  const ctx = await createHost({ home, token: 'f0006e', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0006e', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  const wait = async (job: { id: string }) => {
    let state = job;
    const deadline = Date.now() + 30_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'job timeout');
      await new Promise(r => setTimeout(r, 30));
      state = await call('jobs.get', { id: job.id });
    }
    return state;
  };
  try {
    const noAudio = await wait(await call('silence.analyze', { projectId: project.id, videoId: video.id,
      model: { providerId: 'sherpa-onnx', modelId: 'fsmn-vad' }, params: DEFAULT_SILENCE_PARAMS }));
    assert.equal(noAudio.status, 'error');
    assert.match(noAudio.error, /Audio|audio|音轨|FFmpeg/i);

    await rm(media, { force: true });
    const missing = await wait(await call('silence.analyze', { projectId: project.id, videoId: video.id,
      model: { providerId: 'sherpa-onnx', modelId: 'fsmn-vad' }, params: DEFAULT_SILENCE_PARAMS }));
    assert.equal(missing.status, 'error');
    assert.match(missing.error, /媒体缺失|missing/i);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
