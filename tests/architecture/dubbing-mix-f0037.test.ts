import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { DubbingMixResult } from '../../shared/tts/dubbing';

function wav(seconds: number, freq: number): Buffer {
  const sr = 44100; const samples = Math.round(sr * seconds); const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0, 'ascii'); data.writeUInt32LE(36 + samples * 2, 4); data.write('WAVE', 8, 'ascii');
  data.write('fmt ', 12, 'ascii'); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36, 'ascii'); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 8000), 44 + i * 2);
  return data;
}

test('F-0037/AC-1 AC-2 dubbing mix validates cues and exports with the mixed audio asset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0037-'));
  const media = join(home, 'src.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const ctx = await createHost({ home, token: 'f0037-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop' });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0037-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0037-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const assetId = ((await upload.json()) as { assetId: string }).assetId;
    const created = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'F-0037', videoName: 'a.mp4', durationSeconds: 4, media: { assetId, mimeType: 'video/mp4' } });
    const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }, { id: 'c2', text: '第二句', timestamp: [2, 4] }];
    const languageTracks = [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
      c1: { text: 'First', sourceText: '第一句', updatedAt: '2026-11-17T00:00:00Z' },
      c2: { text: 'Second', sourceText: '第二句', updatedAt: '2026-11-17T00:00:00Z' } } }];
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, durationSeconds: 4,
      transcript: { text: '第一句第二句', language: 'zh', duration: 4, chunks } });
    const dir = join(home, 'projects', created.projectId, 'videos', created.videoId, 'dubbing');
    await mkdir(dir, { recursive: true });
    const d1 = randomUUID(); const d2 = randomUUID();
    await writeFile(join(dir, `${d1}.wav`), wav(2, 440)); await writeFile(join(dir, `${d2}.wav`), wav(2, 660));
    const now = new Date().toISOString();
    const dubbings = [d1, d2].map((id, index) => ({ id, trackId: 'en', chunkId: index === 0 ? 'c1' : 'c2', file: `dubbing/${id}.wav`,
      mimeType: 'audio/wav', format: 'wav', byteLength: 176444, durationSeconds: 2, cueDurationSeconds: 2,
      text: index === 0 ? 'First' : 'Second', model: { providerId: 'fixture', modelId: 'fixture' },
      language: 'en', createdAt: now }));
    await call('projects.saveVideoEdits', { projectId: created.projectId, videoId: created.videoId, baseRevision: 0, styleSource: 'project',
      edits: { chunks, deletedWordIds: [], languageTracks, activeLanguageTrackId: 'en', dubbings } });
    const mix = await call<JobSnapshot>('dubbing.mix', { projectId: created.projectId, videoId: created.videoId, trackId: 'en', mode: 'dubbing-ducked' });
    let mixResult: DubbingMixResult | undefined;
    for (let i = 0; i < 600; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: mix.id });
      if (current.status === 'complete') { mixResult = current.result as DubbingMixResult; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(mixResult && mixResult.status === 'saved');
    const audio = Buffer.from(await (await fetch(`${base}/assets/${mixResult.assetId}`, { headers: { Authorization: 'Bearer f0037-token' } })).arrayBuffer());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    const exportAsset = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0037-token', 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    const exportAssetId = ((await exportAsset.json()) as { assetId: string }).assetId;
    const exportJob = await call<JobSnapshot>('export.start', { operationId: randomUUID(), assetId: exportAssetId,
      segments: [{ start: 0, end: 4, keep: true }], options: { format: 'mp4', quality: 'low', preserveAudio: true,
        audioAssetId: mixResult.assetId, subtitleProcessing: 'none' } });
    let exportResult: any;
    for (let i = 0; i < 600; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: exportJob.id });
      if (current.status === 'complete') { exportResult = current.result; break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(exportResult?.assetId);
    const output = Buffer.from(await (await fetch(`${base}/assets/${exportResult.assetId}`, { headers: { Authorization: 'Bearer f0037-token' } })).arrayBuffer());
    const outPath = join(home, 'out.mp4'); await writeFile(outPath, output);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', outPath], { encoding: 'utf8' });
    const streams = JSON.parse(probe).streams as Array<{ codec_type: string; duration?: string }>;
    assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    console.log(`mix=${mixResult.durationSeconds.toFixed(2)}s asset=${mixResult.assetId.slice(0, 8)} outputAudio=${streams.find(s => s.codec_type === 'audio')?.duration}`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
