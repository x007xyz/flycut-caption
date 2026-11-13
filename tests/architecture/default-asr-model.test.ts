import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { Plugin } from '@deepseek-ai/cordis';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { ProviderModels } from '../../shared/providers';

const execFileAsync = promisify(execFile);

const SENSEVOICE_ID = 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17';

async function setupWithHome(home: string, appData: string, resourceRoot: string, extraConfig: { modelDiskReserveBytes?: number } = {}, providers?: Plugin[]) {
  const ctx = await createHost(
    { home, appData, token: 'test-credential', port: 0, resourceRoot, ...extraConfig },
    providers ? { providers } : {},
  );
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer test-credential', 'Content-Type': 'application/json' };
  const call = async <T = unknown>(method: string, payload: unknown = {}): Promise<T> => {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`${base}/rpc`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    });
    const envelope = await response.json();
    assert.equal(envelope.rpcId, rpcId);
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const wait = async (id: string, timeoutLoops = 200) => {
    for (let i = 0; i < timeoutLoops; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await setTimeout(25);
    }
    throw new Error(`Job ${id} did not settle`);
  };
  const upload = async (body: Buffer | string) =>
    (await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body })).json()).assetId as string;
  return { home, appData, ctx, base, call, wait, upload, close: () => ctx.fiber.dispose() };
}

test('F-0018/AC-1 AC-2 AC-3 AC-6 AC-8 Host verifies checksums, reports byte progress, cleans cancelled downloads, checks disk space, and deduplicates concurrent prepares', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flycut-f0018-unit-'));
  const home = join(root, 'home');
  const appData = join(root, 'app-data');
  const resRoot = join(root, 'resources');
  await mkdir(join(resRoot, 'src-tauri/binaries'), { recursive: true });
  await mkdir(join(resRoot, 'src-tauri/shared_assets/funasr-fsmn-vad'), { recursive: true });
  await writeFile(join(resRoot, 'src-tauri/binaries', process.platform === 'win32' ? 'funasr-asr.exe' : 'funasr-asr'), 'stub');
  await writeFile(join(resRoot, 'src-tauri/shared_assets/funasr-fsmn-vad/model.onnx'), 'vad');

  const payloadA = Buffer.alloc(64 * 1024, 0x41);
  const payloadB = Buffer.from('0 0\n1 1\n');
  const shaA = createHash('sha256').update(payloadA).digest('hex');
  const shaB = createHash('sha256').update(payloadB).digest('hex');

  let corruptFirst = false;
  let slowMode = false;
  let hitsA = 0;
  let releaseSlow!: () => void;
  const slowGate = () => new Promise<void>(resolve => { releaseSlow = resolve; });

  const mirror = createServer(async (req, res) => {
    if (req.url === '/repo/model.int8.onnx') {
      hitsA += 1;
      const body = corruptFirst ? Buffer.alloc(64 * 1024, 0x42) : payloadA;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
      res.write(body.subarray(0, 16 * 1024));
      if (slowMode) await slowGate();
      res.end(body.subarray(16 * 1024));
      return;
    }
    if (req.url === '/repo/tokens.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(payloadB.length) });
      res.end(payloadB);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => mirror.listen(0, '127.0.0.1', resolve));
  const mirrorPort = (mirror.address() as { port: number }).port;

  const baseManifest = JSON.parse(await readFile(resolve('models.json'), 'utf8'));
  const targetModel = baseManifest.models.find((m: any) => m.id === SENSEVOICE_ID);
  assert.ok(targetModel);
  targetModel.artifact.size_mb_estimate = 1;
  targetModel.files = [
    { path: 'model.int8.onnx', sha256: shaA },
    { path: 'tokens.txt', sha256: shaB },
  ];
  targetModel.download_sources = [
    { region: 'cn', provider: 'local_test', url: `http://127.0.0.1:${mirrorPort}/repo/`, download_mode: 'files' },
  ];
  await writeFile(join(resRoot, 'models.json'), JSON.stringify(baseManifest));

  const prevSidecar = process.env.FLYCUT_FUNASR_SIDECAR;
  delete process.env.FLYCUT_FUNASR_SIDECAR;

  try {
    // 1. Corrupt download must fail SHA-256 verification and refuse transcription
    corruptFirst = true;
    const host1 = await setupWithHome(home, appData, resRoot);
    try {
      const groups1 = await host1.call<ProviderModels[]>('providers.models');
      const sherpa = groups1.find(g => g.provider.id === 'sherpa-onnx');
      assert.ok(sherpa);
      const rec = sherpa.models.filter(m => m.role === 'asr' && m.recommended);
      assert.equal(rec.length, 1);
      assert.equal(rec[0].id, SENSEVOICE_ID);
      assert.equal(rec[0].offline, true);
      assert.equal(rec[0].status, 'download');
      assert.equal(rec[0].recommendation?.benchmarkId, 'F-0001');

      const assetId = await host1.upload('fixture-audio');
      const preVerifyTranscribe = await host1.wait((await host1.call<JobSnapshot>('workflow.start', {
        asr: { providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID, assetId },
      })).id);
      assert.equal(preVerifyTranscribe.status, 'error');
      assert.match(preVerifyTranscribe.error!, /未下载|校验/);

      const badJob = await host1.wait((await host1.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      })).id);
      assert.equal(badJob.status, 'error');
      assert.match(badJob.error!, /SHA-256/);
      assert.equal(existsSync(join(appData, 'models', SENSEVOICE_ID, 'model.int8.onnx')), false);

      // 2. Cancel mid-download cleans up .part files and keeps model status = download
      corruptFirst = false;
      slowMode = true;
      const cancelJob1 = await host1.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      });
      // Concurrent prepare deduplicates to the exact same job
      const cancelJob2 = await host1.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      });
      assert.equal(cancelJob2.id, cancelJob1.id);
      await setTimeout(80);
      const cancelled = await host1.call<JobSnapshot>('jobs.cancel', { id: cancelJob1.id });
      assert.equal(cancelled.status, 'cancelled');
      releaseSlow();
      await setTimeout(30);
      const modelDirFiles = await readdir(join(appData, 'models', SENSEVOICE_ID)).catch(() => [] as string[]);
      assert.ok(!modelDirFiles.some(name => name.endsWith('.part')));
      const afterCancel = (await host1.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(afterCancel.status, 'download');

      // 3. Valid download emits byte progress, passes verification, and marks model ready
      slowMode = false;
      const progressEvents: JobSnapshot[] = [];
      const ws = new WebSocket(`${host1.base.replace('http', 'ws')}/events`, {
        headers: { Authorization: 'Bearer test-credential' },
      });
      ws.on('message', data => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'event' && frame.name === 'job/updated') progressEvents.push(frame.payload.job);
      });
      await new Promise(resolve => ws.once('open', resolve));
      const beforeHits = hitsA;
      const goodJob = await host1.wait((await host1.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      })).id);
      await setTimeout(30);
      ws.terminate();
      assert.equal(goodJob.status, 'complete', goodJob.error);
      assert.equal(hitsA, beforeHits + 1);
      assert.ok(progressEvents.some(j => j.id === goodJob.id && typeof j.progress?.downloadedBytes === 'number' && j.progress.downloadedBytes > 0));
      assert.ok(progressEvents.some(j => j.id === goodJob.id && j.progress?.phase === 'verifying'));
      const readyModel = (await host1.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(readyModel.status, 'ready');

      // Tampering with verified file invalidates locate() and blocks transcription
      await writeFile(join(appData, 'models', SENSEVOICE_ID, 'tokens.txt'), 'corrupted');
      const tamperedModel = (await host1.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(tamperedModel.status, 'download');
    } finally {
      await host1.close();
    }

    // 4. Insufficient disk space fails early with clear error
    const diskFailAppData = join(root, 'app-data-disk-full');
    const host2 = await setupWithHome(join(root, 'home2'), diskFailAppData, resRoot, {
      modelDiskReserveBytes: Number.MAX_SAFE_INTEGER,
    });
    try {
      const diskJob = await host2.wait((await host2.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      })).id);
      assert.equal(diskJob.status, 'error');
      assert.match(diskJob.error!, /磁盘空间不足/);
    } finally {
      await host2.close();
    }
  } finally {
    if (prevSidecar === undefined) delete process.env.FLYCUT_FUNASR_SIDECAR;
    else process.env.FLYCUT_FUNASR_SIDECAR = prevSidecar;
    await new Promise<void>(resolve => mirror.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('F-0018/AC-4 AC-7 fresh install downloads real SenseVoice model, verifies SHA-256, transcribes Chinese talking-head clip, and persists across Host restart', async (t) => {
  const realModelDir = join(homedir(), 'Library/Application Support/com.flycut.caption/models', SENSEVOICE_ID);
  const sidecarPath = resolve('src-tauri/binaries', process.platform === 'win32' ? 'funasr-asr.exe' : 'funasr-asr');
  const ffmpegPath = resolve('src-tauri/binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const fsmnVadFile = resolve('src-tauri/shared_assets/funasr-fsmn-vad/model.onnx');
  const clipMp4 = resolve('tests/media/clips/asr/zh-podcast-3min.mp4');

  if (!existsSync(join(realModelDir, 'model.int8.onnx')) || !existsSync(join(realModelDir, 'tokens.txt'))
    || !existsSync(sidecarPath) || !existsSync(ffmpegPath) || !existsSync(fsmnVadFile) || !existsSync(clipMp4)) {
    t.skip('Real SenseVoice model, sidecar, ffmpeg, FSMN VAD, or zh-podcast-3min.mp4 is missing in this environment');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'flycut-f0018-real-'));
  const home = join(root, 'home');
  const appData = join(root, 'app-data');
  const resRoot = join(root, 'resources');
  await mkdir(resRoot, { recursive: true });
  const wavPath = join(root, 'clip.wav');

  // Extract first 12 seconds as 16kHz mono PCM16 WAV for fast deterministic ASR verification
  await execFileAsync(ffmpegPath, ['-y', '-i', clipMp4, '-t', '12', '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath]);
  const wavBuffer = await readFile(wavPath);

  let modelRequests = 0;
  const staticMirror = createServer((req, res) => {
    const rel = (req.url ?? '').replace(/^\/repo\//, '');
    if (rel !== 'model.int8.onnx' && rel !== 'tokens.txt') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (rel === 'model.int8.onnx') modelRequests += 1;
    const filePath = join(realModelDir, rel);
    const size = statSync(filePath).size;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) });
    createReadStream(filePath).pipe(res);
  });
  await new Promise<void>(resolve => staticMirror.listen(0, '127.0.0.1', resolve));
  const mirrorPort = (staticMirror.address() as { port: number }).port;

  const manifest = JSON.parse(await readFile(resolve('models.json'), 'utf8'));
  const sv = manifest.models.find((m: any) => m.id === SENSEVOICE_ID);
  sv.download_sources = [
    { region: 'cn', provider: 'local_real_mirror', url: `http://127.0.0.1:${mirrorPort}/repo/`, download_mode: 'files' },
  ];
  await writeFile(join(resRoot, 'models.json'), JSON.stringify(manifest));

  const prevSidecar = process.env.FLYCUT_FUNASR_SIDECAR;
  const prevFfmpeg = process.env.FFMPEG_PATH;
  process.env.FLYCUT_FUNASR_SIDECAR = sidecarPath;
  process.env.FFMPEG_PATH = ffmpegPath;

  try {
    const host1 = await setupWithHome(home, appData, resRoot);
    try {
      const before = (await host1.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(before.status, 'download');

      const prepJob = await host1.wait((await host1.call<JobSnapshot>('providers.prepare', {
        providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID,
      })).id, 600);
      assert.equal(prepJob.status, 'complete', prepJob.error);
      assert.equal(modelRequests, 1);

      const after = (await host1.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(after.status, 'ready');
      assert.equal(after.timestampLevel, 'segment');

      const assetId = await host1.upload(wavBuffer);
      const asrJob = await host1.wait((await host1.call<JobSnapshot>('workflow.start', {
        asr: { providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID, assetId, language: 'zh' },
      })).id, 600);
      assert.equal(asrJob.status, 'complete', asrJob.error);
      const transcript = (asrJob.result as { transcript: { text: string; chunks: Array<{ text: string; timestamp: [number, number] }>; hasWordTimestamps?: boolean } }).transcript;
      assert.ok(transcript.text.trim().length > 0, 'Expected non-empty Chinese talking-head transcript');
      assert.ok(/[\u4e00-\u9fff]/.test(transcript.text), `Expected Chinese characters in transcript: ${transcript.text}`);
      assert.ok(transcript.chunks.length > 0);
      assert.ok(transcript.chunks.every(c => c.timestamp[0] >= 0 && c.timestamp[1] > c.timestamp[0]));
    } finally {
      await host1.close();
    }

    // Restart Host on the same home & appData: must remain ready without re-downloading
    const host2 = await setupWithHome(home, appData, resRoot);
    try {
      const restarted = (await host2.call<ProviderModels[]>('providers.models'))
        .find(g => g.provider.id === 'sherpa-onnx')!.models.find(m => m.id === SENSEVOICE_ID)!;
      assert.equal(restarted.status, 'ready');
      assert.equal(modelRequests, 1, 'Host restart must reuse verified local model without re-downloading');
    } finally {
      await host2.close();
    }
  } finally {
    if (prevSidecar === undefined) delete process.env.FLYCUT_FUNASR_SIDECAR;
    else process.env.FLYCUT_FUNASR_SIDECAR = prevSidecar;
    if (prevFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg;
    await new Promise<void>(resolve => staticMirror.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
