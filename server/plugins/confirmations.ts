import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  confirmationConsumeInputSchema,
  confirmationCreateInputSchema,
  confirmationDecideInputSchema,
  confirmationIdSchema,
  confirmationListInputSchema,
  type ConfirmationRequest,
  type ConfirmationTarget,
  type ConfirmationKind,
  type ConfirmationSource,
} from '../../shared/confirmations';
import { HostRpcError } from '../../shared/errors';

export interface ConfirmationsConfig {
  ttlHours?: number;
  trashRetentionHours?: number;
}

const HOUR = 3_600_000;
const ID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

function defaultSummary(kind: ConfirmationKind, target: ConfirmationTarget): string {
  const project = target.projectName ?? target.projectId ?? '';
  const video = target.videoName ?? target.videoId ?? '';
  switch (kind) {
    case 'trash-project': return `将项目「${project}」移入回收站`;
    case 'purge-project': return `彻底删除项目「${project}」及其媒体文件`;
    case 'remove-video': return `从项目「${project}」移除视频「${video}」`;
    case 'overwrite-export': return `覆盖导出文件「${target.outputName ?? 'export'}」`;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const confirmationsPlugin = {
  name: 'flycut-confirmations',
  inject: ['hostConfig', 'rpc', 'projectStore'],
  async apply(ctx: Context, config: ConfirmationsConfig = {}) {
    const root = join(ctx.hostConfig.home, 'confirmations');
    await mkdir(root, { recursive: true });
    const ttlMs = Math.max(1000, (config.ttlHours ?? 24) * HOUR);
    const retentionMs = (config.trashRetentionHours ?? 30 * 24) * HOUR;
    const store = ctx.projectStore;

    const records = new Map<string, ConfirmationRequest>();
    const operationIndex = new Map<string, string>();
    const locks = new Map<string, Promise<unknown>>();

    const exclusive = <T>(id: string, task: () => Promise<T>): Promise<T> => {
      const prev = locks.get(id) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(task);
      locks.set(id, next);
      void next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => undefined);
      return next;
    };

    const publish = (confirmation: ConfirmationRequest) => {
      try { ctx.emit('confirmation/updated', { confirmation: structuredClone(confirmation) }); }
      catch (error) { console.error('Confirmation observer failed', error); }
    };

    const persist = async (record: ConfirmationRequest) => {
      await writeJsonAtomic(join(root, `${record.id}.json`), record);
      records.set(record.id, record);
      if (record.operationId) operationIndex.set(record.operationId, record.id);
    };

    const expireIfNeeded = async (record: ConfirmationRequest): Promise<ConfirmationRequest> => {
      if ((record.status === 'pending' || record.status === 'approved') && Date.parse(record.expiresAt) <= Date.now()) {
        const next: ConfirmationRequest = { ...record, status: 'expired', updatedAt: new Date().toISOString() };
        await persist(next);
        publish(next);
        return next;
      }
      return record;
    };

    for (const file of await readdir(root).catch(() => [] as string[])) {
      if (!ID_FILE.test(file)) continue;
      try {
        const parsed = JSON.parse(await readFile(join(root, file), 'utf8')) as ConfirmationRequest;
        records.set(parsed.id, parsed);
        if (parsed.operationId) operationIndex.set(parsed.operationId, parsed.id);
        await expireIfNeeded(parsed);
      } catch (error) {
        console.warn(`[confirmations] 跳过无效确认记录 ${file}:`, error instanceof Error ? error.message : error);
      }
    }

    const enrichAndValidateTarget = async (kind: ConfirmationKind, target: ConfirmationTarget): Promise<ConfirmationTarget> => {
      if (!target.projectId) throw new HostRpcError('INVALID_ARGUMENT', '确认请求缺少 projectId');
      const project = await store.read(target.projectId).catch((err) => {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new HostRpcError('NOT_FOUND', `项目不存在：${target.projectId}`);
        throw err;
      });
      if (kind === 'trash-project') {
        if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」已在回收站中`);
        return { ...target, projectName: target.projectName ?? project.name };
      }
      if (kind === 'purge-project') {
        if (!project.deletedAt) throw new HostRpcError('INVALID_ARGUMENT', `项目「${project.name}」不在回收站中，请先移入回收站`);
        return { ...target, projectName: target.projectName ?? project.name };
      }
      if (kind === 'remove-video') {
        if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」在回收站中`);
        if (!target.videoId) throw new HostRpcError('INVALID_ARGUMENT', '移除视频确认请求缺少 videoId');
        const video = project.videos.find(v => v.id === target.videoId);
        if (!video) throw new HostRpcError('NOT_FOUND', `视频不存在：${target.videoId}`);
        return { ...target, projectName: target.projectName ?? project.name, videoName: target.videoName ?? video.name };
      }
      // overwrite-export
      if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」在回收站中`);
      if (!target.outputName) throw new HostRpcError('INVALID_ARGUMENT', '覆盖导出确认请求缺少 outputName');
      const video = target.videoId ? project.videos.find(v => v.id === target.videoId) : project.videos[0];
      return {
        ...target,
        projectName: target.projectName ?? project.name,
        ...(video ? { videoId: video.id, videoName: target.videoName ?? video.name } : {}),
      };
    };

    const executeApprovedTarget = async (record: ConfirmationRequest): Promise<unknown> => {
      const projectId = record.target.projectId;
      if (!projectId) throw new HostRpcError('INVALID_ARGUMENT', '确认请求缺少 projectId');
      return store.exclusive(projectId, async () => {
        const project = await store.read(projectId).catch((err) => {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new HostRpcError('NOT_FOUND', `项目不存在：${projectId}`);
          throw err;
        });
        if (record.kind === 'trash-project') {
          if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」已在回收站中`);
          const now = Date.now();
          project.deletedAt = new Date(now).toISOString();
          project.purgeAfter = new Date(now + retentionMs).toISOString();
          project.revision += 1;
          await store.writeProject(project);
          return { deletedAt: project.deletedAt, purgeAfter: project.purgeAfter };
        }
        if (record.kind === 'purge-project') {
          if (!project.deletedAt) throw new HostRpcError('INVALID_ARGUMENT', `项目「${project.name}」不在回收站中`);
          await store.purge(projectId);
          return { ok: true };
        }
        if (record.kind === 'remove-video') {
          if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', `项目「${project.name}」在回收站中`);
          const videoId = record.target.videoId;
          const video = project.videos.find(v => v.id === videoId);
          if (!video) throw new HostRpcError('NOT_FOUND', `视频不存在：${videoId}`);
          project.style ??= await store.projectStyle(project);
          project.videos = project.videos.filter(v => v.id !== videoId);
          project.revision += 1;
          project.updatedAt = new Date().toISOString();
          await store.writeProject(project);
          await store.removeVideoFiles(projectId, video);
          return { revision: project.revision };
        }
        return undefined;
      });
    };

    ctx.effect(() => ctx.rpc.expose('confirmation/updated'));
    ctx.effect(() => ctx.rpc.capability('confirmations'));

    ctx.effect(() => ctx.rpc.register('confirmations.create', confirmationCreateInputSchema, async input => {
      if (input.operationId) {
        const existingId = operationIndex.get(input.operationId);
        const existing = existingId ? records.get(existingId) : undefined;
        if (existing) {
          const settled = await expireIfNeeded(existing);
          if (settled.status !== 'expired') return structuredClone(settled);
        }
      }
      const target = await enrichAndValidateTarget(input.kind, input.target);
      const id = randomUUID();
      const now = Date.now();
      const record: ConfirmationRequest = {
        id,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        kind: input.kind,
        source: (input.source ?? 'cli') as ConfirmationSource,
        target,
        summary: input.summary?.trim() || defaultSummary(input.kind, target),
        status: 'pending',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      await exclusive(id, async () => {
        await persist(record);
        publish(record);
      });
      return structuredClone(record);
    }));

    ctx.effect(() => ctx.rpc.register('confirmations.list', confirmationListInputSchema, async input => {
      const list = await Promise.all([...records.values()].map(item => expireIfNeeded(item)));
      const filtered = input?.status === 'pending' ? list.filter(item => item.status === 'pending') : list;
      return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => structuredClone(item));
    }));

    ctx.effect(() => ctx.rpc.register('confirmations.get', confirmationIdSchema, async ({ id }) => {
      const found = records.get(id);
      if (!found) throw new HostRpcError('NOT_FOUND', `确认请求不存在：${id}`);
      return structuredClone(await expireIfNeeded(found));
    }));

    ctx.effect(() => ctx.rpc.register('confirmations.decide', confirmationDecideInputSchema, async ({ id, decision }) => {
      return exclusive(id, async () => {
        const found = records.get(id);
        if (!found) throw new HostRpcError('NOT_FOUND', `确认请求不存在：${id}`);
        const current = await expireIfNeeded(found);
        if (current.status === 'expired') throw new HostRpcError('CONFIRMATION_EXPIRED', '确认请求已过期，请重新发起');
        if (current.status !== 'pending') {
          throw new HostRpcError('VERSION_CONFLICT', `确认请求状态已是 ${current.status}，无法重复处理`, { status: current.status });
        }
        const now = new Date().toISOString();
        if (decision === 'reject') {
          const rejected: ConfirmationRequest = {
            ...current,
            status: 'rejected',
            decidedAt: now,
            decidedBy: 'ui-client',
            updatedAt: now,
          };
          await persist(rejected);
          publish(rejected);
          return structuredClone(rejected);
        }
        if (current.kind === 'overwrite-export') {
          const approved: ConfirmationRequest = {
            ...current,
            status: 'approved',
            decidedAt: now,
            decidedBy: 'ui-client',
            updatedAt: now,
          };
          await persist(approved);
          publish(approved);
          return structuredClone(approved);
        }
        const result = await executeApprovedTarget(current);
        const executed: ConfirmationRequest = {
          ...current,
          status: 'executed',
          decidedAt: now,
          decidedBy: 'ui-client',
          executedAt: now,
          updatedAt: now,
          result,
        };
        await persist(executed);
        publish(executed);
        return structuredClone(executed);
      });
    }));

    ctx.effect(() => ctx.rpc.register('confirmations.consume', confirmationConsumeInputSchema, async ({ id }) => {
      return exclusive(id, async () => {
        const found = records.get(id);
        if (!found) throw new HostRpcError('NOT_FOUND', `确认请求不存在：${id}`);
        const current = await expireIfNeeded(found);
        if (current.kind !== 'overwrite-export') {
          throw new HostRpcError('INVALID_ARGUMENT', '只有覆盖导出确认支持一次性消费');
        }
        if (current.status === 'expired') throw new HostRpcError('CONFIRMATION_EXPIRED', '确认请求已过期');
        if (current.status === 'rejected') throw new HostRpcError('CONFIRMATION_REJECTED', '客户端已拒绝覆盖导出');
        if (current.status === 'consumed') throw new HostRpcError('CONFIRMATION_ALREADY_CONSUMED', '该确认凭据已被消费，请重新发起确认');
        if (current.status !== 'approved') throw new HostRpcError('CONFIRMATION_NOT_APPROVED', '操作尚未在客户端确认，请先在 FlyCut 界面确认');
        const now = new Date().toISOString();
        const consumed: ConfirmationRequest = {
          ...current,
          status: 'consumed',
          executedAt: now,
          updatedAt: now,
        };
        await persist(consumed);
        publish(consumed);
        return structuredClone(consumed);
      });
    }));
  },
};
