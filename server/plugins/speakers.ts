import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { speakerAnalyzeInputSchema, speakerNamesInputSchema, speakerVoicesInputSchema, type SpeakerAnalyzeResult } from '../../shared/speakers';
import { speakerSegmentSchema } from '../../shared/speakers';
import type { Provider } from '../services';

const execFileAsync = promisify(execFile);

export const speakersPlugin = { name: 'flycut-speakers', inject: ['hostConfig', 'providers', 'rpc', 'jobs', 'projectStore'], apply(ctx: Context) {
  const store = ctx.projectStore;
  const modelDir = process.env.FLYCUT_SPEAKER_MODEL_DIR ?? join(homedir(), '.cache/flycut-speaker/models');
  const python = process.env.FLYCUT_SPEAKER_PYTHON ?? join(homedir(), '.cache/flycut-speaker/venv/bin/python');
  const script = join(ctx.hostConfig.resourceRoot, 'scripts/examples/diarize_sherpa.py');
  const ready = async () => (await access(python).then(() => true).catch(() => false))
    && (await access(join(modelDir, 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx')).then(() => true).catch(() => false))
    && (await access(join(modelDir, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx')).then(() => true).catch(() => false));
  const resolveFfmpeg = async () => {
    const bundled = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const dev = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    for (const candidate of [process.env.FFMPEG_PATH, bundled, dev]) {
      if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return 'ffmpeg';
  };

  const provider: Provider = {
    id: 'sherpa-diarization', name: 'sherpa-onnx 说话人分离', kind: 'builtin',
    async models() {
      const available = await ready();
      return [{ id: 'pyannote-3dspeaker', name: 'Pyannote + 3D-Speaker', role: 'speaker', languages: ['zh', 'en'],
        description: '本地说话人分离与声纹聚类', status: available ? 'ready' : 'unavailable', offline: true,
        ...(available ? {} : { reason: `缺少分离模型或 Python：${modelDir} / ${python}（设置 FLYCUT_SPEAKER_MODEL_DIR、FLYCUT_SPEAKER_PYTHON）` }) }];
    },
    async diarize(_modelId, audioPath, signal, report) {
      if (!await ready()) throw new Error('说话人模型未就绪');
      report({ status: 'running', progress: 10, data: '说话人分离中…' });
      const { stdout } = await execFileAsync(python, [script, '--wav', audioPath, '--model-dir', modelDir],
        { timeout: 900_000, maxBuffer: 32 * 1024 * 1024, signal });
      const parsed = JSON.parse(stdout) as { duration: number; segments: unknown[] };
      const segments = parsed.segments.map(item => speakerSegmentSchema.parse(item))
        .sort((a, b) => a.start - b.start);
      for (const segment of segments) {
        if (segment.end > parsed.duration + 0.1) throw new Error('说话人区间超出音频时长');
      }
      report({ status: 'complete', progress: 100, data: '说话人分离完成' });
      return { duration: parsed.duration, segments };
    },
  };
  ctx.effect(() => ctx.providers.register(provider));

  ctx.effect(() => ctx.rpc.register('speakers.saveNames', speakerNamesInputSchema, ({ projectId, videoId, names }) =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      const video = project.videos.find(item => item.id === videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(projectId, videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const now = new Date().toISOString();
      await store.writeEdits(projectId, videoId, { ...edits, speakerNames: names });
      video.revision += 1; video.updatedAt = now;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved' as const, videoRevision: video.revision, projectRevision: project.revision, updatedAt: now };
    })));

  ctx.effect(() => ctx.rpc.register('speakers.saveVoices', speakerVoicesInputSchema, ({ projectId, videoId, voices }) =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      const video = project.videos.find(item => item.id === videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(projectId, videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const now = new Date().toISOString();
      await store.writeEdits(projectId, videoId, { ...edits, speakerVoices: voices });
      video.revision += 1; video.updatedAt = now;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved' as const, videoRevision: video.revision, projectRevision: project.revision, updatedAt: now };
    })));

  ctx.effect(() => ctx.rpc.register('speakers.analyze', speakerAnalyzeInputSchema, input =>
    ctx.jobs.create(async (signal, report): Promise<SpeakerAnalyzeResult> => {
      report({ status: 'running', progress: 3, data: '读取项目…' });
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(input.projectId, input.videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const media = video.media.kind === 'stored' ? store.mediaFile(input.projectId, video.media.file) : video.media.path;
      const wav = join(tmpdir(), `flycut-speakers-${randomUUID()}.wav`);
      await mkdir(tmpdir(), { recursive: true });
      try {
        report({ status: 'running', progress: 8, data: '提取 16 kHz 音频…' });
        await execFileAsync(await resolveFfmpeg(), ['-v', 'error', '-y', '-i', media, '-vn', '-ar', '16000', '-ac', '1', wav],
          { timeout: 300_000, signal });
        const result = await ctx.providers.diarize(input.model, wav, signal, report);
        signal.throwIfAborted();
        return store.exclusive(input.projectId, async () => {
          const current = await store.read(input.projectId);
          const currentVideo = current.videos.find(item => item.id === input.videoId);
          if (!currentVideo) throw new Error('视频不存在');
          const currentEdits = await store.readEdits(input.projectId, input.videoId) ?? edits;
          const names = { ...(currentEdits.speakerNames ?? {}) };
          for (const segment of result.segments) names[segment.speaker] ??= `说话人 ${segment.speaker}`;
          const now = new Date().toISOString();
          await store.writeEdits(input.projectId, input.videoId, { ...currentEdits, speakerSegments: result.segments, speakerNames: names });
          currentVideo.revision += 1; currentVideo.updatedAt = now;
          current.revision += 1; current.updatedAt = now;
          await store.writeProject(current);
          return { status: 'saved', segments: result.segments, speakerCount: new Set(result.segments.map(item => item.speaker)).size,
            durationSeconds: result.duration, videoRevision: currentVideo.revision, projectRevision: current.revision, updatedAt: now };
        });
      } finally { await rm(wav, { force: true }).catch(() => undefined); }
    })));
} };
