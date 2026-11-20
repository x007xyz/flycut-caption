import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dubCueInputSchema,
  dubbingMixInputSchema,
  type DubbingMixResult,
  trackDubInputSchema,
  upsertCueDubbing,
  type CueDubbingArtifact,
  type DubCueResult,
  type TrackDubResult,
  type TrackDubUnresolved,
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
  inject: ['hostConfig', 'rpc', 'jobs', 'providers', 'projectStore', 'assets'],
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
        const expectedText = input.expectedText.trim();
        const voiceProject = input.voiceProfileId ? await store.read(input.projectId) : undefined;
        const voiceProfile = input.voiceProfileId ? voiceProject?.voiceProfiles?.find(item => item.id === input.voiceProfileId) : undefined;
        if (input.voiceProfileId && !voiceProfile) throw new Error('音色不存在或已删除');
        if (!input.voiceProfileId && (input.request.cloneReferenceAssetId || input.request.cloneAuthorization)) {
          throw new Error('声音克隆必须使用项目音色');
        }
        const request = voiceProfile
          ? { ...input.request, cloneReferenceAssetId: voiceProfile.id, cloneAuthorization: voiceProfile.authorization,
              referenceAudioPath: store.voiceFile(input.projectId, voiceProfile.sourceVideoId, voiceProfile.file) }
          : input.request;

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
          ...request,
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
            ...(input.voiceProfileId ? { voiceProfileId: input.voiceProfileId } : {}),
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

    ctx.effect(() => ctx.rpc.register('dubbing.alignTrack', trackDubInputSchema, input =>
      ctx.jobs.create(async (signal, report): Promise<TrackDubResult> => {
        const conflict = (reason: Extract<TrackDubResult, { status: 'conflict' }>['reason'], videoRevision?: number, projectRevision?: number, updatedAt?: string): TrackDubResult =>
          ({ status: 'conflict', reason, ...(videoRevision !== undefined ? { videoRevision } : {}), ...(projectRevision !== undefined ? { projectRevision } : {}), ...(updatedAt ? { updatedAt } : {}) });
        let project;
        try { project = await store.read(input.projectId); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return conflict('deleted');
          throw error;
        }
        if (project.deletedAt) return conflict('trashed', undefined, project.revision, project.updatedAt);
        const voiceProfile = input.voiceProfileId ? project.voiceProfiles?.find(item => item.id === input.voiceProfileId) : undefined;
        if (input.voiceProfileId && !voiceProfile) throw new Error('音色不存在或已删除');
        if (!input.voiceProfileId && (input.request.cloneReferenceAssetId || input.request.cloneAuthorization)) {
          throw new Error('声音克隆必须使用项目音色');
        }
        const baseRequest = voiceProfile
          ? { ...input.request, cloneReferenceAssetId: voiceProfile.id, cloneAuthorization: voiceProfile.authorization,
              referenceAudioPath: store.voiceFile(input.projectId, voiceProfile.sourceVideoId, voiceProfile.file) }
          : input.request;
        const video = project.videos.find(item => item.id === input.videoId);
        if (!video) return conflict('video-missing', undefined, project.revision, project.updatedAt);
        const edits = await store.readEdits(input.projectId, input.videoId);
        if (!edits) return conflict('track-missing', video.revision, project.revision, video.updatedAt ?? project.updatedAt);
        if (video.revision !== input.baseVideoRevision) return conflict('revision-mismatch', video.revision, project.revision, video.updatedAt ?? project.updatedAt);
        const track = edits.languageTracks?.find(item => item.id === input.trackId);
        if (!track) return conflict('track-missing', video.revision, project.revision, video.updatedAt ?? project.updatedAt);
        const cueById = new Map(edits.chunks.filter(chunk => !chunk.deleted).map(chunk => [chunk.id, chunk]));
        for (const cue of input.cues) {
          const chunk = cueById.get(cue.chunkId);
          if (!chunk) return conflict('chunk-missing', video.revision, project.revision, video.updatedAt ?? project.updatedAt);
          const text = track.entries[cue.chunkId]?.text.trim() ?? '';
          if (!text || text !== cue.expectedText) return conflict('text-changed', video.revision, project.revision, video.updatedAt ?? project.updatedAt);
        }

        const pending: Array<{ artifact: CueDubbingArtifact; bytes: Uint8Array }> = [];
        const unresolved: TrackDubUnresolved[] = [];
        const maxSpeed = input.maxSpeed ?? 1.25;
        for (const [index, cue] of input.cues.entries()) {
          signal.throwIfAborted();
          report({ status: 'running', progress: Math.round(index / input.cues.length * 100), data: `整段配音 ${index + 1}/${input.cues.length}` });
          const chunk = cueById.get(cue.chunkId)!;
          const target = chunk.timestamp[1] - chunk.timestamp[0];
          if (!Number.isFinite(target) || target <= 0) { unresolved.push({ chunkId: cue.chunkId, reason: 'failed', message: '字幕区间无效' }); continue; }
          try {
            let output = await ctx.providers.synthesize({ ...baseRequest, text: cue.expectedText, speed: 1 }, signal, report);
            signal.throwIfAborted();
            let duration = output.durationSeconds;
            if (!Number.isFinite(duration ?? NaN) || (duration ?? 0) <= 0) duration = await probeAudioDuration(output.bytes, output.format, signal);
            if (!duration || !Number.isFinite(duration) || duration <= 0) throw new Error('无法识别生成的配音时长');
            let mode: 'none' | 'speed' = 'none';
            let speed = 1;
            const sourceSeconds = duration;
            if (duration > target + 0.01) {
              speed = Math.min(maxSpeed, Math.max(1.0001, duration / target));
              output = await ctx.providers.synthesize({ ...baseRequest, text: cue.expectedText, speed }, signal, report);
              signal.throwIfAborted();
              duration = output.durationSeconds;
              if (!Number.isFinite(duration ?? NaN) || (duration ?? 0) <= 0) duration = await probeAudioDuration(output.bytes, output.format, signal);
              if (!duration || !Number.isFinite(duration) || duration <= 0) throw new Error('无法识别变速后的配音时长');
              mode = 'speed';
            }
            if (duration > target + 0.01) { unresolved.push({ chunkId: cue.chunkId, reason: 'too-long', message: `${duration.toFixed(2)}s > ${target.toFixed(2)}s` }); continue; }
            const dubId = randomUUID();
            pending.push({ bytes: output.bytes, artifact: {
              id: dubId, trackId: input.trackId, chunkId: cue.chunkId, file: `dubbing/${dubId}.${output.format}`,
              mimeType: output.mimeType, format: output.format, byteLength: output.byteLength, durationSeconds: duration,
              ...(output.sampleRate !== undefined ? { sampleRate: output.sampleRate } : {}),
              cueDurationSeconds: target, text: cue.expectedText,
              model: { providerId: input.request.providerId, modelId: input.request.modelId },
              ...(input.voiceProfileId ? { voiceProfileId: input.voiceProfileId } : {}),
              ...(input.request.voiceId ? { voiceId: input.request.voiceId } : {}),
              language: input.request.language,
              ...(input.request.speed !== undefined && mode === 'none' ? { speed: input.request.speed } : {}),
              ...(input.request.options ? { options: input.request.options } : {}),
              createdAt: new Date().toISOString(),
              alignment: { mode, targetSeconds: target, sourceSeconds, outputSeconds: duration, ...(mode === 'speed' ? { speed: Number(speed.toFixed(4)) } : {}) },
            } });
          } catch (error) {
            signal.throwIfAborted();
            unresolved.push({ chunkId: cue.chunkId, reason: 'failed', message: error instanceof Error ? error.message : String(error) });
          }
        }

        return store.exclusive(input.projectId, async (): Promise<TrackDubResult> => {
          const currentProject = await store.read(input.projectId).catch(() => undefined);
          if (!currentProject || currentProject.deletedAt) return conflict(currentProject ? 'trashed' : 'deleted');
          const currentVideo = currentProject.videos.find(item => item.id === input.videoId);
          if (!currentVideo) return conflict('video-missing');
          if (currentVideo.revision !== input.baseVideoRevision) return conflict('revision-mismatch', currentVideo.revision, currentProject.revision, currentVideo.updatedAt ?? currentProject.updatedAt);
          const currentEdits = await store.readEdits(input.projectId, input.videoId);
          if (!currentEdits) return conflict('track-missing', currentVideo.revision, currentProject.revision);
          const now = new Date().toISOString();
          const replaced: string[] = [];
          if (pending.length) {
            await mkdir(store.dubbingDir(input.projectId, input.videoId), { recursive: true });
            for (const item of pending) {
              const target = store.dubbingFile(input.projectId, input.videoId, item.artifact.file);
              const tmp = `${target}.${randomUUID()}.tmp`;
              await writeFile(tmp, item.bytes);
              await rename(tmp, target);
              const previous = currentEdits.dubbings?.find(dub => dub.trackId === item.artifact.trackId && dub.chunkId === item.artifact.chunkId);
              if (previous) replaced.push(previous.file);
            }
          }
          let dubbings = currentEdits.dubbings;
          for (const item of pending) dubbings = upsertCueDubbing(dubbings, item.artifact);
          if (pending.length) {
            await store.writeEdits(input.projectId, input.videoId, { ...currentEdits, dubbings });
            currentVideo.revision += 1; currentVideo.updatedAt = now;
            currentProject.revision += 1; currentProject.updatedAt = now;
            await store.writeProject(currentProject);
            for (const file of new Set(replaced)) {
              if (!pending.some(item => item.artifact.file === file)) await rm(store.dubbingFile(input.projectId, input.videoId, file), { force: true }).catch(() => undefined);
            }
          }
          return { status: 'saved', artifacts: pending.map(item => item.artifact), unresolved,
            videoRevision: currentVideo.revision, projectRevision: currentProject.revision, updatedAt: now };
        });
      })));

    ctx.effect(() => ctx.rpc.register('dubbing.mix', dubbingMixInputSchema, input =>
      ctx.jobs.create(async (signal, report): Promise<DubbingMixResult> => {
        const project = await store.read(input.projectId).catch(() => undefined);
        if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
        const video = project.videos.find(item => item.id === input.videoId);
        if (!video) throw new Error('视频不存在');
        const edits = await store.readEdits(input.projectId, input.videoId);
        if (!edits) throw new Error('字幕轨道不存在');
        const track = edits.languageTracks?.find(item => item.id === input.trackId);
        if (!track) throw new Error('语言轨道不存在');
        const missing: string[] = []; const outdated: string[] = []; const tooLong: string[] = [];
        const active = edits.chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer);
        const dubs: Array<{ artifact: CueDubbingArtifact; start: number }> = [];
        for (const chunk of active) {
          const text = track.entries[chunk.id]?.text.trim() ?? '';
          if (!text) continue;
          const artifact = edits.dubbings?.find(item => item.trackId === input.trackId && item.chunkId === chunk.id);
          if (!artifact) { missing.push(chunk.id); continue; }
          if (artifact.text !== text) { outdated.push(chunk.id); continue; }
          if (artifact.durationSeconds > chunk.timestamp[1] - chunk.timestamp[0] + 0.01) { tooLong.push(chunk.id); continue; }
          if (!await access(store.dubbingFile(input.projectId, input.videoId, artifact.file)).then(() => true).catch(() => false)) { missing.push(chunk.id); continue; }
          dubs.push({ artifact, start: chunk.timestamp[0] });
        }
        const backgroundMissing = input.mode === 'dubbing-background'
          && (!edits.separation || !await access(store.separationDir(input.projectId, input.videoId, edits.separation.id)).then(() => true).catch(() => false));
        if (missing.length || outdated.length || tooLong.length || backgroundMissing) {
          return { status: 'unresolved', missing, outdated, tooLong, ...(backgroundMissing ? { backgroundMissing: true } : {}) };
        }
        if (!dubs.length) return { status: 'unresolved', missing: active.map(chunk => chunk.id), outdated: [], tooLong: [] };
        const duration = Math.max(video.durationSeconds, ...active.map(chunk => chunk.timestamp[1]));
        const out = join(tmpdir(), `flycut-mix-${randomUUID()}.wav`);
        const args = ['-v', 'error', '-y'];
        if (input.mode === 'dubbing') args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo');
        else if (input.mode === 'dubbing-background') args.push('-i', store.separationDir(input.projectId, input.videoId, edits.separation!.id) + '/background.wav');
        else {
          const media = video.media.kind === 'stored' ? store.mediaFile(input.projectId, video.media.file) : video.media.path;
          args.push('-i', media, '-filter_complex', `[0:a]volume=${input.duckVolume ?? 0.2}[base]`);
        }
        const baseLabel = input.mode === 'dubbing-ducked' ? '[base]' : '[0:a]';
        for (const dub of dubs) args.push('-i', store.dubbingFile(input.projectId, input.videoId, dub.artifact.file));
        const filter = dubs.map((dub, index) => `[${index + 1}:a]adelay=${Math.round(dub.start * 1000)}|${Math.round(dub.start * 1000)}[d${index}]`).join(';');
        const mixInputs = [baseLabel, ...dubs.map((_, index) => `[d${index}]`)].join('');
        const filterParts = input.mode === 'dubbing-ducked'
          ? `${filter};${mixInputs}amix=inputs=${dubs.length + 1}:duration=first:dropout_transition=0,alimiter=limit=0.95[mix]`
          : `${filter};${mixInputs}amix=inputs=${dubs.length + 1}:duration=first:dropout_transition=0,alimiter=limit=0.95[mix]`;
        args.push('-filter_complex', filterParts, '-map', '[mix]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le',
          '-metadata', 'comment=AI配音 / AI dubbing', '-t', String(duration), out);
        report({ status: 'running', progress: 30, data: '混音中…' });
        const ffmpeg = await resolveFfmpeg();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
          let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(`混音失败（${code}）：${stderr.slice(-500)}`)));
        });
        signal.throwIfAborted();
        const bytes = await readFile(out); await rm(out, { force: true }).catch(() => undefined);
        const assetId = await ctx.assets.put(bytes);
        report({ status: 'complete', progress: 100, data: '已完成' });
        return { status: 'saved', assetId, durationSeconds: duration, mode: input.mode, aiLabel: 'AI配音 / AI dubbing', warnings: [] };
      })));

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
