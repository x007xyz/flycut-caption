import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { clipCopyInputSchema, clipSaveCopyInputSchema, clipsCreateInputSchema, clipsDeleteInputSchema, clipsSuggestInputSchema, suggestClips, type ClipRecord, type ClipSuggestionResult } from '../../shared/clips';
import { OpenAICompatibleEngine } from '../../shared/text/OpenAICompatibleEngine';

export const clipsPlugin = { name: 'flycut-clips', inject: ['rpc', 'jobs', 'projectStore', 'aiSettings'], apply(ctx: Context) {
  const store = ctx.projectStore;
  ctx.effect(() => ctx.rpc.register('clips.suggest', clipsSuggestInputSchema, input =>
    ctx.jobs.create(async (): Promise<ClipSuggestionResult> => {
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(input.projectId, input.videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      return suggestClips(edits.chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer), video.durationSeconds);
    })));

  ctx.effect(() => ctx.rpc.register('clips.create', clipsCreateInputSchema, ({ projectId, videoId, start, end, name, score, text, reasons }) =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      const video = project.videos.find(item => item.id === videoId);
      if (!video) throw new Error('视频不存在');
      if (!(end > start) || start < 0 || end > video.durationSeconds + 0.5) throw new Error('短片范围无效');
      if (end - start < 5 || end - start > 180) throw new Error('短片时长必须在 5–180 秒之间');
      const edits = await store.readEdits(projectId, videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const now = new Date().toISOString();
      const clip: ClipRecord = { id: randomUUID(), name, start, end, score: score ?? 0, text: text ?? '', reasons: reasons ?? [], createdAt: now };
      await store.writeEdits(projectId, videoId, { ...edits, clips: [...(edits.clips ?? []), clip] });
      video.revision += 1; video.updatedAt = now;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved' as const, clip, videoRevision: video.revision, projectRevision: project.revision, updatedAt: now };
    })));

  ctx.effect(() => ctx.rpc.register('clips.copy', clipCopyInputSchema, input =>
    ctx.jobs.create(async (signal, report) => {
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
      const edits = await store.readEdits(input.projectId, input.videoId);
      const clip = edits?.clips?.find(item => item.id === input.clipId);
      if (!clip) throw new Error('短片不存在');
      const text = clip.text.trim() || edits!.chunks.filter(chunk => chunk.timestamp[1] > clip.start && chunk.timestamp[0] < clip.end)
        .map(chunk => chunk.text).join(' ');
      if (!text.trim()) throw new Error('短片没有可用的文本');
      const model = await ctx.aiSettings.resolve(input.configId);
      const engine = new OpenAICompatibleEngine();
      engine.setAbortSignal(signal); engine.setProgressCallback(report);
      return engine.generateClipCopy(text, model);
    })));

  ctx.effect(() => ctx.rpc.register('clips.saveCopy', clipSaveCopyInputSchema, ({ projectId, videoId, clipId, copy }) =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      const video = project.videos.find(item => item.id === videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(projectId, videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const clip = edits.clips?.find(item => item.id === clipId);
      if (!clip) throw new Error('短片不存在');
      const nextClip = { ...clip, copy };
      const clips = (edits.clips ?? []).map(item => item.id === clipId ? nextClip : item);
      await store.writeEdits(projectId, videoId, { ...edits, clips });
      const now = new Date().toISOString();
      video.revision += 1; video.updatedAt = now;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved' as const, clip: nextClip, videoRevision: video.revision, projectRevision: project.revision };
    })));

  ctx.effect(() => ctx.rpc.register('clips.delete', clipsDeleteInputSchema, ({ projectId, videoId, id }) =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      const video = project.videos.find(item => item.id === videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(projectId, videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const clips = (edits.clips ?? []).filter(clip => clip.id !== id);
      const now = new Date().toISOString();
      await store.writeEdits(projectId, videoId, { ...edits, clips });
      video.revision += 1; video.updatedAt = now;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { deleted: clips.length !== (edits.clips ?? []).length, videoRevision: video.revision, projectRevision: project.revision };
    })));
} };
