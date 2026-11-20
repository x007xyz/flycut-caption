import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { LanguageTrack } from '../../shared/languageTracks';
import type { JobSnapshot } from '../../shared/protocol';
import type { SubtitleChunk } from '../../src/types/subtitle';
import { buildSoftSubtitleTracks } from '../../src/subtitle/softSubtitles';

const dir = await mkdtemp(join(tmpdir(), 'flycut-f0033-real-'));
const token = randomUUID();
const ffmpeg = process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg');
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const ctx = await createHost({ home: dir, appData: dir, bind: '127.0.0.1', port: 0, token, resourceRoot: resolve('.'),
  assetTtlHours: 1 }, { profile: 'desktop', providers: [] });
const auth = { Authorization: `Bearer ${token}` };
const address = ctx.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Host port missing');
const base = `http://127.0.0.1:${address.port}`;
const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
  return envelope.result.value;
};

try {
  const media = join(dir, 'sample.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media]);
  const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { ...auth, 'Content-Type': 'video/mp4' },
    body: new Uint8Array(await readFile(media)) });
  const createAssetId = ((await upload.json()) as { assetId: string }).assetId;
  const ids = await call<{ projectId: string; videoId: string }>('projects.create', {
    name: 'F-0033 多语软字幕', videoName: 'sample.mp4', durationSeconds: 3, media: { assetId: createAssetId, mimeType: 'video/mp4' } });
  const exportUpload = await fetch(`${base}/assets`, { method: 'POST', headers: { ...auth, 'Content-Type': 'video/mp4' },
    body: new Uint8Array(await readFile(media)) });
  const assetId = ((await exportUpload.json()) as { assetId: string }).assetId;
  const chunks: SubtitleChunk[] = [
    { id: 'c1', text: '第一句', timestamp: [0, 1] },
    { id: 'c2', text: '第二句', timestamp: [1, 2] },
    { id: 'c3', text: '第三句', timestamp: [2, 3] },
  ];
  const languageTracks: LanguageTrack[] = [
    { id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
      c1: { text: 'First', sourceText: '第一句', updatedAt: '2026-11-16T00:00:00Z' },
      c2: { text: 'Second', sourceText: '第二句', updatedAt: '2026-11-16T00:00:00Z' },
      c3: { text: 'Third', sourceText: '第三句', updatedAt: '2026-11-16T00:00:00Z' } } },
    { id: 'ja', name: 'Japanese', languageCode: 'ja', origin: 'manual', entries: {
      c1: { text: '一番', sourceText: '第一句', updatedAt: '2026-11-16T00:00:00Z' },
      c2: { text: '二番', sourceText: '第二句', updatedAt: '2026-11-16T00:00:00Z' },
      c3: { text: '三番', sourceText: '第三句', updatedAt: '2026-11-16T00:00:00Z' } } },
  ];
  await call('projects.saveTranscript', { ...ids, durationSeconds: 3, transcript: { text: '第一句第二句第三句', language: 'zh', duration: 3, chunks } });
  await call('projects.saveVideoEdits', { projectId: ids.projectId, videoId: ids.videoId, baseRevision: 0, styleSource: 'project',
    edits: { chunks, deletedWordIds: [], languageTracks, activeLanguageTrackId: 'en' } });

  const segments = [{ start: 0, end: 1, keep: true }, { start: 1, end: 1.5, keep: false }, { start: 1.5, end: 3, keep: true }];
  const built = buildSoftSubtitleTracks({ chunks, keptSegments: segments, languageTracks, activeTrackId: 'en',
    primaryLanguage: 'zh', selectedIds: ['primary', 'en', 'ja'], allowPartial: false });
  if (built.tracks.length !== 3) throw new Error(`expected 3 tracks, got ${built.tracks.length}`);

  const runExport = async (format: 'mp4' | 'mkv' | 'webm') => {
    const started = await call<JobSnapshot>('export.start', { operationId: randomUUID(), assetId,
      segments, options: { format, quality: 'medium', preserveAudio: true, subtitleProcessing: 'soft', subtitleTracks: built.tracks } });
    for (let i = 0; i < 1200; i += 1) {
      const job = await call<JobSnapshot>('jobs.get', { id: started.id });
      if (job.status === 'complete') return job;
      if (job.status === 'error' || job.status === 'cancelled') return job;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${format} export timed out`);
  };

  const verify = async (format: 'mp4' | 'mkv') => {
    const job = await runExport(format);
    if (job.status !== 'complete') throw new Error(`${format} export failed: ${job.error ?? job.status}`);
    const result = job.result as { assetId: string };
    const response = await fetch(`${base}/assets/${result.assetId}`, { headers: auth });
    const bytes = Buffer.from(await response.arrayBuffer());
    const output = join(dir, `out.${format}`);
    await writeFile(output, bytes);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' })) as {
      streams: Array<{ codec_type: string; tags?: Record<string, string>; disposition?: Record<string, number> }> };
    const subtitles = probe.streams.filter(stream => stream.codec_type === 'subtitle');
    if (subtitles.length !== 3) throw new Error(`${format}: expected 3 subtitle tracks, got ${subtitles.length}`);
    const tags = subtitles.map(stream => stream.tags?.language ?? '?');
    if (!tags.includes('eng') || !tags.includes('jpn')) throw new Error(`${format}: wrong language tags ${tags.join(',')}`);
    if (format === 'mkv') {
      const titles = subtitles.map(stream => stream.tags?.title ?? '?');
      if (!titles.includes('English') || !titles.includes('Japanese')) throw new Error(`mkv: wrong titles ${titles.join(',')}`);
    }
    const defaultIndex = subtitles.findIndex(stream => stream.disposition?.default === 1);
    if (defaultIndex !== 1) throw new Error(`${format}: default track is ${defaultIndex}`);
    const vtt = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:s:0', '-f', 'webvtt', '-'], { encoding: 'utf8' });
    const starts = [...vtt.matchAll(/(\d+):(\d+)\.(\d+)/g)].map(match => Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000);
    if (!starts.some(value => Math.abs(value - 1.5) < 0.05)) throw new Error(`${format}: EDL timing not applied\n${vtt}`);
    if (!vtt.includes('第三句')) throw new Error(`${format}: primary track text missing`);
    console.log(`${format}: 3 tracks, ${tags.join(', ')}, default=${defaultIndex}, EDL timing ok`);
  };

  await verify('mp4');
  await verify('mkv');
  const webm = await runExport('webm');
  if (webm.status !== 'error' || !String(webm.error).includes('WebM 只支持一条软字幕轨')) {
    throw new Error(`webm multi-track was not rejected: ${webm.status} ${webm.error}`);
  }
  console.log('webm multi-track rejected');
  console.log('F-0033 real acceptance passed');
} finally {
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}
