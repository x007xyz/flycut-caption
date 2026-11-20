import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { ProjectOpenResult } from '../../shared/projects';
import type { SpeakerAnalyzeResult } from '../../shared/speakers';

const python = process.env.FLYCUT_SPEAKER_PYTHON ?? join(homedir(), '.cache/flycut-speaker/venv/bin/python');
const modelDir = process.env.FLYCUT_SPEAKER_MODEL_DIR ?? join(homedir(), '.cache/flycut-speaker/models');
const available = existsSync(python) && existsSync(join(modelDir, 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx'));

test('F-0021/AC-1 AC-2 AC-3 local diarization finds stable speakers and persists segments', { skip: !available }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0021-'));
  const source = resolve('tests/media/zh-press/zh-cppcc-press-2020.webm');
  const media = join(home, 'clip.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-ss', '30', '-t', '60', '-i', source,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0021-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0021-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const models = await call<Array<{ provider: { id: string }; models: Array<{ id: string; role: string; status: string }> }>>('providers.models');
    const speakerModel = models.flatMap(group => group.models.map(item => ({ providerId: group.provider.id, ...item })))
      .find(item => item.role === 'speaker');
    assert.equal(speakerModel?.status, 'ready');
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0021-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0021', videoName: 'clip.mp4', durationSeconds: 60, media: { assetId, mimeType: 'video/mp4' } });
    const chunks = [{ id: 'c1', text: '测试', timestamp: [0, 60] }];
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 60,
      transcript: { text: '测试', language: 'zh', duration: 60, chunks } });
    await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0,
      styleSource: 'project', edits: { chunks, deletedWordIds: [] } });
    const job = await call<JobSnapshot>('speakers.analyze', { projectId: created.projectId, videoId: created.videoId,
      model: { providerId: speakerModel!.providerId, modelId: speakerModel!.id } });
    let result: SpeakerAnalyzeResult | undefined;
    for (let i = 0; i < 1200; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result as SpeakerAnalyzeResult; break; }
      if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(result);
    assert.ok(result.speakerCount >= 2, `expected >=2 speakers, got ${result.speakerCount}`);
    assert.ok(result.segments.length > 0);
    const opened = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    if (opened.status !== 'ok') throw new Error('open failed');
    assert.equal(opened.edits?.speakerSegments?.length, result.segments.length);
    assert.ok(Object.keys(opened.edits?.speakerNames ?? {}).length >= 2);
    console.log(`speakers=${result.speakerCount} segments=${result.segments.length} duration=${result.durationSeconds.toFixed(2)}`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
