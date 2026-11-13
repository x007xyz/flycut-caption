import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ttsSettingsSaveInputSchema,
  ttsSynthesizeInputSchema,
  type StoredTtsSettings,
  type TtsAuditionSummary,
  type TtsSettingsSaveResult,
  type TtsSettingsSnapshot,
  type TtsSynthesizeResult,
} from '../../shared/tts/settings';
import { readHostIdentity } from './projects';

function isStoredTtsSettings(value: unknown): value is StoredTtsSettings {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<StoredTtsSettings>;
  return data.formatVersion === 1
    && typeof data.hostId === 'string'
    && Number.isInteger(data.revision)
    && (data.selectedModel === null || (typeof data.selectedModel === 'object' && !!data.selectedModel))
    && (data.voiceId === null || typeof data.voiceId === 'string')
    && typeof data.language === 'string'
    && typeof data.speed === 'number'
    && !!data.options && typeof data.options === 'object'
    && !!data.operations && typeof data.operations === 'object';
}

export const ttsPlugin = {
  name: 'flycut-tts',
  inject: ['hostConfig', 'providers', 'jobs', 'assets', 'rpc'],
  async apply(ctx: Context) {
    const file = join(ctx.hostConfig.home, 'tts-settings.json');
    const hostId = await readHostIdentity(ctx.hostConfig.home);

    let data: StoredTtsSettings;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!isStoredTtsSettings(parsed)) throw new Error('TTS 设置文件格式无效');
      if (parsed.hostId !== hostId) throw new Error('TTS 设置文件属于另一个 Host');
      data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = {
        formatVersion: 1,
        hostId,
        revision: 0,
        selectedModel: null,
        voiceId: null,
        language: 'auto',
        speed: 1,
        options: {},
        lastAudition: null,
        operations: {},
      };
    }

    let writes = Promise.resolve();
    function exclusive<T>(run: () => Promise<T>): Promise<T> {
      const task = writes.then(run);
      writes = task.then(() => undefined, () => undefined);
      return task;
    }

    async function persist(next: StoredTtsSettings) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      data = next;
    }

    function snapshot(): TtsSettingsSnapshot {
      const current = data;
      return {
        hostId,
        revision: current.revision,
        selectedModel: current.selectedModel ? { ...current.selectedModel } : null,
        voiceId: current.voiceId,
        language: current.language,
        speed: current.speed,
        options: { ...current.options },
        lastAudition: current.lastAudition ? { ...current.lastAudition } : null,
        ...(current.lastOperationId ? { lastOperationId: current.lastOperationId } : {}),
      };
    }

    ctx.effect(() => ctx.rpc.register('tts.getSettings', undefined, () => snapshot()));

    ctx.effect(() => ctx.rpc.register('tts.saveSettings', ttsSettingsSaveInputSchema, input =>
      exclusive(async (): Promise<TtsSettingsSaveResult> => {
        if (input.hostId !== hostId) throw new Error('目标 Host 已变化，请重新检查');
        const requestDigest = createHash('sha256').update(JSON.stringify(input.settings)).digest('hex');
        if (input.operationId) {
          const previous = data.operations[input.operationId];
          if (previous) {
            if (previous.requestDigest !== requestDigest) {
              throw new Error('操作标识已用于另一组 TTS 设置，请重新检查');
            }
            return { status: 'saved', duplicate: true, snapshot: snapshot() };
          }
        }
        if (input.expectedRevision !== data.revision) {
          return { status: 'conflict', snapshot: snapshot() };
        }
        const operations: StoredTtsSettings['operations'] = input.operationId
          ? Object.fromEntries(Object.entries({ ...data.operations, [input.operationId]: { requestDigest, revision: data.revision + 1 } }).slice(-100)) as StoredTtsSettings['operations']
          : data.operations;
        await persist({
          ...data,
          revision: data.revision + 1,
          selectedModel: input.settings.selectedModel ? { ...input.settings.selectedModel } : null,
          voiceId: input.settings.voiceId,
          language: input.settings.language,
          speed: input.settings.speed,
          options: { ...input.settings.options },
          operations,
          ...(input.operationId ? { lastOperationId: input.operationId } : {}),
        });
        return { status: 'saved', snapshot: snapshot() };
      })));

    ctx.effect(() => ctx.rpc.register('tts.synthesize', ttsSynthesizeInputSchema, input =>
      ctx.jobs.create(async (signal, report): Promise<TtsSynthesizeResult> => {
        const req = input.request;
        let referenceAudioPath: string | undefined;
        if (req.cloneReferenceAssetId) {
          const size = await ctx.assets.size(req.cloneReferenceAssetId).catch(() => 0);
          if (size <= 0) throw new Error('声音克隆参考音频样本不存在或为空');
          referenceAudioPath = ctx.assets.path(req.cloneReferenceAssetId);
        }
        const output = await ctx.providers.synthesize({ ...req, referenceAudioPath }, signal, report);
        signal.throwIfAborted();
        const assetId = await ctx.assets.put(output.bytes);
        const summary: TtsAuditionSummary = {
          assetId,
          text: req.text.slice(0, 500),
          model: { providerId: req.providerId, modelId: req.modelId },
          ...(req.voiceId ? { voiceId: req.voiceId } : {}),
          language: req.language,
          mimeType: output.mimeType,
          format: output.format,
          byteLength: output.byteLength,
          ...(output.durationSeconds !== undefined ? { durationSeconds: output.durationSeconds } : {}),
          ...(output.sampleRate !== undefined ? { sampleRate: output.sampleRate } : {}),
          verifiedAt: new Date().toISOString(),
        };
        await exclusive(async () => {
          await persist({ ...data, lastAudition: summary });
        });
        return {
          ...summary,
          cloned: Boolean(req.cloneReferenceAssetId),
        };
      }, { operationId: input.operationId })));
  },
};
