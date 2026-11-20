import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createVoiceProfileInputSchema, deleteVoiceProfileInputSchema, voiceProfilesInputSchema,
  type CreateVoiceProfileResult, type DeleteVoiceProfileResult, type VoiceProfile,
} from '../../shared/tts/voices';
import { sendFile } from './projects';

const execFileAsync = promisify(execFile);
const VOICE_ROUTE = /^\/projects\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\/voices\/([0-9a-f-]{36})$/i;

export const voicesPlugin = { name: 'flycut-voices', inject: ['hostConfig', 'rpc', 'jobs', 'projectStore'], apply(ctx: Context) {
  const store = ctx.projectStore;
  const resolveFfmpeg = async () => {
    const bundled = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const dev = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    for (const candidate of [process.env.FFMPEG_PATH, bundled, dev]) {
      if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return 'ffmpeg';
  };

  ctx.effect(() => ctx.rpc.register('voices.list', voiceProfilesInputSchema, async ({ projectId }) => {
    const project = await store.read(projectId).catch(() => undefined);
    return project && !project.deletedAt ? project.voiceProfiles ?? [] : [];
  }));

  ctx.effect(() => ctx.rpc.register('voices.create', createVoiceProfileInputSchema, input =>
    ctx.jobs.create(async (_signal, report): Promise<CreateVoiceProfileResult> => {
      report({ status: 'running', progress: 5, data: '检查项目与授权…' });
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project) return { status: 'conflict', reason: 'deleted' };
      if (project.deletedAt) return { status: 'conflict', reason: 'trashed' };
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) return { status: 'conflict', reason: 'video-missing' };
      if (input.end > video.durationSeconds + 0.5) return { status: 'conflict', reason: 'invalid-range' };
      const media = video.media.kind === 'stored' ? store.mediaFile(input.projectId, video.media.file) : video.media.path;
      if (!await access(media).then(() => true).catch(() => false)) return { status: 'conflict', reason: 'missing-media' };
      const id = randomUUID();
      const file = `voices/${id}.wav`;
      const target = store.voiceFile(input.projectId, input.videoId, file);
      await mkdir(store.voiceDir(input.projectId, input.videoId), { recursive: true });
      report({ status: 'running', progress: 30, data: '提取说话人片段…' });
      try {
        await execFileAsync(await resolveFfmpeg(), ['-v', 'error', '-y', '-ss', String(input.start), '-t', String(input.end - input.start),
          '-i', media, '-vn', '-ar', '16000', '-ac', '1', target], { timeout: 120_000 });
      } catch (error) {
        await rm(target, { force: true }).catch(() => undefined);
        throw new Error(`样本提取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const now = new Date().toISOString();
      const profile: VoiceProfile = { id, name: input.name, file, durationSeconds: input.end - input.start,
        sourceVideoId: input.videoId, sourceStart: input.start, sourceEnd: input.end,
        authorization: input.authorization, createdAt: now };
      return store.exclusive(input.projectId, async () => {
        const current = await store.read(input.projectId).catch(() => undefined);
        if (!current || current.deletedAt) { await rm(target, { force: true }).catch(() => undefined); return { status: 'conflict', reason: current ? 'trashed' : 'deleted' }; }
        current.voiceProfiles = [...(current.voiceProfiles ?? []), profile];
        current.voiceProfilesRevision = (current.voiceProfilesRevision ?? 0) + 1;
        current.revision += 1; current.updatedAt = now;
        await store.writeProject(current);
        report({ status: 'complete', progress: 100, data: '已完成' });
        return { status: 'saved', profile, projectRevision: current.revision, updatedAt: now };
      });
    })));

  ctx.effect(() => ctx.rpc.register('voices.delete', deleteVoiceProfileInputSchema, ({ projectId, id }) =>
    store.exclusive(projectId, async (): Promise<DeleteVoiceProfileResult> => {
      const project = await store.read(projectId);
      const profile = project.voiceProfiles?.find(item => item.id === id);
      if (profile) {
        await rm(store.voiceFile(projectId, profile.sourceVideoId, profile.file), { force: true }).catch(() => undefined);
        project.voiceProfiles = project.voiceProfiles!.filter(item => item.id !== id);
        project.voiceProfilesRevision = (project.voiceProfilesRevision ?? 0) + 1;
        project.revision += 1; project.updatedAt = new Date().toISOString();
        await store.writeProject(project);
      }
      return { deleted: !!profile, remoteRetained: true,
        note: '302.ai 不提供远端参考样本删除接口；本地样本已删除，远端副本按 302.ai 留存条款处理。' };
    })));

  ctx.effect(() => ctx.rpc.route({ method: 'GET', pattern: VOICE_ROUTE, auth: 'client', queryToken: true,
    async handle(req, res, match) {
      const [, projectId, videoId, voiceId] = match;
      const project = await store.read(projectId).catch(() => undefined);
      if (!project || project.deletedAt) { res.writeHead(404); res.end(); return; }
      const profile = project.voiceProfiles?.find(item => item.id === voiceId && item.sourceVideoId === videoId);
      if (!profile) { res.writeHead(404); res.end(); return; }
      await sendFile(req, res, store.voiceFile(projectId, videoId, profile.file), 'audio/wav');
    } }));
} };
