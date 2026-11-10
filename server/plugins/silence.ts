import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { modelRefSchema } from '../../shared/providers';
import { generateSilenceCandidates, type SilenceParams } from '../../shared/editing/silence';
import { ProjectStore } from '../projects/store';

const paramsSchema = z.strictObject({
  minPauseSeconds: z.number().finite().positive(),
  guardSeconds: z.number().finite().nonnegative(),
  mode: z.enum(['shorten', 'remove']),
  retainSeconds: z.number().finite().nonnegative(),
});
export const silenceAnalyzeSchema = z.strictObject({
  projectId: z.uuid(), videoId: z.uuid(), model: modelRefSchema, params: paramsSchema,
});
export type SilenceAnalyzeInput = z.infer<typeof silenceAnalyzeSchema>;

function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr.split('\n').slice(-5).join('\n') || 'FFmpeg exited with ' + code)));
  });
}

/** F-0006: Host-only VAD analysis. It resolves media by project/video IDs and never accepts a path. */
export const silencePlugin = { name: 'flycut-silence-analysis', inject: ['hostConfig', 'providers', 'jobs', 'rpc'], apply(ctx: Context) {
  const store = new ProjectStore(ctx.hostConfig.home);
  const ffmpeg = process.env.FFMPEG_PATH ?? join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  ctx.effect(() => ctx.rpc.register('silence.analyze', silenceAnalyzeSchema, input =>
    ctx.jobs.create(async (signal, report) => {
      report({ status: 'running', data: '读取项目…', progress: 5 });
      const project = await store.read(input.projectId);
      if (project.deletedAt) throw new Error('项目在回收站中');
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) throw new Error('视频不存在');
      const media = video.media.kind === 'stored' ? store.mediaFile(project.id, video.media.file) : video.media.path;
      const info = await stat(media).catch(() => undefined);
      if (!info?.isFile()) throw new Error('项目媒体缺失，请重新选择文件');
      const transcript = await store.readTranscript(project.id, video.id);
      if (!transcript || !transcript.duration) throw new Error('视频还没有可用的转写');
      const edits = await store.readEdits(project.id, video.id);
      const existingDeleted = edits?.editing?.edl.deleted.map(range => ({ start: range.startUs / 1e6, end: range.endUs / 1e6 })) ?? [];
      signal.throwIfAborted();

      const dir = await mkdtemp(join(tmpdir(), 'flycut-silence-'));
      const wav = join(dir, 'audio.wav');
      try {
        report({ status: 'running', data: '提取音频…', progress: 10 });
        await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], signal);
        signal.throwIfAborted();
        report({ status: 'running', data: '检测人声…', progress: 20 });
        const voice = await ctx.providers.detectVoice(input.model, wav, signal, report);
        if (Math.abs(voice.duration - transcript.duration) > 0.1) throw new Error('VAD 时长与项目时长不一致');
        report({ status: 'running', data: '生成候选…', progress: 90 });
        const params: SilenceParams = input.params;
        const result = generateSilenceCandidates({
          duration: transcript.duration,
          speech: voice.segments.map(([start, end]) => ({ start, end })),
          wordSegments: transcript.hasWordTimestamps === true
            ? (transcript.wordChunks ?? []).map(word => ({ start: word.timestamp[0], end: word.timestamp[1] })) : undefined,
          existingDeleted,
          hasReliableWordTimestamps: transcript.hasWordTimestamps === true,
          params,
        });
        signal.throwIfAborted();
        return { vadType: voice.vadType, durationSeconds: voice.duration,
          hasReliableWordTimestamps: transcript.hasWordTimestamps === true,
          warnings: result.warnings, candidates: result.candidates };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })));
} };
