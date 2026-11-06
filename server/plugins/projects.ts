import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  addVideoSchema, createEmptySchema, createFromSnapshotSchema, duplicateSchema, emptyTrashSchema, projectCreateSchema, projectOpenSchema, projectRefSchema, relinkSchema,
  removeVideoSchema, renameSchema, saveEditsSchema, saveProjectStyleSchema, saveTranscriptSchema, saveVideoEditsSchema, shellLinkSchema, thumbnailSchema,
  type ProjectDetailResult, type ProjectFile, type ProjectMedia, type ProjectOpenResult, type ProjectPlayback, type ProjectVideo, type ProjectVideoSummary,
  type SaveResult, type SaveResultV2, type HostIdentity, RECOVERY_PROTOCOL_VERSION,
} from '../../shared/projects';
import { fingerprintFile, ProjectStore } from '../projects/store';
import { NewerFormatError } from '../projects/migrations';

export interface ProjectsConfig {
  /**
   * Desktop only: projects may reference files on this machine that the shell registered (ADR-0002).
   * The `server` profile turns it off; linked media then always reads as missing.
   */
  linkedMedia?: boolean;
  /** How long a project stays in Trash before the Host deletes it permanently (F-0003 AC-5). Default 30 days. */
  trashRetentionHours?: number;
  /** How often the Host looks for expired projects in Trash. Default one hour. */
  purgeIntervalMs?: number;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

type Registered = { path: string; size: number; mtimeMs: number; fingerprint: string };
const MEDIA_ROUTE = /^\/projects\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})$/i;
const MAX_PENDING = 200;

async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request body exceeds limit'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Streams a file with HTTP Range support so `<video>` can seek. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, mimeType: string) {
  const size = (await stat(file)).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0; let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(range[2])); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
  }
  const headers = { 'Content-Type': mimeType || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Cache-Control': 'no-store' };
  if (range && (range[1] || range[2])) res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` });
  else res.writeHead(200, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  // Players abort ranged reads all the time; that is not a server error once headers are out.
  await pipeline(createReadStream(file, { start, end }), res).catch(() => res.destroy());
}

/** Runs FFmpeg and returns its stderr (FFmpeg prints stream info there). Rejects on a non-zero exit. */
function runFfmpeg(ffmpeg: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(stderr); else reject(Object.assign(new Error(`ffmpeg exited with ${code}`), { stderr })); });
  });
}

/**
 * The Host home's stable identity (F-0004, ADR-0004). Created once with an exclusive create, so two Hosts starting on
 * the same home agree on one ID. A damaged file is an error, not a reason to make a new ID: that would hide the
 * recovery copies kept under the old one. The file belongs to the Host home, not to any project, and is never exported.
 */
export async function readHostIdentity(home: string): Promise<string> {
  const file = join(home, 'host-id.json');
  const parse = (raw: string) => {
    const id = (JSON.parse(raw) as { hostId?: unknown }).hostId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Host 身份文件已损坏：${file}`);
    return id;
  };
  try { return parse(await readFile(file, 'utf8')); }
  catch (error) { if (!isMissing(error)) throw error; }
  await mkdir(home, { recursive: true });
  try { await writeFile(file, JSON.stringify({ hostId: randomUUID() }), { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return parse(await readFile(file, 'utf8'));
}

/** `Duration: 00:03:21.45` in FFmpeg's input summary. */
export function parseFfmpegDuration(stderr: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

/**
 * Project storage (F-0002, ADR-0001): the only reader and writer of `<home>/projects`.
 * Frontend, CLI and MCP clients all go through these RPC methods.
 */
export const projectsPlugin = { name: 'flycut-projects', inject: ['hostConfig', 'rpc', 'assets'], async apply(ctx: Context, config: ProjectsConfig = {}) {
  const linkedMedia = config.linkedMedia !== false;
  const retentionMs = (config.trashRetentionHours ?? 30 * 24) * 3600_000;
  const store = new ProjectStore(ctx.hostConfig.home);
  await store.init();
  await store.finishPurges();
  /** Files the shell registered during this Host's lifetime, by `mediaRef`. Paths never reach RPC. */
  const registered = new Map<string, Registered>();

  const mediaStatus = async (projectId: string, media: ProjectMedia, thorough = false): Promise<'ok' | 'missing'> => {
    if (media.kind === 'stored') return stat(store.mediaFile(projectId, media.file)).then(info => info.isFile() ? 'ok' : 'missing', () => 'missing');
    if (!linkedMedia) return 'missing';
    const info = await stat(media.path).catch(() => undefined);
    if (!info?.isFile() || info.size !== media.size) return 'missing';
    // A changed mtime alone is fine (copied back, touched); a changed head or tail is a different file.
    if (!thorough && info.mtimeMs === media.mtimeMs) return 'ok';
    const current = await fingerprintFile(media.path).catch(() => undefined);
    return current?.fingerprint === media.fingerprint ? 'ok' : 'missing';
  };

  /** Turns a create/relink source into stored or linked media. Uploaded assets move into the project. */
  const resolveMedia = async (projectId: string, videoId: string, source: z.infer<typeof projectCreateSchema>['media'], name: string): Promise<ProjectMedia> => {
    if ('mediaRef' in source) {
      if (!linkedMedia) throw new Error('此 Host 不支持引用本机文件');
      const entry = registered.get(source.mediaRef); if (!entry) throw new Error('媒体登记已失效，请重新选择文件');
      return { kind: 'linked', ...entry };
    }
    const file = ProjectStore.storedName(videoId, name);
    const size = await ctx.assets.size(source.assetId);
    await ctx.assets.claim(source.assetId, store.mediaFile(projectId, file));
    return { kind: 'stored', file, size, mimeType: source.mimeType };
  };

  const playback = (projectId: string, video: ProjectVideo): ProjectPlayback => video.media.kind === 'linked'
    ? { kind: 'path', path: video.media.path }
    : { kind: 'url', path: `/projects/${projectId}/media/${video.id}` };

  /** A project that is not in Trash, or why not. Only call under the project's write lock. */
  const lifecycle = async (projectId: string): Promise<ProjectFile | 'trashed' | 'deleted'> => {
    try { const project = await store.read(projectId); return project.deletedAt ? 'trashed' : project; }
    catch (error) { if (isMissing(error)) return 'deleted'; throw error; }
  };
  /** Like `lifecycle`, but a project in Trash or deleted is an error: it cannot be edited (F-0003 AC-3, AC-15). */
  const readActive = async (projectId: string) => {
    const project = await lifecycle(projectId);
    if (project === 'trashed') throw new Error('项目已移到回收站');
    if (project === 'deleted') throw new Error('项目已被彻底删除');
    return project;
  };

  const videoSummary = async (projectId: string, video: ProjectVideo, updatedAt: string): Promise<ProjectVideoSummary> => ({
    id: video.id, name: video.name, durationSeconds: video.durationSeconds, createdAt: video.createdAt, updatedAt: video.updatedAt ?? updatedAt,
    hasTranscript: video.hasTranscript, mediaMissing: (await mediaStatus(projectId, video.media)) === 'missing',
    hasThumbnail: await stat(join(store.videoDir(projectId, video.id), 'thumbnail.jpg')).then(() => true, () => false),
    styleSource: video.styleSource, revision: video.revision,
  });

  /** Applies `change` under the project's write lock and bumps the revision. */
  const commit = (projectId: string, change: (project: Awaited<ReturnType<ProjectStore['read']>>) => Promise<void> | void): Promise<SaveResult> =>
    store.exclusive(projectId, async () => {
      const project = await readActive(projectId);
      await change(project);
      project.revision += 1; project.updatedAt = new Date().toISOString();
      await store.writeProject(project);
      return { status: 'saved', revision: project.revision, updatedAt: project.updatedAt };
    });

  const bundledFfmpeg = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffmpegPath = async () => process.env.FFMPEG_PATH || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => 'ffmpeg');
  const mediaPath = (projectId: string, media: ProjectMedia) => media.kind === 'stored' ? store.mediaFile(projectId, media.file) : media.path;

  /**
   * Cover frame (3 s in, or the first frame for shorter clips, 320 px wide) and the real duration (AC-14).
   * Runs after the project exists; failures only mean the card shows a placeholder. Not a user edit: the revision stays.
   */
  const captureCover = async (projectId: string, videoId: string) => {
    const project = await store.read(projectId);
    const video = project.videos.find(item => item.id === videoId); if (!video) return;
    const source = mediaPath(projectId, video.media);
    const ffmpeg = await ffmpegPath();
    const probe = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', source, '-f', 'null', '-t', '0', '-']).catch(error => String((error as { stderr?: string }).stderr ?? ''));
    const duration = parseFfmpegDuration(probe);
    const target = join(store.videoDir(projectId, videoId), 'thumbnail.jpg');
    const temporary = `${target}.${randomUUID()}.tmp.jpg`;
    const at = duration !== undefined && duration < 3 ? 0 : 3;
    try {
      await runFfmpeg(ffmpeg, ['-hide_banner', '-y', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', temporary]);
      await rename(temporary, target);
    } catch (error) { await rm(temporary, { force: true }); console.warn(`[projects] 截取封面失败（${projectId}）：`, error instanceof Error ? error.message : error); }
    if (duration && Math.abs(duration - video.durationSeconds) > 0.5) {
      await store.exclusive(projectId, async () => {
        const latest = await store.read(projectId);
        const item = latest.videos.find(entry => entry.id === videoId);
        if (item) { item.durationSeconds = duration; await store.writeProject(latest); }
      });
    }
  };
  /** Covers being captured right now; tests and shutdown can wait for them. */
  const covers = new Set<Promise<void>>();
  const queueCover = (projectId: string, videoId: string) => {
    const task = captureCover(projectId, videoId).catch(() => undefined).finally(() => covers.delete(task));
    covers.add(task);
  };
  ctx.effect(() => () => { void Promise.allSettled([...covers]); });

  ctx.effect(() => ctx.rpc.register('projects.thumbnail', thumbnailSchema, async ({ projectId, videoId }) => {
    const file = join(store.videoDir(projectId, videoId), 'thumbnail.jpg');
    const bytes = await readFile(file).catch(() => undefined);
    return { dataUrl: bytes ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null };
  }));

  ctx.effect(() => ctx.rpc.register('projects.list', undefined, () => store.list((id, media) => mediaStatus(id, media))));

  ctx.effect(() => ctx.rpc.register('projects.create', projectCreateSchema, async input => {
    const project = await store.create({ name: input.name, video: { name: input.videoName, durationSeconds: input.durationSeconds },
      media: (projectId, videoId) => resolveMedia(projectId, videoId, input.media, input.videoName) });
    if ('mediaRef' in input.media) registered.delete(input.media.mediaRef);
    queueCover(project.id, project.videos[0].id);
    return { projectId: project.id, videoId: project.videos[0].id, revision: project.revision, project };
  }));

  ctx.effect(() => ctx.rpc.register('projects.open', projectOpenSchema, async ({ projectId, videoId }): Promise<ProjectOpenResult> => {
    let project;
    try { project = await store.read(projectId); }
    catch (error) { if (error instanceof NewerFormatError) return { status: 'newer-version', name: error.projectName }; throw error; }
    if (project.deletedAt) return { status: 'trashed', name: project.name };
    const video = videoId ? project.videos.find(item => item.id === videoId) : project.videos[0];
    if (!video) throw new Error('项目里没有这个视频');
    const [transcript, edits, media, projectStyle, videos] = await Promise.all([store.readTranscript(projectId, video.id), store.readEdits(projectId, video.id),
      mediaStatus(projectId, video.media, true), store.projectStyle(project),
      Promise.all(project.videos.map(item => videoSummary(projectId, item, project.updatedAt)))]);
    const name = video.media.kind === 'linked' ? basename(video.media.path) : video.name;
    return { status: 'ok', project, video, transcript, edits, projectStyle, videos,
      media: { status: media, name, playback: media === 'ok' ? playback(projectId, video) : undefined } };
  }));

  ctx.effect(() => ctx.rpc.register('projects.saveTranscript', saveTranscriptSchema, ({ projectId, videoId, transcript, model, durationSeconds }) =>
    commit(projectId, async project => {
      const video = project.videos.find(item => item.id === videoId); if (!video) throw new Error('项目里没有这个视频');
      await store.writeTranscript(projectId, videoId, transcript);
      video.hasTranscript = true; video.model = model;
      if (durationSeconds || transcript.duration) video.durationSeconds = durationSeconds || transcript.duration;
    })));

  // Autosave (AC-3). A stale `baseRevision` means another window or device saved first (AC-9): report it, write nothing.
  ctx.effect(() => ctx.rpc.register('projects.saveEdits', saveEditsSchema, ({ projectId, videoId, edits, baseRevision, force }) =>
    store.exclusive(projectId, async (): Promise<SaveResult> => {
      const project = await readActive(projectId);
      const video = project.videos.find(item => item.id === videoId); if (!video) throw new Error('项目里没有这个视频');
      if (project.revision !== baseRevision && !force) return { status: 'conflict', revision: project.revision, updatedAt: project.updatedAt };
      await store.writeEdits(projectId, videoId, edits);
      project.revision += 1; project.updatedAt = new Date().toISOString();
      video.revision += 1; video.updatedAt = project.updatedAt;
      await store.writeProject(project);
      return { status: 'saved', revision: project.revision, updatedAt: project.updatedAt };
    })));

  // Save as new project (AC-25): the original keeps the other window's version.
  ctx.effect(() => ctx.rpc.register('projects.duplicate', duplicateSchema, ({ projectId, videoId, name, edits, copyId }) =>
    store.exclusive(projectId, async () => {
      const copy = await store.duplicate(projectId, name, copyId);
      if (!copy.videos.some(item => item.id === videoId)) throw new Error('项目里没有这个视频');
      if (edits) await store.writeEdits(copy.id, videoId, edits);
      return { projectId: copy.id, videoId, revision: copy.revision };
    })));

  // Choose the file again after it went missing (AC-7). Subtitles and edits stay as they are.
  ctx.effect(() => ctx.rpc.register('projects.relinkMedia', relinkSchema, ({ projectId, videoId, media: source }) =>
    commit(projectId, async project => {
      const video = project.videos.find(item => item.id === videoId); if (!video) throw new Error('项目里没有这个视频');
      const name = 'mediaRef' in source ? basename(registered.get(source.mediaRef)?.path ?? video.name) : video.name;
      video.media = await resolveMedia(projectId, videoId, source, name);
      if ('mediaRef' in source) registered.delete(source.mediaRef);
    }).then(result => { queueCover(projectId, videoId); return result; })));

  // ---------- F-0003: project management, several videos, Trash ----------

  ctx.effect(() => ctx.rpc.register('projects.createEmpty', createEmptySchema, async ({ name }) => {
    const project = await store.createEmpty(name);
    return { projectId: project.id, revision: project.revision };
  }));

  ctx.effect(() => ctx.rpc.register('projects.detail', projectRefSchema, async ({ projectId }): Promise<ProjectDetailResult> => {
    let project;
    try { project = await store.read(projectId); }
    catch (error) { if (error instanceof NewerFormatError) return { status: 'newer-version', name: error.projectName }; throw error; }
    if (project.deletedAt) return { status: 'trashed', name: project.name };
    const { id, name, createdAt, updatedAt, revision, styleRevision } = project;
    return { status: 'ok', project: { id, name, createdAt, updatedAt, revision, styleRevision },
      videos: await Promise.all(project.videos.map(video => videoSummary(projectId, video, updatedAt))) };
  }));

  ctx.effect(() => ctx.rpc.register('projects.rename', renameSchema, ({ projectId, name }) => commit(projectId, project => { project.name = name; })));

  // Trash (AC-3, AC-4): the project stays where it is, marked; every reader skips it. Not a user edit: `updatedAt` stays.
  ctx.effect(() => ctx.rpc.register('projects.trash', projectRefSchema, ({ projectId }) => store.exclusive(projectId, async () => {
    const project = await store.read(projectId);
    if (!project.deletedAt) {
      const now = Date.now();
      project.deletedAt = new Date(now).toISOString(); project.purgeAfter = new Date(now + retentionMs).toISOString(); project.revision += 1;
      await store.writeProject(project);
    }
    return { deletedAt: project.deletedAt, purgeAfter: project.purgeAfter ?? project.deletedAt };
  })));

  ctx.effect(() => ctx.rpc.register('projects.restore', projectRefSchema, ({ projectId }) => store.exclusive(projectId, async () => {
    const project = await lifecycle(projectId);
    if (project === 'deleted') throw new Error('项目已被彻底删除');
    if (project === 'trashed') {
      const latest = await store.read(projectId);
      delete latest.deletedAt; delete latest.purgeAfter; latest.revision += 1;
      await store.writeProject(latest);
      return { revision: latest.revision };
    }
    return { revision: project.revision };
  })));

  ctx.effect(() => ctx.rpc.register('projects.trashList', undefined, () => store.trash()));

  /** Deletes a project in Trash for good; a restore that got the lock first wins (AC-5). Returns whether it was deleted. */
  const purgeIfTrashed = (projectId: string, expiredOnly = false) => store.exclusive(projectId, async () => {
    const project = await lifecycle(projectId);
    if (project !== 'trashed') return project === 'deleted';
    const latest = await store.read(projectId);
    if (expiredOnly && Date.parse(latest.purgeAfter ?? latest.deletedAt ?? '') > Date.now()) return false;
    await store.purge(projectId);
    return true;
  });

  ctx.effect(() => ctx.rpc.register('projects.purge', projectRefSchema, async ({ projectId }) => {
    if (!(await purgeIfTrashed(projectId))) throw new Error('只能彻底删除回收站里的项目');
    return { ok: true as const };
  }));

  // Empty Trash (AC-24): only the rows the user saw; one failure does not stop the rest.
  ctx.effect(() => ctx.rpc.register('projects.emptyTrash', emptyTrashSchema, async ({ projectIds }) => {
    const purged: string[] = []; const failed: string[] = [];
    for (const projectId of projectIds) {
      try { if (await purgeIfTrashed(projectId)) purged.push(projectId); }
      catch (error) { console.warn(`[projects] 彻底删除失败（${projectId}）：`, error instanceof Error ? error.message : error); failed.push(projectId); }
    }
    return { purged, failed };
  }));

  // Expired projects in Trash: on start and then periodically, while the Host runs (AC-5).
  const sweepTrash = async () => {
    const expired = (await store.trash().catch(() => [])).filter(item => Date.parse(item.purgeAfter) <= Date.now());
    for (const item of expired) await purgeIfTrashed(item.id, true).catch(error => console.warn(`[projects] 到期清理失败（${item.id}）：`, error));
  };
  await sweepTrash();
  ctx.effect(() => {
    const timer = setInterval(() => { void sweepTrash(); }, config.purgeIntervalMs ?? 3600_000);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  // Add a video to a project (AC-8): one file at a time; a failure leaves nothing behind.
  ctx.effect(() => ctx.rpc.register('projects.addVideo', addVideoSchema, async ({ projectId, videoName, durationSeconds, media: source }) => {
    const result = await store.exclusive(projectId, async () => {
      const project = await readActive(projectId);
      const videoId = randomUUID(); const now = new Date().toISOString();
      const video: ProjectVideo = { id: videoId, name: videoName, durationSeconds, createdAt: now, updatedAt: now, hasTranscript: false,
        revision: 0, styleSource: 'project', media: { kind: 'stored', file: ProjectStore.storedName(videoId, videoName), size: 0, mimeType: '' } };
      try {
        await mkdir(store.videoDir(projectId, videoId), { recursive: true });
        video.media = await resolveMedia(projectId, videoId, source, videoName);
        project.videos.push(video); project.revision += 1; project.updatedAt = now;
        await store.writeProject(project);
      } catch (error) { await store.removeVideoFiles(projectId, video).catch(() => undefined); throw error; }
      return { videoId, revision: project.revision };
    });
    if ('mediaRef' in source) registered.delete(source.mediaRef);
    queueCover(projectId, result.videoId);
    return result;
  }));

  // Remove a video (AC-11): no Trash; the project stays, even when empty.
  ctx.effect(() => ctx.rpc.register('projects.removeVideo', removeVideoSchema, ({ projectId, videoId }) => store.exclusive(projectId, async () => {
    const project = await readActive(projectId);
    const video = project.videos.find(item => item.id === videoId); if (!video) throw new Error('项目里没有这个视频');
    // A format-1 project reads its style from the first video: keep it before that video goes.
    project.style ??= await store.projectStyle(project);
    project.videos = project.videos.filter(item => item.id !== videoId);
    project.revision += 1; project.updatedAt = new Date().toISOString();
    await store.writeProject(project);
    await store.removeVideoFiles(projectId, video);
    return { revision: project.revision };
  })));

  // Format 2 autosave (AC-14): a video's revision only changes when that video is saved.
  ctx.effect(() => ctx.rpc.register('projects.saveVideoEdits', saveVideoEditsSchema, ({ projectId, videoId, edits, styleSource, baseRevision, force }) =>
    store.exclusive(projectId, async (): Promise<SaveResultV2> => {
      const project = await lifecycle(projectId);
      if (typeof project === 'string') return { status: project };
      const video = project.videos.find(item => item.id === videoId); if (!video) return { status: 'video-missing' };
      if (video.revision !== baseRevision && !force) return { status: 'conflict', revision: video.revision, updatedAt: video.updatedAt ?? project.updatedAt };
      await store.writeEdits(projectId, videoId, styleSource === 'custom' ? edits : { ...edits, stylePair: undefined });
      const now = new Date().toISOString();
      video.revision += 1; video.updatedAt = now; video.styleSource = styleSource;
      project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved', revision: video.revision, projectRevision: project.revision, updatedAt: now };
    })));

  ctx.effect(() => ctx.rpc.register('projects.saveProjectStyle', saveProjectStyleSchema, ({ projectId, style, baseRevision, force }) =>
    store.exclusive(projectId, async (): Promise<SaveResultV2> => {
      const project = await lifecycle(projectId);
      if (typeof project === 'string') return { status: project };
      if (project.styleRevision !== baseRevision && !force) return { status: 'conflict', revision: project.styleRevision, updatedAt: project.updatedAt };
      const now = new Date().toISOString();
      project.style = style; project.styleRevision += 1; project.revision += 1; project.updatedAt = now;
      await store.writeProject(project);
      return { status: 'saved', revision: project.styleRevision, projectRevision: project.revision, updatedAt: now };
    })));

  // Save as new project after a permanent delete elsewhere (AC-32): media reads as missing until the user chooses the file again.
  ctx.effect(() => ctx.rpc.register('projects.createFromSnapshot', createFromSnapshotSchema, async input => {
    const project = await store.create({ name: input.name, video: { name: input.videoName, durationSeconds: input.durationSeconds },
      media: async (_projectId, videoId) => ({ kind: 'stored', file: ProjectStore.storedName(videoId, input.videoName), size: 0, mimeType: '' }) });
    const video = project.videos[0];
    await store.exclusive(project.id, async () => {
      if (input.transcript) await store.writeTranscript(project.id, video.id, input.transcript);
      await store.writeEdits(project.id, video.id, input.styleSource === 'custom' ? input.edits : { ...input.edits, stylePair: undefined });
      video.hasTranscript = !!input.transcript; video.styleSource = input.styleSource; project.style = input.style;
      project.revision += 1;
      await store.writeProject(project);
    });
    return { projectId: project.id, videoId: video.id };
  }));

  // Project media for players: Range requests, same token as RPC.
  ctx.effect(() => ctx.rpc.route({ method: 'GET', pattern: MEDIA_ROUTE, auth: 'client', async handle(req, res, match) {
    const [, projectId, videoId] = match;
    const project = await store.read(projectId).catch(() => undefined);
    const video = project?.deletedAt ? undefined : project?.videos.find(item => item.id === videoId);
    if (!project || !video || (await mediaStatus(projectId, video.media)) === 'missing') { res.writeHead(404); res.end(); return; }
    if (video.media.kind === 'stored') await sendFile(req, res, store.mediaFile(projectId, video.media.file), video.media.mimeType);
    else await sendFile(req, res, video.media.path, '');
  } }));

  if (linkedMedia) {
    // Desktop shell only (ADR-0002): registers a file the user picked; the frontend gets an opaque `mediaRef`.
    ctx.effect(() => ctx.rpc.route({ method: 'POST', pattern: /^\/shell\/projects\/media$/, auth: 'shell', async handle(req, res) {
      const { path } = shellLinkSchema.parse(await readBody(req, 64 * 1024));
      const entry = { path, ...await fingerprintFile(path) };
      const mediaRef = randomUUID();
      registered.set(mediaRef, entry);
      while (registered.size > MAX_PENDING) registered.delete(registered.keys().next().value!);
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ mediaRef, name: basename(path), size: entry.size }));
    } }));
  }
  // F-0004: stable Host identity for crash-recovery copies (ADR-0004).
  const identity = await readHostIdentity(ctx.hostConfig.home);
  ctx.effect(() => ctx.rpc.register('projects.identity', undefined, (): HostIdentity => ({ hostId: identity, recovery: RECOVERY_PROTOCOL_VERSION })));

  ctx.effect(() => ctx.rpc.capability('projects'));
  ctx.effect(() => ctx.rpc.capability('projects.linkedMedia', linkedMedia));
} };
