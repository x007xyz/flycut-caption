import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { ProjectOpenResult } from '../../shared/projects';
import type { TrackDubResult } from '../../shared/tts/dubbing';

const ffmpeg = process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg');
const source = resolve('tests/media/clips/asr/zh-podcast-3min.mp4');
const dir = await mkdtemp(join(tmpdir(), 'flycut-f0036-real-'));
const media = join(dir, 'long.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-stream_loop', '3', '-i', source, '-t', '720', '-c', 'copy', media]);
const tts: ChildProcess = spawn(process.execPath, ['scripts/examples/tts-provider-server.mjs', '--port', '9076'], { stdio: 'ignore' });
await new Promise(done => setTimeout(done, 500));
const home = await mkdtemp(join(tmpdir(), 'flycut-f0036-host-'));
const token = randomUUID();
const ctx = await createHost({ home, appData: home, bind: '127.0.0.1', port: 0, token, resourceRoot: resolve('.') }, {
  profile: 'desktop', patches: [{ source: 'f0036-real', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }] });
const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
  return envelope.result.value;
};
try {
  await call('endpoints.save', { name: 'tts-ref', label: 'TTS Reference', protocol: 'flycut', baseUrl: 'http://127.0.0.1:9076', timeoutSeconds: 30 });
  const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' },
    body: new Uint8Array(await (await import('node:fs/promises')).readFile(media)) });
  const assetId = ((await upload.json()) as { assetId: string }).assetId;
  const created = await call<{ projectId: string; videoId: string }>('projects.create', {
    name: 'F-0036 12分钟真实验收', videoName: 'long.mp4', durationSeconds: 720, media: { assetId, mimeType: 'video/mp4' } });
  const chunks = Array.from({ length: 12 }, (_, index) => ({ id: `c${index + 1}`, text: `第${index + 1}句`, timestamp: [index * 60, index * 60 + 30] as [number, number] }));
  const longText = 'This translation is intentionally much longer than the thirty second cue so it must be marked unresolved instead of being truncated or pushed into the next cue';
  const entries = Object.fromEntries(chunks.map((chunk, index) => [chunk.id, { text: index % 3 === 2 ? longText : `Short line ${index + 1}`, sourceText: chunk.text, updatedAt: '2026-11-17T00:00:00Z' }]));
  const languageTracks = [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries }];
  await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 720,
    transcript: { text: chunks.map(chunk => chunk.text).join(''), language: 'zh', duration: 720, chunks } });
  await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
    edits: { chunks, deletedWordIds: [], languageTracks, activeLanguageTrackId: 'en' } });
  const opened = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
  if (opened.status !== 'ok') throw new Error('open failed');
  const job = await call<JobSnapshot>('dubbing.alignTrack', { projectId: created.projectId, videoId: created.videoId, trackId: 'en',
    baseVideoRevision: opened.video.revision, maxSpeed: 1.25, cues: chunks.map(chunk => ({ chunkId: chunk.id, expectedText: entries[chunk.id].text })),
    request: { providerId: 'flycut:tts-ref', modelId: 'kokoro-demo', language: 'en', voiceId: 'af_heart' } });
  let result: TrackDubResult | undefined;
  for (let i = 0; i < 600; i += 1) {
    const current = await call<JobSnapshot>('jobs.get', { id: job.id });
    if (current.status === 'complete') { result = current.result as TrackDubResult; break; }
    if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
    await new Promise(done => setTimeout(done, 100));
  }
  if (!result || result.status !== 'saved') throw new Error('not saved');
  const after = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
  if (after.status !== 'ok') throw new Error('open after failed');
  const dubbings = after.edits?.dubbings ?? [];
  for (const item of dubbings) {
    if (item.durationSeconds > item.cueDurationSeconds + 0.01) throw new Error(`cue ${item.chunkId} overlaps the next cue`);
    await stat(join(home, 'projects', created.projectId, 'videos', created.videoId, item.file));
  }
  console.log(`cues=${chunks.length} saved=${result.artifacts.length} unresolved=${result.unresolved.length}`);
  console.log(`first=${dubbings.some(item => item.chunkId === 'c1')} last=${dubbings.some(item => item.chunkId === 'c12')}`);
  console.log(`max duration ratio=${Math.max(...dubbings.map(item => item.durationSeconds / item.cueDurationSeconds)).toFixed(3)}`);
  console.log('F-0036 real 12-minute acceptance passed');
} finally {
  tts.kill();
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
