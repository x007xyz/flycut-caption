import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  duplicateSchema, projectCreateSchema, projectOpenSchema, relinkSchema, saveEditsSchema, saveTranscriptSchema, shellLinkSchema,
  type ProjectMedia, type ProjectOpenResult, type ProjectPlayback, type ProjectVideo, type SaveResult,
} from '../../shared/projects';
import { fingerprintFile, ProjectStore } from '../projects/store';
import { NewerFormatError } from '../projects/migrations';

export interface ProjectsConfig {
  /**
   * Desktop only: projects may reference files on this machine that the shell registered (ADR-0002).
   * The `server` profile turns it off; linked media then always reads as missing.
   */
  linkedMedia?: boolean;
}

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

/**
 * Project storage (F-0002, ADR-0001): the only reader and writer of `<home>/projects`.
 * Frontend, CLI and MCP clients all go through these RPC methods.
 */
export const projectsPlugin = { name: 'flycut-projects', inject: ['hostConfig', 'rpc', 'assets'], async apply(ctx: Context, config: ProjectsConfig = {}) {
  const linkedMedia = config.linkedMedia !== false;
  const store = new ProjectStore(ctx.hostConfig.home);
  await store.init();
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

  /** Applies `change` under the project's write lock and bumps the revision. */
  const commit = (projectId: string, change: (project: Awaited<ReturnType<ProjectStore['read']>>) => Promise<void> | void): Promise<SaveResult> =>
    store.exclusive(projectId, async () => {
      const project = await store.read(projectId);
      await change(project);
      project.revision += 1; project.updatedAt = new Date().toISOString();
      await store.writeProject(project);
      return { status: 'saved', revision: project.revision, updatedAt: project.updatedAt };
    });

  ctx.effect(() => ctx.rpc.register('projects.list', undefined, () => store.list((id, media) => mediaStatus(id, media))));

  ctx.effect(() => ctx.rpc.register('projects.create', projectCreateSchema, async input => {
    const project = await store.create({ name: input.name, video: { name: input.videoName, durationSeconds: input.durationSeconds },
      media: (projectId, videoId) => resolveMedia(projectId, videoId, input.media, input.videoName) });
    if ('mediaRef' in input.media) registered.delete(input.media.mediaRef);
    return { projectId: project.id, videoId: project.videos[0].id, revision: project.revision, project };
  }));

  ctx.effect(() => ctx.rpc.register('projects.open', projectOpenSchema, async ({ projectId, videoId }): Promise<ProjectOpenResult> => {
    let project;
    try { project = await store.read(projectId); }
    catch (error) { if (error instanceof NewerFormatError) return { status: 'newer-version', name: error.projectName }; throw error; }
    const video = videoId ? project.videos.find(item => item.id === videoId) : project.videos[0];
    if (!video) throw new Error('项目里没有这个视频');
    const [transcript, edits, media] = await Promise.all([store.readTranscript(projectId, video.id), store.readEdits(projectId, video.id),
      mediaStatus(projectId, video.media, true)]);
    const name = video.media.kind === 'linked' ? basename(video.media.path) : video.name;
    return { status: 'ok', project, video, transcript, edits,
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
      const project = await store.read(projectId);
      if (!project.videos.some(item => item.id === videoId)) throw new Error('项目里没有这个视频');
      if (project.revision !== baseRevision && !force) return { status: 'conflict', revision: project.revision, updatedAt: project.updatedAt };
      await store.writeEdits(projectId, videoId, edits);
      project.revision += 1; project.updatedAt = new Date().toISOString();
      await store.writeProject(project);
      return { status: 'saved', revision: project.revision, updatedAt: project.updatedAt };
    })));

  // Save as new project (AC-25): the original keeps the other window's version.
  ctx.effect(() => ctx.rpc.register('projects.duplicate', duplicateSchema, ({ projectId, videoId, name, edits }) =>
    store.exclusive(projectId, async () => {
      const copy = await store.duplicate(projectId, name);
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
    })));

  // Project media for players: Range requests, same token as RPC.
  ctx.effect(() => ctx.rpc.route({ method: 'GET', pattern: MEDIA_ROUTE, auth: 'client', async handle(req, res, match) {
    const [, projectId, videoId] = match;
    const project = await store.read(projectId);
    const video = project.videos.find(item => item.id === videoId);
    if (!video || (await mediaStatus(projectId, video.media)) === 'missing') { res.writeHead(404); res.end(); return; }
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
  ctx.effect(() => ctx.rpc.capability('projects'));
  ctx.effect(() => ctx.rpc.capability('projects.linkedMedia', linkedMedia));
} };
