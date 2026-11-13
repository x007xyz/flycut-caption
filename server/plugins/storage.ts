import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { jobIdSchema, type JobSnapshot } from '../../shared/protocol';
import type { AssetService, JobService } from '../services';

const HOUR = 3_600_000;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const storagePlugin = { name: 'flycut-storage', inject: ['hostConfig', 'rpc'], async apply(ctx: Context) {
  const assetsRoot = join(ctx.hostConfig.home, 'assets');
  const jobsRoot = join(ctx.hostConfig.home, 'jobs');
  await Promise.all([mkdir(assetsRoot, { recursive: true }), mkdir(jobsRoot, { recursive: true })]);
  // Assets are files addressed by UUID; bodies are streamed, never buffered whole in the Host.
  const assetPath = (id: string) => { if (!ASSET_ID.test(id)) throw new Error('Invalid asset ID'); return join(assetsRoot, id); };
  const assets: AssetService = {
    async put(bytes) { const id = randomUUID(); await writeFile(join(assetsRoot, id), bytes); return id; },
    async putStream(source, limit) {
      const id = randomUUID(); const target = join(assetsRoot, id); const partial = `${target}.part`;
      let bytes = 0;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length; done(bytes > limit ? new Error('Request body exceeds limit') : null, chunk);
      } });
      try { await pipeline(source, guard, createWriteStream(partial)); await rename(partial, target); }
      catch (error) { await rm(partial, { force: true }); throw error; }
      return id;
    },
    async adopt(file, id = randomUUID()) {
      if (!ASSET_ID.test(id)) throw new Error('Invalid asset ID');
      const target = join(assetsRoot, id);
      const existing = await stat(target).catch(() => undefined);
      if (existing?.isFile()) { await rm(file, { force: true }); return id; }
      await rename(file, target); return id;
    },
    async claim(id, target) { await mkdir(dirname(target), { recursive: true }); await rename(assetPath(id), target); },
    async read(id) { return readFile(assetPath(id)); },
    async size(id) { return (await stat(assetPath(id))).size; },
    path(id) {
      const file = assetPath(id);
      // Using an asset renews its lifetime so long-running jobs keep their inputs.
      const now = new Date(); void utimes(file, now, now).catch(() => undefined);
      return file;
    },
    async delete(id) { await rm(assetPath(id), { force: true }); },
  };
  ctx.provide('assets', assets);
  const assetTtl = (ctx.hostConfig.assetTtlHours ?? 24) * HOUR;
  async function collect() {
    const cutoff = Date.now() - assetTtl;
    for (const name of await readdir(assetsRoot).catch(() => [] as string[])) {
      const file = join(assetsRoot, name);
      const info = await stat(file).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => undefined);
    }
  }
  await collect();
  ctx.effect(() => { const timer = setInterval(() => { void collect(); }, HOUR); timer.unref(); return () => clearInterval(timer); });
  ctx.effect(() => ctx.rpc.register('assets.delete', z.object({ assetId: z.string().regex(ASSET_ID) }), async ({ assetId }) => {
    await assets.delete(assetId); return { deleted: assetId };
  }));
  const records = new Map<string, JobSnapshot>();
  const operationJobs = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const running = new Map<string, Promise<void>>();
  let stopping = false;
  let writes = Promise.resolve();
  const persist = (job: JobSnapshot) => {
    const json = JSON.stringify(job);
    writes = writes.then(async () => {
      const file = join(jobsRoot, `${job.id}.json`);
      await writeFile(`${file}.tmp`, json); await rename(`${file}.tmp`, file);
    });
    return writes;
  };
  for (const file of await readdir(jobsRoot)) {
    if (!file.endsWith('.json')) continue;
    const job = JSON.parse(await readFile(join(jobsRoot, file), 'utf8')) as JobSnapshot;
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'error'; job.error = 'Host restarted before this job settled. Check existing outputs before retrying.';
      job.updatedAt = new Date().toISOString(); await persist(job);
    }
    records.set(job.id, job);
    if (job.operationId) operationJobs.set(job.operationId, job.id);
  }
  // Job changes are ordinary Cordis events; the RPC layer decides whether they cross the connection.
  const publish = (job: JobSnapshot) => {
    try { ctx.emit('job/updated', { job: structuredClone(job) }); } catch (error) { console.error('Job observer failed', error); }
  };
  // Status changes persist immediately; progress-only updates are published at once but written at most once per second.
  const pendingProgress = new Map<string, ReturnType<typeof setTimeout>>();
  const update = async (job: JobSnapshot, patch: Partial<JobSnapshot>) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    publish(job);
    if (patch.status === undefined) {
      if (!pendingProgress.has(job.id)) pendingProgress.set(job.id, setTimeout(() => { pendingProgress.delete(job.id); void persist(job); }, 1000));
      return;
    }
    clearTimeout(pendingProgress.get(job.id)); pendingProgress.delete(job.id);
    await persist(job);
  };
  const service: JobService = {
    get(id) { const job = records.get(id); if (!job) throw new Error('Unknown job'); return structuredClone(job); },
    list() { return [...records.values()].map(job => structuredClone(job)); },
    create(run, options = {}) {
      if (stopping) throw new Error('Host is stopping');
      const existing = options.operationId ? records.get(operationJobs.get(options.operationId) ?? '') : undefined;
      if (existing) return structuredClone(existing);
      const controller = new AbortController();
      const now = new Date().toISOString();
      const job: JobSnapshot = { id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now, ...(options.operationId ? { operationId: options.operationId } : {}) };
      records.set(job.id, job); controllers.set(job.id, controller);
      if (options.operationId) operationJobs.set(options.operationId, job.id);
      const task = (async () => {
        try {
          await update(job, { status: 'running' });
          const result = await run(controller.signal, progress => {
            // ASR complete is a progress event; the job itself settles only after the full graph.
            void update(job, { progress }).catch(error => controller.abort(error));
          }, job.id);
          controller.signal.throwIfAborted();
          await update(job, { status: 'complete', result });
        } catch (error) {
          await update(job, { status: controller.signal.aborted ? 'cancelled' : 'error',
            error: error instanceof Error ? error.message : String(error) });
        } finally { controllers.delete(job.id); running.delete(job.id); }
      })();
      running.set(job.id, task);
      return structuredClone(job);
    },
    async cancel(id) {
      service.get(id); controllers.get(id)?.abort(new Error('Job cancelled'));
      await running.get(id); return service.get(id);
    },
  };
  ctx.provide('jobs', service);
  ctx.effect(() => ctx.rpc.expose('job/updated'));
  ctx.effect(() => ctx.rpc.register('jobs.list', undefined, () => service.list()));
  ctx.effect(() => ctx.rpc.register('jobs.get', jobIdSchema, ({ id }) => service.get(id)));
  ctx.effect(() => ctx.rpc.register('jobs.cancel', jobIdSchema, ({ id }) => service.cancel(id)));
  ctx.effect(() => async () => {
    stopping = true;
    controllers.forEach(controller => controller.abort(new Error('Host stopping')));
    await Promise.allSettled([...running.values()]);
    pendingProgress.forEach(timer => clearTimeout(timer)); pendingProgress.clear();
    await writes;
  });
} };
