import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { separationAnalyzeInputSchema, type SeparationAnalyzeResult, type SeparationRecord } from '../../shared/separation';
import { sendFile } from './projects';
import type { Provider } from '../services';

const execFileAsync = promisify(execFile);
const STEM_ROUTE = /^\/projects\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\/separation\/([0-9a-f-]{36})\/(vocals|background)$/i;

function wavInfo(bytes: Buffer) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Demucs 输出不是 WAV');
  let offset = 12; let sampleRate = 0; let channels = 0; let bits = 0; let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); offset += 8;
    if (name === 'fmt ') { channels = bytes.readUInt16LE(offset + 2); sampleRate = bytes.readUInt32LE(offset + 4); bits = bytes.readUInt16LE(offset + 14); }
    if (name === 'data') { dataBytes = size; break; }
    offset += size + size % 2;
  }
  if (!sampleRate || !channels || !bits) throw new Error('WAV 头无效');
  return { sampleRate, durationSeconds: dataBytes / (sampleRate * channels * (bits / 8)) };
}

export const separationPlugin = { name: 'flycut-separation', inject: ['hostConfig', 'providers', 'rpc', 'jobs', 'projectStore'], apply(ctx: Context) {
  const store = ctx.projectStore;
  const python = process.env.FLYCUT_DEMUCS_PYTHON ?? join(homedir(), '.cache/flycut-demucs/venv/bin/python');
  const script = process.env.FLYCUT_DEMUCS_BIN ?? join(homedir(), '.cache/flycut-demucs/venv/bin/demucs');
  const ready = async () => (await access(python).then(() => true).catch(() => false)) && (await access(script).then(() => true).catch(() => false));
  const resolveFfmpeg = async () => {
    const bundled = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const dev = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    for (const candidate of [process.env.FFMPEG_PATH, bundled, dev]) {
      if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return 'ffmpeg';
  };

  const provider: Provider = { id: 'demucs-local', name: 'Demucs 本地', kind: 'builtin',
    async models() {
      const available = await ready();
      return [{ id: 'htdemucs', name: 'HTDemucs', role: 'separation', languages: ['auto'], offline: true,
        description: '本地人声/背景分离（Demucs MIT）', status: available ? 'ready' : 'unavailable',
        ...(available ? {} : { reason: `缺少 Demucs：${script}（设置 FLYCUT_DEMUCS_BIN）` }) }];
    },
    async separate(_modelId, audioPath, _signal, report) {
      if (!await ready()) throw new Error('Demucs 未安装');
      report({ status: 'running', progress: 10, data: '人声分离中…' });
      const out = join(tmpdir(), `flycut-demucs-${randomUUID()}`);
      await mkdir(out, { recursive: true });
      try {
        await execFileAsync(script, ['--two-stems=vocals', '-n', 'htdemucs', '-o', out, audioPath], { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
        const base = audioPath.split('/').pop()!.replace(/\.[^.]+$/, '');
        const vocals = await readFile(join(out, 'htdemucs', base, 'vocals.wav'));
        const background = await readFile(join(out, 'htdemucs', base, 'no_vocals.wav'));
        const info = wavInfo(vocals);
        report({ status: 'complete', progress: 100, data: '人声分离完成' });
        return { vocals, background, ...info };
      } finally { await rm(out, { recursive: true, force: true }).catch(() => undefined); }
    } };
  ctx.effect(() => ctx.providers.register(provider));

  ctx.effect(() => ctx.rpc.register('separation.analyze', separationAnalyzeInputSchema, input =>
    ctx.jobs.create(async (signal, report): Promise<SeparationAnalyzeResult> => {
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(input.projectId, input.videoId) ?? { chunks: [], deletedWordIds: [] };
      const fingerprint = JSON.stringify([video.media, video.durationSeconds]);
      const existing = edits.separation;
      if (existing && existing.sourceFingerprint === fingerprint && existing.model.providerId === input.model.providerId
        && existing.model.modelId === input.model.modelId
        && await access(store.separationDir(input.projectId, input.videoId, existing.id)).then(() => true).catch(() => false)) {
        return { status: 'saved', record: existing, videoRevision: video.revision, projectRevision: project.revision, updatedAt: existing.createdAt };
      }
      const media = video.media.kind === 'stored' ? store.mediaFile(input.projectId, video.media.file) : video.media.path;
      const wav = join(tmpdir(), `flycut-separation-${randomUUID()}.wav`);
      try {
        report({ status: 'running', progress: 3, data: '提取音频…' });
        await execFileAsync(await resolveFfmpeg(), ['-v', 'error', '-y', '-i', media, '-vn', '-ar', '44100', '-ac', '2', wav], { timeout: 300_000, signal });
        const stems = await ctx.providers.separate(input.model, wav, signal, report);
        signal.throwIfAborted();
        const id = randomUUID();
        const dir = store.separationDir(input.projectId, input.videoId, id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'vocals.wav'), stems.vocals);
        await writeFile(join(dir, 'background.wav'), stems.background);
        const record: SeparationRecord = { id, model: input.model, vocalsFile: `separation/${id}/vocals.wav`, backgroundFile: `separation/${id}/background.wav`,
          durationSeconds: stems.durationSeconds, sampleRate: stems.sampleRate, sourceFingerprint: fingerprint, createdAt: new Date().toISOString() };
        return store.exclusive(input.projectId, async () => {
          const current = await store.read(input.projectId);
          const currentVideo = current.videos.find(item => item.id === input.videoId)!;
          const currentEdits = await store.readEdits(input.projectId, input.videoId) ?? edits;
          await store.writeEdits(input.projectId, input.videoId, { ...currentEdits, separation: record });
          currentVideo.revision += 1; currentVideo.updatedAt = record.createdAt;
          current.revision += 1; current.updatedAt = record.createdAt;
          await store.writeProject(current);
          return { status: 'saved' as const, record, videoRevision: currentVideo.revision, projectRevision: current.revision, updatedAt: record.createdAt };
        });
      } finally { await rm(wav, { force: true }).catch(() => undefined); }
    })));

  ctx.effect(() => ctx.rpc.route({ method: 'GET', pattern: STEM_ROUTE, auth: 'client', queryToken: true,
    async handle(req, res, match) {
      const [, projectId, videoId, id, stem] = match;
      const project = await store.read(projectId).catch(() => undefined);
      if (!project || project.deletedAt) { res.writeHead(404); res.end(); return; }
      const edits = await store.readEdits(projectId, videoId).catch(() => undefined);
      const record = edits?.separation;
      if (!record || record.id !== id) { res.writeHead(404); res.end(); return; }
      const file = join(store.separationDir(projectId, videoId, id), `${stem}.wav`);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) { res.writeHead(404); res.end(); return; }
      await sendFile(req, res, file, 'audio/wav');
    } }));
} };
