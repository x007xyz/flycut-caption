import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { SeparationAnalyzeResult } from '../../shared/separation';

const demucs = process.env.FLYCUT_DEMUCS_BIN ?? join(homedir(), '.cache/flycut-demucs/venv/bin/demucs');
const available = existsSync(demucs);

test('F-0041/AC-1 AC-2 AC-3 Demucs produces cached vocal and background stems', { skip: !available }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0041-'));
  const media = join(home, 'clip.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-ss', '30', '-t', '20',
    '-i', resolve('tests/media/vlog/zh-vlog-film-making.webm'), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0041-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0041-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const models = await call<Array<{ provider: { id: string }; models: Array<{ id: string; role: string; status: string }> }>>('providers.models');
    const model = models.flatMap(group => group.models.map(item => ({ providerId: group.provider.id, ...item })))
      .find(item => item.role === 'separation');
    assert.equal(model?.status, 'ready');
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0041-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0041', videoName: 'clip.mp4', durationSeconds: 20, media: { assetId, mimeType: 'video/mp4' } });
    const job = await call<JobSnapshot>('separation.analyze', { projectId: created.projectId, videoId: created.videoId,
      model: { providerId: model!.providerId, modelId: model!.id } });
    let result: SeparationAnalyzeResult | undefined;
    for (let i = 0; i < 1200; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result as SeparationAnalyzeResult; break; }
      if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(result);
    assert.equal(result.record.sampleRate, 44100);
    assert.ok(Math.abs(result.record.durationSeconds - 20) < 1);
    for (const file of [result.record.vocalsFile, result.record.backgroundFile]) {
      assert.ok((await stat(join(home, 'projects', created.projectId, 'videos', created.videoId, file))).size > 1000);
    }
    const cached = await call<JobSnapshot>('separation.analyze', { projectId: created.projectId, videoId: created.videoId,
      model: { providerId: model!.providerId, modelId: model!.id } });
    let cachedResult: SeparationAnalyzeResult | undefined;
    for (let i = 0; i < 50; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: cached.id });
      if (current.status === 'complete') { cachedResult = current.result as SeparationAnalyzeResult; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(cachedResult);
    assert.equal(cachedResult.record.id, result.record.id);
    console.log(`duration=${result.record.durationSeconds.toFixed(2)} sampleRate=${result.record.sampleRate} cached=true`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
