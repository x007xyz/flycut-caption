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
import type { ReframeRecord } from '../../shared/reframe/reframe';

const model = process.env.FLYCUT_REFRAME_MODEL ?? join(homedir(), '.cache/flycut-reframe/models/face_detection_yunet_2023mar.onnx');
const available = existsSync(model);

test('F-0048/AC-1 AC-2 Host detects faces and persists a smoothed subject crop path', { skip: !available }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0048-'));
  const media = join(home, 'clip.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-ss', '30', '-t', '3',
    '-i', resolve('tests/media/vlog/zh-vlog-film-making.webm'), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0048-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0048-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0048-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0048', videoName: 'clip.mp4', durationSeconds: 3, media: { assetId, mimeType: 'video/mp4' } });
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 3,
      transcript: { text: '测试', language: 'zh', duration: 3, chunks: [{ id: 'c1', text: '测试', timestamp: [0, 3] }] } });
    await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
      edits: { chunks: [{ id: 'c1', text: '测试', timestamp: [0, 3] }], deletedWordIds: [] } });
    const job = await call<JobSnapshot>('reframe.analyze', { projectId: created.projectId, videoId: created.videoId, fps: 2 });
    let result: ReframeRecord | undefined;
    for (let i = 0; i < 1200; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { result = current.result as ReframeRecord; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(result);
    assert.ok(result.samples.length > 0);
    assert.ok(result.samples.every(sample => sample.centerX >= 0 && sample.centerX <= 640));
    const opened = await call<ProjectOpenResult>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    if (opened.status !== 'ok') throw new Error('open failed');
    assert.equal(opened.edits?.reframe?.samples.length, result.samples.length);
    console.log(`samples=${result.samples.length} fps=${result.fps}`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
