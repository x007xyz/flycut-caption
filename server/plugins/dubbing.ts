import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dubCueInputSchema,
  upsertCueDubbing,
  type CueDubbingArtifact,
  type DubCueResult,
} from '../../shared/tts/dubbing';
import { parseFfmpegDuration, sendFile } from './projects';

const DUBBING_ROUTE = /^\/projects\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\/dubbing\/([0-9a-f-]{36})$/i;

function runFfmpegProbe(ffmpeg: string, args: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(Object.assign(new Error(`ffmpeg exited with ${code}`), { stderr }));
    });
  });
}

export const dubbingPlugin = {
  name: 'flycut-dubbing',
  inject: ['hostConfig', 'rpc', 'jobs', 'providers', 'projectStore'],
  apply(ctx: Context) {
    const store = ctx.projectStore;
    const bundledFfmpeg = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const devFfmpeg = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const resolveFfmpeg = async () =>
      process.env.FFMPEG_PATH
      || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => undefined)
      || await access(devFfmpeg).then(() => devFfmpeg).catch(() => 'ffmpeg');

    const probeAudioDuration = async (bytes: Uint8Array, format: string, signal?: AbortSignal): Promise<number | undefined> => {
      const tempFile = join(tmpdir(), `flycut-dub-probe-${randomUUID()}.${format}`);
      try {
        await writeFile(tempFile, bytes);
        const ffmpeg = await resolveFfmpeg();
        const stderr = await runFfmpegProbe(ffmpeg, ['-hide_banner', '-i', tempFile, '-f', 'null', '-t', '0', '-'], signal)
          .catch(error => String((error as { stderr?: string }).stderr ?? ''));
        return parseFfmpegDuration(stderr);
      } finally {
        await rm(tempFile, { force: true }).catch(() => undefined);
      }
    };

    ctx.effect(() => ctx.rpc.register('dubbing.synthesizeCue', dubCueInputSchema, input =>
      ctx.jobs.create(async (signal, report): Promise<DubCueResult> => {
        if (input.request.cloneReferenceAssetId || input.request.cloneAuthorization) {
          throw new Error('单条译文配音仅支持使用模型自带音色，不支持声音克隆');
        }
        const expectedText = input.expectedText.trim();

        type PrecheckResult =
          | { kind: 'conflict'; result: Extract<DubCueResult, { status: 'conflict' }> }
          | { kind: 'saved'; result: Extract<DubCueResult, { status: 'saved' }> }
          | { kind: 'proceed'; cueDurationSeconds: number; currentText: string };

        const checkBeforeSynth = (): Promise<PrecheckResult> => store.exclusive(input.projectId, async () => {
          let project;
          try {
            project = await store.read(input.projectId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return { kind: 'conflict', result: { status: 'conflict', reason: 'deleted' } };
            }
            throw error;
          }
          if (project.deletedAt) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'trashed', projectRevision: project.revision, updatedAt: project.updatedAt } };
          }
          const video = project.videos.find(item => item.id === input.videoId);
          if (!video) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'video-missing', projectRevision: project.revision, updatedAt: project.updatedAt } };
          }
          const edits = await store.readEdits(input.projectId, input.videoId);
          if (!edits) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'track-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt } };
          }
          if (input.operationId) {
            const duplicate = edits?.dubbings?.find(item => item.operationId === input.operationId);
            if (duplicate) {
              return {
                kind: 'saved',
                result: {
                  status: 'saved',
                  duplicate: true,
                  artifact: duplicate,
                  videoRevision: video.revision,
                  projectRevision: project.revision,
                  updatedAt: video.updatedAt ?? project.updatedAt,
                },
              };
            }
          }
          if (video.revision !== input.baseVideoRevision) {
            return {
              kind: 'conflict',
              result: {
                status: 'conflict',
                reason: 'revision-mismatch',
                videoRevision: video.revision,
                projectRevision: project.revision,
                updatedAt: video.updatedAt ?? project.updatedAt,
              },
            };
          }
          const track = edits?.languageTracks?.find(item => item.id === input.trackId);
          if (!track) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'track-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt } };
          }
          const chunk = edits?.chunks.find(item => item.id === input.chunkId && !item.deleted);
          if (!chunk) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'chunk-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt } };
          }
          const currentText = track.entries[input.chunkId]?.text.trim() ?? '';
          if (!currentText || currentText !== expectedText) {
            return { kind: 'conflict', result: { status: 'conflict', reason: 'text-changed', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt } };
          }
          const cueDurationSeconds = chunk.timestamp[1] - chunk.timestamp[0];
          if (!Number.isFinite(cueDurationSeconds) || cueDurationSeconds <= 0) {
            throw new Error('字幕区间时长无效');
          }
          return { kind: 'proceed', cueDurationSeconds, currentText };
        });

        const precheck = await checkBeforeSynth();
        if (precheck.kind !== 'proceed') return precheck.result;
        signal.throwIfAborted();

        const output = await ctx.providers.synthesize({
          ...input.request,
          text: precheck.currentText,
        }, signal, report);
        signal.throwIfAborted();

        let durationSeconds = output.durationSeconds;
        if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          durationSeconds = await probeAudioDuration(output.bytes, output.format, signal);
        }
        if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error('无法识别生成的配音时长，请确认音频有效或检查 FFmpeg 环境');
        }

        return store.exclusive(input.projectId, async (): Promise<DubCueResult> => {
          signal.throwIfAborted();
          let project;
          try {
            project = await store.read(input.projectId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return { status: 'conflict', reason: 'deleted' };
            }
            throw error;
          }
          if (project.deletedAt) {
            return { status: 'conflict', reason: 'trashed', projectRevision: project.revision, updatedAt: project.updatedAt };
          }
          const video = project.videos.find(item => item.id === input.videoId);
          if (!video) {
            return { status: 'conflict', reason: 'video-missing', projectRevision: project.revision, updatedAt: project.updatedAt };
          }
          const edits = await store.readEdits(input.projectId, input.videoId);
          if (!edits) {
            return { status: 'conflict', reason: 'track-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt };
          }
          if (input.operationId) {
            const duplicate = edits?.dubbings?.find(item => item.operationId === input.operationId);
            if (duplicate) {
              return {
                status: 'saved',
                duplicate: true,
                artifact: duplicate,
                videoRevision: video.revision,
                projectRevision: project.revision,
                updatedAt: video.updatedAt ?? project.updatedAt,
              };
            }
          }
          if (video.revision !== input.baseVideoRevision) {
            return { status: 'conflict', reason: 'revision-mismatch', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt };
          }
          const track = edits?.languageTracks?.find(item => item.id === input.trackId);
          if (!track) {
            return { status: 'conflict', reason: 'track-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt };
          }
          const chunk = edits?.chunks.find(item => item.id === input.chunkId && !item.deleted);
          if (!chunk) {
            return { status: 'conflict', reason: 'chunk-missing', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt };
          }
          const currentText = track.entries[input.chunkId]?.text.trim() ?? '';
          if (!currentText || currentText !== expectedText) {
            return { status: 'conflict', reason: 'text-changed', videoRevision: video.revision, projectRevision: project.revision, updatedAt: video.updatedAt ?? project.updatedAt };
          }

          const dubId = randomUUID();
          const file = `dubbing/${dubId}.${output.format}`;
          const target = store.dubbingFile(input.projectId, input.videoId, file);
          const tmp = `${target}.${randomUUID()}.tmp`;
          const now = new Date().toISOString();
          const replaced = edits?.dubbings?.find(item => item.trackId === input.trackId && item.chunkId === input.chunkId);

          await mkdir(store.dubbingDir(input.projectId, input.videoId), { recursive: true });
          try {
            await writeFile(tmp, output.bytes);
            await rename(tmp, target);
          } catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined);
            throw error;
          }

          const artifact: CueDubbingArtifact = {
            id: dubId,
            trackId: input.trackId,
            chunkId: input.chunkId,
            file,
            mimeType: output.mimeType,
            format: output.format,
            byteLength: output.byteLength,
            durationSeconds,
            ...(output.sampleRate !== undefined ? { sampleRate: output.sampleRate } : {}),
            cueDurationSeconds: chunk.timestamp[1] - chunk.timestamp[0],
            text: currentText,
            model: { providerId: input.request.providerId, modelId: input.request.modelId },
            ...(input.request.voiceId ? { voiceId: input.request.voiceId } : {}),
            language: input.request.language,
            ...(input.request.speed !== undefined ? { speed: input.request.speed } : {}),
            ...(input.request.options ? { options: input.request.options } : {}),
            ...(input.operationId ? { operationId: input.operationId } : {}),
            createdAt: now,
          };

          try {
            const nextEdits = { ...edits, dubbings: upsertCueDubbing(edits.dubbings, artifact) };
            await store.writeEdits(input.projectId, input.videoId, nextEdits);
          } catch (error) {
            await rm(target, { force: true }).catch(() => undefined);
            throw error;
          }

          video.revision += 1;
          video.updatedAt = now;
          project.revision += 1;
          project.updatedAt = now;
          await store.writeProject(project);

          if (replaced && replaced.file !== file) {
            await rm(store.dubbingFile(input.projectId, input.videoId, replaced.file), { force: true }).catch(() => undefined);
          }

          return {
            status: 'saved',
            artifact,
            videoRevision: video.revision,
            projectRevision: project.revision,
            updatedAt: now,
          };
        });
      }, { operationId: input.operationId })));

    ctx.effect(() => ctx.rpc.route({
      method: 'GET',
      pattern: DUBBING_ROUTE,
      auth: 'client',
      queryToken: true,
      async handle(req, res, match) {
        const [, projectId, videoId, dubId] = match;
        const project = await store.read(projectId).catch(() => undefined);
        const video = project?.deletedAt ? undefined : project?.videos.find(item => item.id === videoId);
        if (!project || !video) {
          res.writeHead(404);
          res.end();
          return;
        }
        const edits = await store.readEdits(projectId, videoId).catch(() => undefined);
        const artifact = edits?.dubbings?.find(item => item.id === dubId);
        if (!artifact) {
          res.writeHead(404);
          res.end();
          return;
        }
        const file = store.dubbingFile(projectId, videoId, artifact.file);
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile()) {
          res.writeHead(404);
          res.end();
          return;
        }
        await sendFile(req, res, file, artifact.mimeType);
      },
    }));
  },
};
