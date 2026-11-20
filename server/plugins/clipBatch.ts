import type { Context } from '@deepseek-ai/cordis';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clipBatchCancelInputSchema, clipBatchSnapshotSchema, clipBatchStartInputSchema, clipBatchStatusInputSchema,
  type ClipBatchSnapshot } from '../../shared/clips';

export const clipBatchPlugin = { name: 'flycut-clip-batch', inject: ['hostConfig', 'rpc', 'jobs', 'assets', 'export', 'projectStore'], apply(ctx: Context) {
  const store = ctx.projectStore;
  const fileFor = (projectId: string, requestId: string) => join(ctx.hostConfig.home, 'batch-exports', projectId, `${requestId}.json`);

  const read = async (projectId: string, requestId: string): Promise<ClipBatchSnapshot | null> => {
    try { return clipBatchSnapshotSchema.parse(JSON.parse(await readFile(fileFor(projectId, requestId), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const persist = async (snapshot: ClipBatchSnapshot) => {
    const file = fileFor(snapshot.projectId, snapshot.requestId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2)); await rename(tmp, file);
    return snapshot;
  };
  const execute = (snapshot: ClipBatchSnapshot, onlyFailed = false) => {
    const job = ctx.jobs.create(async (signal, report) => {
      const project = await store.read(snapshot.projectId);
      const video = project.videos.find(item => item.id === snapshot.videoId);
      if (!video) throw new Error('视频不存在');
      const media = video.media.kind === 'stored' ? store.mediaFile(snapshot.projectId, video.media.file) : video.media.path;
      const clipsDir = join(store.videoDir(snapshot.projectId, snapshot.videoId), 'clips');
      await mkdir(clipsDir, { recursive: true });
      const items = JSON.parse(await readFile(fileFor(snapshot.projectId, snapshot.requestId), 'utf8')) as ClipBatchSnapshot;
      const source = (await store.readEdits(snapshot.projectId, snapshot.videoId))?.clips ?? [];
      let done = 0;
      for (const item of items.items) {
        if (signal.aborted) { item.status = 'cancelled'; continue; }
        if (onlyFailed && item.status !== 'failed') continue;
        const definition = source.find(clip => clip.id === item.clipId);
        if (!definition) { item.status = 'failed'; item.error = '短片不存在'; continue; }
        item.status = 'running'; items.updatedAt = new Date().toISOString(); await persist(items);
        try {
          const result = await ctx.export.runFromFile(media, {
            segments: [{ start: definition.start, end: definition.end, keep: true }],
            options: { format: 'mp4', quality: 'high', preserveAudio: true, subtitleProcessing: 'none', crop: '9:16' },
          }, signal, progress => report({ status: 'running', progress: Math.round((done + (progress.progress ?? 0) / 100) / items.items.length * 100),
            data: `${done + 1}/${items.items.length} ${item.name}` }));
          const target = join(clipsDir, `${item.clipId}.mp4`);
          await copyFile(ctx.assets.path(result.assetId), target);
          void ctx.assets.delete(result.assetId).catch(() => undefined);
          item.status = 'saved'; item.outputFile = `clips/${item.clipId}.mp4`; item.error = undefined;
        } catch (error) {
          if (signal.aborted) item.status = 'cancelled';
          else { item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error); }
        }
        done += 1; items.updatedAt = new Date().toISOString(); await persist(items);
      }
      items.status = signal.aborted ? 'cancelled' : items.items.some(item => item.status === 'failed') ? 'partial' : 'completed';
      items.updatedAt = new Date().toISOString(); items.jobId = job.id; await persist(items);
      return items;
    });
    snapshot.jobId = job.id;
    return snapshot;
  };

  ctx.effect(() => ctx.rpc.register('clips.batchStart', clipBatchStartInputSchema, async input => {
    const existing = await read(input.projectId, input.requestId);
    if (existing) return existing;
    const snapshot: ClipBatchSnapshot = { requestId: input.requestId, projectId: input.projectId, videoId: input.videoId,
      status: 'queued', items: input.items.map(item => ({ clipId: item.clipId, name: item.name, status: 'pending' })),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await persist(snapshot);
    return persist(execute(snapshot));
  }));
  ctx.effect(() => ctx.rpc.register('clips.batchStatus', clipBatchStatusInputSchema, ({ projectId, requestId }) => read(projectId, requestId)));
  ctx.effect(() => ctx.rpc.register('clips.batchCancel', clipBatchCancelInputSchema, async ({ projectId, requestId }) => {
    const snapshot = await read(projectId, requestId);
    if (!snapshot) return null;
    if (snapshot.jobId) await ctx.jobs.cancel(snapshot.jobId).catch(() => undefined);
    for (const item of snapshot.items) if (['pending', 'running'].includes(item.status)) item.status = 'cancelled';
    snapshot.status = 'cancelled'; snapshot.updatedAt = new Date().toISOString();
    return persist(snapshot);
  }));
  ctx.effect(() => ctx.rpc.register('clips.batchRetry', clipBatchStatusInputSchema, async ({ projectId, requestId }) => {
    const snapshot = await read(projectId, requestId);
    if (!snapshot) return null;
    for (const item of snapshot.items) if (item.status === 'failed') item.status = 'pending';
    snapshot.status = 'queued'; snapshot.updatedAt = new Date().toISOString();
    await persist(snapshot);
    return persist(execute(snapshot, true));
  }));
} };
