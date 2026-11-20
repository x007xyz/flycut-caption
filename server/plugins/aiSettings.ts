import type { Context } from '@deepseek-ai/cordis';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  aiSettingsImportInputSchema, aiSettingsRemoveInputSchema, aiSettingsSaveInputSchema, aiSettingsSelectInputSchema,
  aiSettingsTestInputSchema, type AIConfigView, type AISettingsMutationResult,
  type AISettingsRemoveResult, type AISettingsSaveResult, type AISettingsSnapshot,
  type AISettingsTestResult, type StoredAISettings,
} from '../../shared/aiSettings';
import type { AISettingsService } from '../services';
import { assertServiceUrl } from '../urlPolicy';
import { readHostIdentity } from './projects';
import { EncryptedFileAISecretStore, MemoryAISecretStore, OsAISecretStore, type AISecretStore } from '../aiSettings/secrets';

export interface AISettingsConfig {
  /** `auto` uses the desktop OS store, or the encrypted file when an operator key is configured. */
  secretBackend?: 'auto' | 'memory' | 'encrypted-file';
  /** The server profile disables loopback/private-network destinations (SSRF). */
  privateNetwork?: boolean;
}

type StoredConfig = StoredAISettings['configs'][number];

function isStored(value: unknown): value is StoredAISettings {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<StoredAISettings>;
  return data.formatVersion === 1 && typeof data.hostId === 'string' && Number.isInteger(data.revision)
    && (data.selectedId === null || typeof data.selectedId === 'string') && Array.isArray(data.configs)
    && !!data.migrations && typeof data.migrations === 'object';
}

function secretBackend(config: AISettingsConfig, home: string): AISecretStore {
  if (config.secretBackend === 'memory') return new MemoryAISecretStore();
  const envKey = process.env.FLYCUT_AI_SECRET_KEY;
  if (config.secretBackend === 'encrypted-file' || envKey) return new EncryptedFileAISecretStore(join(home, 'ai-secrets.enc'), envKey);
  return new OsAISecretStore();
}

export const aiSettingsPlugin = { name: 'flycut-ai-settings', inject: ['hostConfig', 'rpc'], async apply(ctx: Context, config: AISettingsConfig = {}) {
  const allowPrivateNetwork = config.privateNetwork !== false;
  const file = join(ctx.hostConfig.home, 'ai-settings.json');
  const hostId = await readHostIdentity(ctx.hostConfig.home);
  const secrets = secretBackend(config, ctx.hostConfig.home);

  let data: StoredAISettings;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!isStored(parsed)) throw new Error('AI 设置文件格式无效');
    if (parsed.hostId !== hostId) throw new Error('AI 设置文件属于另一个 Host');
    data = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    data = { formatVersion: 1, hostId, revision: 0, selectedId: null, configs: [], migrations: {} };
  }

  let writes = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const task = writes.then(run);
    writes = task.then(() => undefined, () => undefined);
    return task;
  }

  async function persist(next: StoredAISettings) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try { await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(tmp, file); }
    catch (error) { await rm(tmp, { force: true }).catch(() => undefined); throw error; }
    data = next;
  }

  async function snapshot(): Promise<AISettingsSnapshot> {
    // Capture one immutable revision generation: a concurrent commit must never pair old configs
    // with a newer revision (or the reverse) in one RPC response.
    const current = data;
    const configs = await Promise.all(current.configs.map(async (item): Promise<AIConfigView> => ({
      id: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model, temperature: item.temperature,
      ...(item.headers ? { headers: item.headers } : {}),
      hasApiKey: !!item.secretRef && !!(await secrets.get(item.secretRef)),
    })));
    return { hostId, revision: current.revision, selectedId: current.selectedId, configs };
  }

  function validate(config: Pick<StoredConfig, 'baseUrl'>) { assertServiceUrl(config.baseUrl, allowPrivateNetwork); }
  function requireHost(inputHostId: string) { if (inputHostId !== hostId) throw new Error('目标 Host 已变化，请重新检查'); }

  const service: AISettingsService = {
    snapshot,
    async resolve(configId) {
      const config = data.configs.find(item => item.id === configId);
      if (!config) throw new Error('AI 配置不存在，请刷新后重试');
      validate(config);
      if (!config.secretRef) throw new Error('AI 配置未设置 API Key');
      const apiKey = await secrets.get(config.secretRef);
      if (!apiKey) throw new Error('AI 配置的 Key 不可用，请重新输入');
      return { id: config.id, name: config.name, baseUrl: config.baseUrl, model: config.model, temperature: config.temperature,
        ...(config.headers ? { headers: config.headers } : {}), apiKey };
    },
    save(input) {
      return exclusive(async (): Promise<AISettingsSaveResult> => {
        validate(input.config);
        if (input.expectedRevision !== data.revision) return { status: 'conflict', snapshot: await snapshot() };
        const existing = input.configId ? data.configs.find(item => item.id === input.configId) : undefined;
        if (input.configId && !existing) throw new Error('AI 配置不存在，请刷新后重试');
        if (input.config.apiKey && input.config.clearApiKey) throw new Error('不能同时设置和清除 API Key');
        if (!existing && !input.config.apiKey?.trim()) throw new Error('新增 AI 配置时必须填写 API Key');

        const id = existing?.id ?? randomUUID();
        const oldRef = existing?.secretRef;
        const newRef = input.config.apiKey?.trim() ? randomUUID() : undefined;
        if (newRef) await secrets.set(newRef, input.config.apiKey!.trim());
        const nextConfig: StoredConfig = {
          id, name: input.config.name, baseUrl: input.config.baseUrl, model: input.config.model,
          ...(input.config.temperature === undefined ? {} : { temperature: input.config.temperature }),
          ...(input.config.headers ? { headers: input.config.headers } : {}),
          ...(newRef ? { secretRef: newRef } : newRef === undefined && input.config.clearApiKey ? {} : oldRef ? { secretRef: oldRef } : {}),
          ...(existing?.sourceId ? { sourceId: existing.sourceId } : {}),
        };
        const configs = existing
          ? data.configs.map(item => item.id === id ? nextConfig : item)
          : [...data.configs, nextConfig];
        const next: StoredAISettings = { ...data, revision: data.revision + 1, selectedId: data.selectedId ?? id, configs };
        try { await persist(next); }
        catch (error) { if (newRef) await secrets.delete(newRef).catch(() => undefined); throw error; }
        if (newRef && oldRef && oldRef !== newRef) await secrets.delete(oldRef).catch(() => undefined);
        if (!newRef && input.config.clearApiKey && oldRef) await secrets.delete(oldRef).catch(() => undefined);
        return { status: 'saved', configId: id, snapshot: await snapshot() };
      });
    },
    remove(configId, expectedRevision) {
      return exclusive(async (): Promise<AISettingsRemoveResult> => {
        if (expectedRevision !== data.revision) return { status: 'conflict', snapshot: await snapshot() };
        const removed = data.configs.find(item => item.id === configId);
        if (!removed) throw new Error('AI 配置不存在，请刷新后重试');
        const configs = data.configs.filter(item => item.id !== configId);
        const selectedId = data.selectedId === configId ? (configs[0]?.id ?? null) : data.selectedId;
        await persist({ ...data, revision: data.revision + 1, selectedId, configs });
        if (removed.secretRef) await secrets.delete(removed.secretRef).catch(() => undefined);
        return { status: 'removed', removed: configId, snapshot: await snapshot() };
      });
    },
    select(configId, expectedRevision) {
      return exclusive(async (): Promise<AISettingsMutationResult> => {
        if (expectedRevision !== data.revision) return { status: 'conflict', snapshot: await snapshot() };
        if (configId && !data.configs.some(item => item.id === configId)) throw new Error('AI 配置不存在，请刷新后重试');
        await persist({ ...data, revision: data.revision + 1, selectedId: configId });
        return { status: 'saved', snapshot: await snapshot() };
      });
    },
    async test(configId): Promise<AISettingsTestResult> {
      const config = await service.resolve(configId);
      try {
        const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        return response.ok ? { status: 'ok', message: `连接成功 (HTTP ${response.status})` }
          : { status: 'error', message: `连接失败 (HTTP ${response.status})` };
      } catch { return { status: 'error', message: '连接失败，请检查地址和网络' }; }
    },
    import(input) {
      return exclusive(async () => {
        const requestDigest = createHash('sha256').update(JSON.stringify({ selectedSourceId: input.selectedSourceId ?? null,
          configs: input.configs })).digest('hex');
        const previous = data.migrations[input.migrationId];
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw new Error('迁移标识已用于另一批配置，请重新检查');
          return { status: 'imported' as const, duplicate: true, configIds: previous.configIds, snapshot: await snapshot() };
        }
        if (input.expectedRevision !== data.revision) return { status: 'conflict' as const, snapshot: await snapshot() };
        for (const item of input.configs) validate(item);

        const added: StoredConfig[] = []; const createdRefs: string[] = []; const configIds: string[] = [];
        const sources = new Map(data.configs.flatMap(config => config.sourceId ? [[config.sourceId, config] as const] : []));
        let committed = false;
        try {
          for (const item of input.configs) {
            const duplicate = sources.get(item.sourceId);
            if (duplicate) { configIds.push(duplicate.id); continue; }
            const secretRef = item.apiKey?.trim() ? randomUUID() : undefined;
            if (secretRef) { await secrets.set(secretRef, item.apiKey!.trim()); createdRefs.push(secretRef); }
            const config: StoredConfig = { id: randomUUID(), name: item.name, baseUrl: item.baseUrl, model: item.model,
              ...(item.temperature === undefined ? {} : { temperature: item.temperature }),
              ...(secretRef ? { secretRef } : {}), sourceId: item.sourceId };
            added.push(config); configIds.push(config.id);
            sources.set(item.sourceId, config);
          }
          const selected = input.selectedSourceId
            ? configIds[input.configs.findIndex(item => item.sourceId === input.selectedSourceId)] ?? data.selectedId : data.selectedId;
          const migrations = { ...data.migrations, [input.migrationId]: { configIds, requestDigest } };
          const trimmed = Object.fromEntries(Object.entries(migrations).slice(-200));
          await persist({ ...data, revision: data.revision + 1, selectedId: selected ?? added[0]?.id ?? data.selectedId,
            configs: [...data.configs, ...added], migrations: trimmed });
          committed = true;
        } catch (error) {
          if (!committed) await Promise.all(createdRefs.map(ref => secrets.delete(ref).catch(() => undefined)));
          throw error;
        }
        return { status: 'imported' as const, duplicate: false, configIds, snapshot: await snapshot() };
      });
    },
  };
  ctx.provide('aiSettings', service);

  ctx.effect(() => ctx.rpc.register('aiSettings.list', undefined, () => snapshot()));
  ctx.effect(() => ctx.rpc.register('aiSettings.save', aiSettingsSaveInputSchema, input => {
    requireHost(input.hostId); return service.save({ expectedRevision: input.expectedRevision, configId: input.configId, config: input.config });
  }));
  ctx.effect(() => ctx.rpc.register('aiSettings.remove', aiSettingsRemoveInputSchema, input => {
    requireHost(input.hostId); return service.remove(input.configId, input.expectedRevision);
  }));
  ctx.effect(() => ctx.rpc.register('aiSettings.select', aiSettingsSelectInputSchema, input => {
    requireHost(input.hostId); return service.select(input.configId, input.expectedRevision);
  }));
  ctx.effect(() => ctx.rpc.register('aiSettings.test', aiSettingsTestInputSchema, input => {
    requireHost(input.hostId); return service.test(input.configId);
  }));
  ctx.effect(() => ctx.rpc.register('aiSettings.import', aiSettingsImportInputSchema, input => {
    requireHost(input.hostId); return service.import({ expectedRevision: input.expectedRevision, migrationId: input.migrationId,
      selectedSourceId: input.selectedSourceId, configs: input.configs });
  }));
  ctx.effect(() => ctx.rpc.capability('aiSettings', true));
} };
