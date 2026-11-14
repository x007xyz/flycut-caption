import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEdl, exportSegments, migrateLegacy, validateEdl, type Cue, type Edl } from '../../shared/editing/edl';
import { analyzeFillers, inspectFillerGate, type FillerSentence, type FillerWord } from '../../shared/editing/fillerRules';
import { buildSemanticWindowPlan, createSemanticBase, mergeSemanticSuggestions } from '../../shared/editing/semanticFillers';
import { DEFAULT_SILENCE_PARAMS, generateSilenceCandidates, validateSilenceParams } from '../../shared/editing/silence';
import { populateSuggestionTexts, suggestionSummary, validateSuggestionBatch, type CutSuggestion, type SuggestionBatch, type SuggestionSource } from '../../shared/editing/suggestions';
import { HostRpcError } from '../../shared/errors';
import {
  projectExportInputSchema,
  projectSuggestInputSchema,
  projectSuggestionDismissInputSchema,
  projectSuggestionsListInputSchema,
  projectTranscribeInputSchema,
  type PendingProjectSuggestion,
  type ProjectSuggestInput,
  type ProjectExportResult,
  type ProjectSuggestResult,
  type ProjectTranscribeResult,
} from '../../shared/projectOps';
import { checkOptions, type ModelRef } from '../../shared/providers';
import {
  buildProjectExportSubtitleScene,
  resolveProjectExportStylePair,
  serializeProjectSubtitles,
  type ExportableChunk,
} from '../../shared/subtitle-graphics';
import { OpenAICompatibleEngine } from '../../shared/text/OpenAICompatibleEngine';
import type { ProjectFile, ProjectMedia, ProjectVideo } from '../../shared/projects';

export interface ProjectOpsConfig {
  linkedMedia?: boolean;
}

function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr.split('\n').slice(-5).join('\n') || `FFmpeg exited with ${code}`)));
  });
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingErr(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function mimeForExport(format: ProjectExportResult['format']): string {
  switch (format) {
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'json': return 'application/json';
    case 'vtt': return 'text/vtt';
    case 'srt':
    case 'ass': return 'text/plain';
  }
}

export const projectOpsPlugin = {
  name: 'flycut-project-ops',
  inject: ['hostConfig', 'rpc', 'jobs', 'assets', 'providers', 'aiSettings', 'editorPlugins', 'export', 'projectStore'],
  apply(ctx: Context, config: ProjectOpsConfig = {}) {
    const store = ctx.projectStore;
    const linkedMediaAllowed = ctx.hostConfig.profileName !== 'server' && config.linkedMedia !== false;
    const bundledFfmpeg = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const devFfmpeg = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const resolveFfmpeg = async () => process.env.FFMPEG_PATH
      || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => undefined)
      || await access(devFfmpeg).then(() => devFfmpeg).catch(() => 'ffmpeg');

    async function resolveActiveVideo(projectId: string, videoId?: string): Promise<{ project: ProjectFile; video: ProjectVideo }> {
      let project: ProjectFile;
      try {
        project = await store.read(projectId);
      } catch (error) {
        if (isMissingErr(error)) throw new HostRpcError('NOT_FOUND', `项目不存在：${projectId}`);
        throw error;
      }
      if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」在回收站中`);
      const video = videoId ? project.videos.find(item => item.id === videoId) : project.videos[0];
      if (!video) {
        throw new HostRpcError('NOT_FOUND', videoId ? `视频不存在：${videoId}` : `项目「${project.name}」还没有视频`);
      }
      return { project, video };
    }

    function resolveMediaPath(projectId: string, media: ProjectMedia): string {
      if (media.kind === 'stored') return store.mediaFile(projectId, media.file);
      if (!linkedMediaAllowed) throw new HostRpcError('MEDIA_MISSING', '服务端部署模式不支持本地链接媒体，请先上传媒体');
      return media.path;
    }

    async function requireMediaFile(projectId: string, video: ProjectVideo): Promise<string> {
      const mediaPath = resolveMediaPath(projectId, video.media);
      const info = await stat(mediaPath).catch(() => undefined);
      if (!info?.isFile()) throw new HostRpcError('MEDIA_MISSING', `项目视频「${video.name}」的媒体文件缺失，请先上传或重新关联`);
      return mediaPath;
    }

    const suggestionsFile = (projectId: string, videoId: string) => join(store.videoDir(projectId, videoId), 'pending-suggestions.json');

    async function readPendingSuggestions(projectId: string, videoId: string): Promise<PendingProjectSuggestion[]> {
      try {
        const raw = JSON.parse(await readFile(suggestionsFile(projectId, videoId), 'utf8')) as unknown;
        return Array.isArray(raw) ? (raw as PendingProjectSuggestion[]) : [];
      } catch (error) {
        if (isMissingErr(error)) return [];
        throw error;
      }
    }

    async function savePendingSuggestion(record: PendingProjectSuggestion) {
      await store.exclusive(record.projectId, async () => {
        const list = await readPendingSuggestions(record.projectId, record.videoId);
        if (record.operationId && list.some(item => item.operationId === record.operationId)) return;
        const deduped = list.filter((item) => !(item.baseRevision === record.baseRevision && item.batch.kind === record.batch.kind && item.batch.origin === record.batch.origin));
        deduped.unshift(record);
        await writeJsonAtomic(suggestionsFile(record.projectId, record.videoId), deduped.slice(0, 20));
      });
    }

    async function checkAsrModelReady(ref: ModelRef, options?: Record<string, string | number | boolean>) {
      let provider;
      try {
        provider = ctx.providers.get(ref.providerId);
      } catch {
        throw new HostRpcError('MODEL_NOT_READY', `识别 Provider 不可用：${ref.providerId}`);
      }
      if (!provider.transcribe) {
        throw new HostRpcError('INVALID_ARGUMENT', `${provider.name} 不提供语音识别能力`);
      }
      const models = await provider.models();
      const info = models.find(item => item.id === ref.modelId);
      if (!info) throw new HostRpcError('NOT_FOUND', `${provider.name} 没有模型 ${ref.modelId}`);
      if (info.role !== 'asr') throw new HostRpcError('INVALID_ARGUMENT', `${info.name} 不是语音识别模型`);
      if (info.status === 'download') {
        throw new HostRpcError('MODEL_NOT_READY', `模型尚未下载：${info.name}，请先运行 providers prepare 下载`, { status: 'download', model: ref });
      }
      if (info.status === 'unavailable') {
        throw new HostRpcError('MODEL_NOT_READY', `模型不可用：${info.name}（${info.reason ?? '未知原因'}）`, { status: 'unavailable', model: ref });
      }
      try {
        checkOptions(info, options);
      } catch (error) {
        throw new HostRpcError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
      }
    }

    async function resolveVadModel(explicit?: ModelRef): Promise<ModelRef | undefined> {
      const groups = await ctx.providers.models();
      if (explicit) {
        const group = groups.find(item => item.provider.id === explicit.providerId);
        const model = group?.models.find(item => item.id === explicit.modelId);
        if (!model || model.role !== 'vad') throw new HostRpcError('NOT_FOUND', `找不到 VAD 模型：${explicit.providerId}/${explicit.modelId}`);
        if (model.status !== 'ready') {
          throw new HostRpcError('MODEL_NOT_READY', `VAD 模型未就绪：${model.name}（${model.reason ?? model.status}）`);
        }
        return explicit;
      }
      for (const group of groups) {
        const ready = group.models.find(item => item.role === 'vad' && item.status === 'ready');
        if (ready) return { providerId: group.provider.id, modelId: ready.id };
      }
      return undefined;
    }

    async function resolveSemanticConfig(configId?: string): Promise<string> {
      const snapshot = await ctx.aiSettings.snapshot();
      const targetId = configId ?? snapshot.selectedId ?? undefined;
      if (!targetId) {
        throw new HostRpcError('AI_CONFIG_NOT_READY', 'Host 未选择或未配置 AI 模型，请先在 FlyCut 设置中添加并选中 AI 配置');
      }
      try {
        await ctx.aiSettings.resolve(targetId);
      } catch (error) {
        throw new HostRpcError('AI_CONFIG_NOT_READY', error instanceof Error ? error.message : String(error), { configId: targetId });
      }
      return targetId;
    }

    ctx.effect(() => ctx.rpc.expose('project/suggestions-updated'));

    // 1. Project-level transcription on Host
    ctx.effect(() => ctx.rpc.register('projects.transcribe', projectTranscribeInputSchema, async input => {
      const { project, video } = await resolveActiveVideo(input.projectId, input.videoId);
      const mediaPath = await requireMediaFile(project.id, video);
      await checkAsrModelReady(input.model, input.options);
      const ffmpeg = await resolveFfmpeg();

      return ctx.jobs.create(async (signal, report): Promise<ProjectTranscribeResult> => {
        const dir = await mkdtemp(join(tmpdir(), 'flycut-cli-asr-'));
        const wav = join(dir, 'audio.wav');
        try {
          report({ status: 'running', purpose: 'transcribe', progress: 10, data: '提取 16 kHz 音频…' });
          await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], signal);
          signal.throwIfAborted();
          report({ status: 'running', purpose: 'transcribe', progress: 25, data: '语音识别中…' });
          const transcript = await ctx.providers.transcribe(
            { providerId: input.model.providerId, modelId: input.model.modelId, language: input.language, options: input.options },
            wav,
            signal,
            report,
          );
          signal.throwIfAborted();
          report({ status: 'running', purpose: 'transcribe', progress: 92, data: '保存并核验转写结果…' });
          const revision = await store.exclusive(project.id, async () => {
            const latest = await store.read(project.id);
            if (latest.deletedAt) throw new HostRpcError('PROJECT_TRASHED', '项目在转写期间被移入回收站');
            const latestVideo = latest.videos.find(item => item.id === video.id);
            if (!latestVideo) throw new HostRpcError('NOT_FOUND', '视频在转写期间被移除');
            await store.writeTranscript(latest.id, latestVideo.id, transcript);
            latestVideo.hasTranscript = true;
            latestVideo.model = input.model;
            if (transcript.duration) latestVideo.durationSeconds = transcript.duration;
            const now = new Date().toISOString();
            latestVideo.updatedAt = now;
            latest.revision += 1;
            latest.updatedAt = now;
            await store.writeProject(latest);
            const verified = await store.readTranscript(latest.id, latestVideo.id);
            if (!verified) throw new Error('Host 转写结果核验失败');
            return latest.revision;
          });
          return {
            projectId: project.id,
            videoId: video.id,
            revision,
            language: transcript.language,
            duration: transcript.duration,
            chunkCount: transcript.chunks.length,
            wordCount: transcript.wordChunks?.length ?? 0,
            hasWordTimestamps: transcript.hasWordTimestamps === true,
            model: input.model,
          };
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }, { operationId: input.operationId });
    }));

    async function prepareSuggestEdits(rawInput: ProjectSuggestInput) {
      const input = projectSuggestInputSchema.parse(rawInput);
      const { project, video } = await resolveActiveVideo(input.projectId, input.videoId);
      if (input.expectedRevision !== undefined && video.revision !== input.expectedRevision) {
        throw new HostRpcError('VERSION_CONFLICT', '内容已更新，请重新检查', {
          expectedRevision: input.expectedRevision,
          actualRevision: video.revision,
        });
      }
      const transcript = await store.readTranscript(project.id, video.id);
      if (!transcript) throw new HostRpcError('INVALID_ARGUMENT', `视频「${video.name}」尚未转写，请先运行转写`);

      const wantFillers = input.kind === 'fillers' || input.kind === 'all';
      const wantSilence = input.kind === 'silence' || input.kind === 'all';
      const wantSemantic = input.kind === 'semantic' || (input.kind === 'all' && !!input.configId);
      const resolvedConfigId = wantSemantic ? await resolveSemanticConfig(input.configId) : undefined;
      const vadModel = wantSilence && input.silenceMethod !== 'gap' ? await resolveVadModel(input.vadModel) : undefined;
      if (wantSilence && input.silenceMethod === 'vad' && !vadModel) {
        throw new HostRpcError('MODEL_NOT_READY', '没有可用的 VAD 模型，请改用 --silence-method gap 或准备 VAD 模型');
      }
      if (wantSilence && vadModel) await requireMediaFile(project.id, video);
      const silenceParams = input.silenceParams ?? DEFAULT_SILENCE_PARAMS;
      if (wantSilence && vadModel) {
        const issues = validateSilenceParams(silenceParams);
        if (issues.length) throw new HostRpcError('INVALID_ARGUMENT', `静音参数无效：${issues.join('; ')}`);
      }
      const ffmpeg = await resolveFfmpeg();
      return { input, project, video, transcript, wantFillers, wantSilence, wantSemantic, resolvedConfigId, vadModel, silenceParams, ffmpeg };
    }

    async function executeSuggestEdits(
      rawInput: ProjectSuggestInput,
      signal: AbortSignal,
      report: (progress: import('../../src/types/subtitle').ASRProgress) => void,
    ): Promise<ProjectSuggestResult> {
      const { input, project, video, transcript, wantFillers, wantSilence, wantSemantic, resolvedConfigId, vadModel, silenceParams, ffmpeg } = await prepareSuggestEdits(rawInput);
      const existingPending = await readPendingSuggestions(project.id, video.id);
      if (input.operationId) {
        const existing = existingPending.find((item) => item.operationId === input.operationId);
        if (existing) {
          const summary = suggestionSummary(existing.batch);
          return {
            suggestionId: existing.id,
            projectId: existing.projectId,
            videoId: existing.videoId,
            baseRevision: existing.baseRevision,
            status: 'pending',
            total: summary.total,
            selected: summary.selected,
            durationSeconds: summary.durationSeconds,
            batch: existing.batch,
          };
        }
      }

      const latest = await resolveActiveVideo(project.id, video.id);
      if (input.expectedRevision !== undefined && latest.video.revision !== input.expectedRevision) {
        throw new HostRpcError('VERSION_CONFLICT', '内容已更新，请重新检查', {
          expectedRevision: input.expectedRevision,
          actualRevision: latest.video.revision,
        });
      }
        const edits = await store.readEdits(project.id, video.id);
        const formalChunks = (edits?.chunks ?? transcript.chunks) as unknown as FillerSentence[];
        const deletedWords = new Set(edits?.deletedWordIds ?? []);
        const formalWords = (transcript.wordChunks ?? []).map(w => ({
          ...(w as unknown as FillerWord),
          deleted: w.deleted || deletedWords.has(w.id),
        }));
        const duration = transcript.duration || latest.video.durationSeconds;
        const edl = edits?.editing?.edl ?? (duration > 0 ? createEdl(duration, []) : undefined);
        const existingDeleted = edl?.deleted.map(range => ({ start: range.startUs / 1e6, end: range.endUs / 1e6 })) ?? [];

        const ruleItems: CutSuggestion[] = [];
        const silenceItems: CutSuggestion[] = [];
        let semanticCount = 0;
        const warnings: string[] = [];
        let sentenceLevelOnly = false;

        if (wantFillers) {
          report({ status: 'running', progress: 20, data: '分析口癖候选…' });
          const fillerInput = {
            chunks: formalChunks,
            wordChunks: formalWords,
            hasWordTimestamps: transcript.hasWordTimestamps === true,
            sourceDuration: duration,
            existingDeleted,
          };
          const gate = inspectFillerGate(fillerInput);
          if (gate.ok) {
            const analyzed = analyzeFillers(fillerInput);
            for (const c of analyzed.candidates) {
              ruleItems.push({
                id: c.id,
                start: c.start,
                end: c.end,
                reason: c.reason,
                category: c.category,
                label: c.label,
                confidence: c.confidence,
                selected: c.defaultSelected,
                source: 'rule',
                sources: ['rule'],
              });
            }
          } else if (input.kind === 'fillers') {
            throw new HostRpcError('INVALID_ARGUMENT', `当前转写不满足字词级去口癖条件（${gate.reasons.join(', ')}）`);
          }
        }

        if (wantSilence) {
          report({ status: 'running', progress: 45, data: '分析长静音候选…' });
          if (transcript.hasWordTimestamps !== true) {
            sentenceLevelOnly = true;
            warnings.push('缺少可靠字词时间戳，仅提供句级/语音段边界静音建议，未生成字词精剪时间');
          }
          if (vadModel) {
            const mediaPath = await requireMediaFile(project.id, latest.video);
            const dir = await mkdtemp(join(tmpdir(), 'flycut-cli-vad-'));
            const wav = join(dir, 'audio.wav');
            try {
              await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], signal);
              const voice = await ctx.providers.detectVoice(vadModel, wav, signal, report);
              const vadResult = generateSilenceCandidates({
                duration: transcript.duration,
                speech: voice.segments.map(([start, end]) => ({ start, end })),
                wordSegments: transcript.hasWordTimestamps === true ? formalWords.map(w => ({ start: w.timestamp[0], end: w.timestamp[1] })) : undefined,
                existingDeleted,
                hasReliableWordTimestamps: transcript.hasWordTimestamps === true,
                params: silenceParams,
              });
              for (const w of vadResult.warnings) {
                if (!warnings.includes(w)) warnings.push(w);
              }
              for (const c of vadResult.candidates) {
                silenceItems.push({
                  id: c.id,
                  start: c.start,
                  end: c.end,
                  reason: c.reason,
                  category: c.category,
                  confidence: c.confidence,
                  selected: c.defaultSelected,
                  source: 'silence',
                  sources: ['silence'],
                });
              }
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            }
          } else {
            const gapPlugin = ctx.editorPlugins.get('delete-silence');
            const analysis = gapPlugin.analyze(
              { chunks: formalChunks, wordChunks: formalWords, hasWordTimestamps: transcript.hasWordTimestamps, totalDuration: duration },
              { threshold: input.gapThresholdSeconds ?? 1.5 },
            );
            for (const [idx, range] of analysis.ranges.entries()) {
              silenceItems.push({
                id: `gap-${idx}-${Math.round(range.start * 1000)}-${Math.round(range.end * 1000)}`,
                start: range.start,
                end: range.end,
                reason: range.reason ?? 'vad-pause',
                category: 'pause',
                selected: true,
                source: 'silence',
                sources: ['silence'],
              });
            }
          }
        }

        let items: CutSuggestion[] = [...ruleItems, ...silenceItems];
        if (wantSemantic && resolvedConfigId) {
          report({ status: 'running', progress: 70, data: '调用 Host AI 生成语义剪辑建议…' });
          if (transcript.hasWordTimestamps !== true || !formalWords.length) {
            throw new HostRpcError('INVALID_ARGUMENT', '语义剪辑建议需要可靠的字词时间戳');
          }
          const resolvedAI = await ctx.aiSettings.resolve(resolvedConfigId);
          const baseHash = await createSemanticBase({
            edl: edl ?? null,
            chunks: formalChunks,
            wordChunks: formalWords,
            sourceDuration: duration,
            transcriptId: `${project.id}:${video.id}`,
          });
          const plan = buildSemanticWindowPlan({
            base: baseHash,
            transcriptId: `${project.id}:${video.id}`,
            language: transcript.language,
            chunks: formalChunks
              .filter(c => !c.deleted && !(c as unknown as ExportableChunk).isBlankSpacer && Array.isArray(c.wordIds) && c.wordIds.length > 0)
              .map(c => ({ id: c.id, text: c.text, timestamp: c.timestamp, wordIds: c.wordIds })),
            wordChunks: formalWords.filter(w => !w.deleted).map(w => ({
              id: w.id, text: w.text, timestamp: w.timestamp, sentenceId: w.sentenceId,
            })),
            existingDeleted,
          });
          const engine = new OpenAICompatibleEngine();
          engine.setAbortSignal(signal);
          const semanticCandidates = [];
          for (const window of plan.windows) {
            signal.throwIfAborted();
            const res = await engine.suggestCuts(resolvedAI, window);
            semanticCandidates.push(...res.candidates);
          }
          semanticCount = semanticCandidates.length;
          items = mergeSemanticSuggestions(items, semanticCandidates);
        }

        const seenIds = new Set<string>();
        items = items.filter(item => {
          if (seenIds.has(item.id)) return false;
          seenIds.add(item.id);
          return true;
        });
        items = populateSuggestionTexts(items, formalChunks, formalWords);
        const kind: SuggestionBatch['kind'] = input.kind === 'silence' && !ruleItems.length && !semanticCount ? 'silence' : 'filler';
        const sources = new Set<SuggestionSource>(items.flatMap(item => item.sources ?? [item.source ?? 'rule']));
        const origin: SuggestionBatch['origin'] = sources.has('semantic') && (sources.has('rule') || sources.has('silence'))
          ? 'mixed'
          : sources.has('semantic') ? 'semantic' : 'rule';
        const batch: SuggestionBatch = validateSuggestionBatch({
          kind,
          base: String(latest.video.revision),
          preview: false,
          origin,
          items,
        });
        signal.throwIfAborted();
        const afterCheck = await resolveActiveVideo(project.id, video.id);
        if (input.expectedRevision !== undefined && afterCheck.video.revision !== input.expectedRevision) {
          throw new HostRpcError('VERSION_CONFLICT', '内容已更新，请重新检查', {
            expectedRevision: input.expectedRevision,
            actualRevision: afterCheck.video.revision,
          });
        }
        const suggestionId = randomUUID();
        const record: PendingProjectSuggestion = {
          id: suggestionId,
          ...(input.operationId ? { operationId: input.operationId } : {}),
          projectId: project.id,
          videoId: video.id,
          baseRevision: afterCheck.video.revision,
          createdAt: new Date().toISOString(),
          status: 'pending',
          batch,
        };
        await savePendingSuggestion(record);
        ctx.emit('project/suggestions-updated', { projectId: project.id, videoId: video.id });
        const summary = suggestionSummary(batch);
        return {
          suggestionId,
          projectId: project.id,
          videoId: video.id,
          baseRevision: afterCheck.video.revision,
          status: 'pending',
          total: summary.total,
          selected: summary.selected,
          durationSeconds: summary.durationSeconds,
          ...(warnings.length ? { warnings } : {}),
          ...(sentenceLevelOnly ? { sentenceLevelOnly: true } : {}),
          batch,
        };
    }

    ctx.provide('projectOps', { suggestEdits: executeSuggestEdits });

    // 2. Project-level pending edit suggestions (never touches formal edits.json / EDL)
    ctx.effect(() => ctx.rpc.register('projects.suggestEdits', projectSuggestInputSchema, async input => {
      await prepareSuggestEdits(input);
      return ctx.jobs.create((signal, report) => executeSuggestEdits(input, signal, report), { operationId: input.operationId });
    }));

    ctx.effect(() => ctx.rpc.register('projects.suggestions.list', projectSuggestionsListInputSchema, async input => {
      const { project, video } = await resolveActiveVideo(input.projectId, input.videoId);
      return readPendingSuggestions(project.id, video.id);
    }));

    ctx.effect(() => ctx.rpc.register('projects.suggestions.dismiss', projectSuggestionDismissInputSchema, async input => {
      await store.exclusive(input.projectId, async () => {
        const list = await readPendingSuggestions(input.projectId, input.videoId);
        const next = list.filter(item => item.id !== input.suggestionId);
        await writeJsonAtomic(suggestionsFile(input.projectId, input.videoId), next);
      });
      ctx.emit('project/suggestions-updated', { projectId: input.projectId, videoId: input.videoId });
      return { ok: true as const };
    }));

    // 3. Project-level formal export (never reads pending-suggestions.json)
    ctx.effect(() => ctx.rpc.register('projects.export', projectExportInputSchema, async input => {
      const { project, video } = await resolveActiveVideo(input.projectId, input.videoId);
      const format = input.format ?? 'mp4';
      const isVideoFormat = format === 'mp4' || format === 'webm';
      const mediaPath = isVideoFormat ? await requireMediaFile(project.id, video) : undefined;
      const transcript = await store.readTranscript(project.id, video.id);
      if (!isVideoFormat && !transcript) {
        throw new HostRpcError('INVALID_ARGUMENT', `视频「${video.name}」尚未转写，无法导出 ${format} 字幕`);
      }
      if (isVideoFormat && input.subtitleProcessing !== 'none' && !transcript) {
        throw new HostRpcError('INVALID_ARGUMENT', `视频「${video.name}」尚未转写，无法导出带字幕的视频`);
      }

      return ctx.jobs.create(async (signal, report): Promise<ProjectExportResult> => {
        const latest = await resolveActiveVideo(project.id, video.id);
        const edits = await store.readEdits(project.id, video.id);
        const projectStyle = await store.projectStyle(latest.project);
        const formalChunks = (edits?.chunks ?? transcript?.chunks ?? []) as ExportableChunk[];
        const deletedWords = new Set(edits?.deletedWordIds ?? []);
        const formalWords = (transcript?.wordChunks ?? []).map(w => ({ ...w, deleted: w.deleted || deletedWords.has(w.id) })) as ExportableChunk[];

        let probe = mediaPath ? await ctx.export.probeFile(mediaPath, signal) : undefined;
        const sourceDuration = probe?.duration ?? transcript?.duration ?? latest.video.durationSeconds;
        if (!sourceDuration || sourceDuration <= 0) {
          throw new HostRpcError('INVALID_ARGUMENT', '无法确定视频时长');
        }

        let edl: Edl;
        if (edits?.editing?.edl) {
          edl = validateEdl(edits.editing.edl);
        } else if (edits?.chunks?.some(c => c.deleted)) {
          edl = migrateLegacy(sourceDuration, edits.chunks as unknown as Cue[], formalWords as unknown as Cue[], transcript?.hasWordTimestamps === true);
        } else {
          edl = createEdl(sourceDuration, []);
        }
        const keptSegments = exportSegments(edl);
        if (!keptSegments.length) throw new HostRpcError('INVALID_ARGUMENT', '没有保留的视频片段可导出');
        const outputSeconds = keptSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
        const stylePair = resolveProjectExportStylePair(latest.video.styleSource, edits, projectStyle);
        const subtitleMode = input.subtitleExportMode ?? 'Bilingual';

        if (!isVideoFormat) {
          const text = serializeProjectSubtitles(
            format,
            formalChunks,
            keptSegments,
            subtitleMode,
            stylePair,
          );
          const assetId = await ctx.assets.put(Buffer.from(text, 'utf8'));
          await ctx.assets.size(assetId);
          return {
            projectId: project.id,
            videoId: video.id,
            assetId,
            filename: `subtitles_${video.id}.${format}`,
            mimeType: mimeForExport(format),
            format,
            durationSeconds: outputSeconds,
          };
        }

        const subtitleProcessing = input.subtitleProcessing ?? 'none';
        let subtitleScene;
        let subtitleTextContent;
        if (subtitleProcessing === 'hard' && formalChunks.length) {
          probe ??= await ctx.export.probeFile(mediaPath!, signal);
          subtitleScene = buildProjectExportSubtitleScene({
            chunks: formalChunks,
            wordChunks: formalWords,
            hasWordTimestamps: transcript?.hasWordTimestamps === true,
            keptSegments,
            stylePair,
            displayMode: subtitleMode,
            videoWidth: probe.width ?? 1920,
            videoHeight: probe.height ?? 1080,
            fps: probe.fps ?? 30,
            duration: outputSeconds,
          });
        } else if (subtitleProcessing === 'soft' && formalChunks.length) {
          subtitleTextContent = serializeProjectSubtitles('vtt', formalChunks, keptSegments, subtitleMode, stylePair);
        }

        const exported = await ctx.export.runFromFile(
          mediaPath!,
          {
            edl,
            segments: keptSegments,
            options: {
              format,
              quality: input.quality ?? 'medium',
              preserveAudio: input.preserveAudio ?? true,
              joinFadeMs: input.joinFadeMs ?? 0,
              subtitleProcessing,
              subtitleExportMode: subtitleMode,
              ...(subtitleScene ? { subtitleTransport: 'skia-band' as const, subtitleScene } : {}),
              ...(subtitleTextContent ? { subtitleTextContent } : {}),
            },
          },
          signal,
          report,
        );
        await ctx.assets.size(exported.assetId);
        return {
          projectId: project.id,
          videoId: video.id,
          assetId: exported.assetId,
          filename: exported.filename,
          mimeType: exported.mimeType,
          format,
          durationSeconds: outputSeconds,
        };
      }, { operationId: input.operationId });
    }));
  },
};
