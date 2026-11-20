import type { Context } from '@deepseek-ai/cordis';
import { providerPrepareSchema } from '../../shared/protocol';
import { checkAsrRequest, checkTtsRequest, voiceActivityResultSchema, type ModelInfo, type ProviderModels } from '../../shared/providers';
import { validateTranscript } from '../../shared/asr/transcript';
import { validateTtsAudio } from '../../shared/tts/audio';
import type { Provider, ProviderRegistry } from '../services';

const MODELS_TIMEOUT_MS = 10_000;

export const providerRegistryPlugin = { name: 'flycut-provider-registry', inject: ['rpc', 'jobs'], apply(ctx: Context) {
  const providers = new Map<string, Provider>();
  const activePrepares = new Map<string, string>();
  const get = (id: string) => { const provider = providers.get(id); if (!provider) throw new Error(`Provider unavailable: ${id}`); return provider; };
  async function model(provider: Provider, modelId: string, signal?: AbortSignal): Promise<ModelInfo> {
    const found = (await provider.models(signal)).find(item => item.id === modelId);
    if (!found) throw new Error(`${provider.name} 没有模型 ${modelId}`);
    return found;
  }
  const registry: ProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) throw new Error(`Duplicate Provider: ${provider.id}`);
      providers.set(provider.id, provider);
      return () => { if (providers.get(provider.id) === provider) providers.delete(provider.id); };
    },
    get,
    list: () => [...providers.values()].map(({ id, name, kind }) => ({ id, name, kind })),
    models: () => Promise.all([...providers.values()].map(async (provider): Promise<ProviderModels> => {
      const summary = { id: provider.id, name: provider.name, kind: provider.kind };
      try { return { provider: summary, models: await provider.models(AbortSignal.timeout(MODELS_TIMEOUT_MS)) }; }
      catch (error) { return { provider: summary, models: [], error: error instanceof Error ? error.message : String(error) }; }
    })),
    async transcribe(request, audioPath, signal, report) {
      const provider = get(request.providerId);
      if (!provider.transcribe) throw new Error(`${provider.name} 不提供语音识别`);
      const info = await model(provider, request.modelId, signal);
      if (info.role !== 'asr') throw new Error(`${info.name} 不是识别模型`);
      if (info.status === 'download') throw new Error(`模型未下载或校验未完成：${info.name}`);
      if (info.status === 'unavailable') throw new Error(`${info.name} 不可用：${info.reason ?? '未知原因'}`);
      const checked = checkAsrRequest(info, request);
      return validateTranscript(await provider.transcribe(checked, audioPath, signal, report));
    },
    async prepare(ref, signal, report) {
      const provider = get(ref.providerId);
      const info = await model(provider, ref.modelId, signal);
      if (info.status === 'ready') return;
      if (info.status === 'unavailable' || !provider.prepare) throw new Error(`${info.name} 不能下载：${info.reason ?? 'Provider 不支持下载'}`);
      await provider.prepare(ref.modelId, signal, report);
    },
    async detectVoice(ref, audioPath, signal, report) {
      const provider = get(ref.providerId);
      if (!provider.detectVoice) throw new Error(provider.name + ' 不提供人声检测');
      const info = await model(provider, ref.modelId, signal);
      if (info.role !== 'vad') throw new Error(info.name + ' 不是 VAD 模型');
      if (info.status !== 'ready') throw new Error(info.name + ' 不可用：' + (info.reason ?? '模型未就绪'));
      return voiceActivityResultSchema.parse(await provider.detectVoice(ref.modelId, audioPath, signal, report));
    },
    async separate(ref, audioPath, signal, report) {
      const provider = get(ref.providerId);
      if (!provider.separate) throw new Error(provider.name + ' 不支持人声分离');
      const info = await model(provider, ref.modelId, signal);
      if (info.role !== 'separation') throw new Error(info.name + ' 不是人声分离模型');
      if (info.status !== 'ready') throw new Error(info.name + ' 不可用：' + (info.reason ?? '模型未就绪'));
      return provider.separate(ref.modelId, audioPath, signal, report);
    },
    async diarize(ref, audioPath, signal, report) {
      const provider = get(ref.providerId);
      if (!provider.diarize) throw new Error(provider.name + ' 不支持说话人分析');
      const info = await model(provider, ref.modelId, signal);
      if (info.role !== 'speaker') throw new Error(info.name + ' 不是说话人模型');
      if (info.status !== 'ready') throw new Error(info.name + ' 不可用：' + (info.reason ?? '模型未就绪'));
      return provider.diarize(ref.modelId, audioPath, signal, report);
    },
    async synthesize(request, signal, report) {
      const provider = get(request.providerId);
      if (!provider.synthesize) throw new Error(`${provider.name} 不支持语音合成（TTS）`);
      const info = await model(provider, request.modelId, signal);
      checkTtsRequest(info, request);
      if (request.cloneReferenceAssetId && !request.referenceAudioPath) {
        throw new Error('声音克隆缺少可读取的参考音频样本');
      }
      const audio = await provider.synthesize(request, signal, report);
      const validated = validateTtsAudio(audio.bytes, audio.mimeType);
      return { ...validated, bytes: audio.bytes };
    },
  };
  ctx.provide('providers', registry);
  ctx.effect(() => ctx.rpc.register('providers.list', undefined, () => registry.list()));
  ctx.effect(() => ctx.rpc.register('providers.models', undefined, () => registry.models()));
  ctx.effect(() => ctx.rpc.register('providers.prepare', providerPrepareSchema, ref => {
    get(ref.providerId);
    const key = `${ref.providerId}/${ref.modelId}`;
    const existingId = activePrepares.get(key);
    if (existingId) {
      try {
        const existing = ctx.jobs.get(existingId);
        if (existing.status === 'queued' || existing.status === 'running') return existing;
      } catch { /* job missing */ }
      activePrepares.delete(key);
    }
    const job = ctx.jobs.create(async (signal, report) => {
      try { await registry.prepare(ref, signal, report); return ref; }
      finally { if (activePrepares.get(key) === job.id) activePrepares.delete(key); }
    });
    activePrepares.set(key, job.id);
    return job;
  }));
} };
