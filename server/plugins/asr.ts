import type { Context } from '@deepseek-ai/cordis';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { modelIdSchema, type AsrProvider } from '../../shared/protocol';
import { PROVIDER_PACKAGES } from '../../shared/providerCatalog';
import type { SubtitleTranscript } from '../../src/types/subtitle';
import { validateASRApiConfig, normalizeASRApiResponse, mergeASRApiTranscripts, transcriptionEndpoint } from '../../shared/asr/apiProtocol';
import { getWebAsrModel } from '../../shared/asr/webModels';


function wavSamples(bytes: Buffer) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected PCM WAV audio');
  let offset = 12, sampleRate = 0, channels = 0, bits = 0, format = 0;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + size > bytes.length) throw new Error('Truncated WAV');
    if (name === 'fmt ') { format = bytes.readUInt16LE(offset); channels = bytes.readUInt16LE(offset + 2); sampleRate = bytes.readUInt32LE(offset + 4); bits = bytes.readUInt16LE(offset + 14); }
    if (name === 'data') {
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) throw new Error('Expected 16 kHz mono PCM16 WAV');
      const samples = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(offset + i * 2) / 32768;
      return samples;
    }
    offset += size + size % 2;
  }
  throw new Error('Missing WAV data');
}

export const pythonAsrPlugin = { name: 'flycut-asr-python', inject: ['providers', 'python', 'models'], apply(ctx: Context) {
  const provider: AsrProvider = { id: 'python-runtime', name: 'Python Runtime (Qwen / FunASR / sherpa-onnx)',
    async transcribe(input, audioPath, signal, report) {
      report({ status: 'loading', data: '检查后端模型...' });
      const modelResponse = await ctx.python.request('/v1/models', { signal });
      const catalog = await modelResponse.json() as { models: Array<{ id: string }> };
      if (!catalog.models.some(model => model.id === input.modelId)) {
        const resolved = await ctx.models.resolve(input.modelId);
        if (!resolved) throw new Error(`模型未下载：${input.modelId}`);
        const { model, path } = resolved;
        const registered = await ctx.python.request('/v1/models/register', { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: model.id, name: model.name,
            provider: model.provider || 'sherpa-onnx', family: model.family, path, config: model.recognizer_config }) });
        if (!registered.ok) throw new Error(`模型登记失败：${await registered.text()}`);
      }
      const bytes = await readFile(audioPath);
      const created = await ctx.python.request('/v1/asr/jobs', { method: 'POST', body: bytes, signal,
        headers: { 'Content-Type': 'audio/wav', 'X-Flycut-Model': input.modelId, 'X-Flycut-Language': input.language,
          'X-Flycut-Execution': JSON.stringify(input.executionConfig ?? {}) } });
      const data = await created.json() as { id?: string; error?: string };
      if (!created.ok || !data.id) throw new Error(data.error || 'Cannot create Python ASR job');
      try {
        while (true) {
          signal.throwIfAborted();
          const response = await ctx.python.request(`/v1/asr/jobs/${data.id}`, { signal });
          const job = await response.json() as { status: string; progress: number; result?: SubtitleTranscript; error?: string };
          if (!response.ok) throw new Error(job.error || 'Python job lookup failed');
          if (job.status === 'complete' && job.result) return job.result;
          if (job.status === 'error' || job.status === 'cancelled') throw new Error(job.error || job.status);
          report({ status: 'running', progress: job.progress, data: `后端识别：${job.status}` });
          await setTimeout(500, undefined, { signal });
        }
      } finally {
        if (signal.aborted) await ctx.python.request(`/v1/asr/jobs/${data.id}/cancel`, { method: 'POST' }).catch(() => undefined);
      }
    },
  };
  ctx.effect(() => ctx.providers.register(provider));
  ctx.effect(() => ctx.providers.register({ ...provider, id: 'funasr-tauri', name: 'Native ASR (Host Python / sherpa-onnx)' }));
  for (const id of ['funasr-local', 'qwen-asr', 'audio-separator']) ctx.effect(() => ctx.providers.describe(PROVIDER_PACKAGES[id]));
} };

export const apiAsrPlugin = { name: 'flycut-asr-api', inject: ['providers'], apply(ctx: Context) {
  ctx.effect(() => ctx.providers.describe(PROVIDER_PACKAGES['openai-compatible']));
  ctx.effect(() => ctx.providers.register({ id: 'api', name: 'OpenAI-compatible ASR API', async transcribe(input, audioPath, signal, report) {
    if (!input.api) throw new Error('Missing ASR API configuration');
    const config = input.api; validateASRApiConfig(config);
    const samples = wavSamples(await readFile(audioPath));
    const parts: SubtitleTranscript[] = [];
    for (let offset = 0; offset < samples.length; offset += 16000 * 300) {
      signal.throwIfAborted();
      const audio = samples.subarray(offset, offset + 16000 * 300);
      const { encodePcmWav } = await import('../../shared/asr/apiProtocol');
      const form = new FormData(); form.append('file', encodePcmWav(audio), 'audio.wav');
      form.append('model', config.model); form.append('response_format', config.timestamps === 'none' ? 'json' : 'verbose_json');
      if (input.language !== 'auto') form.append('language', input.language);
      if (config.timestamps !== 'none') form.append('timestamp_granularities[]', 'segment');
      if (config.timestamps === 'word') form.append('timestamp_granularities[]', 'word');
      report({ status: 'running', progress: offset / samples.length * 100, data: '后端正在调用 ASR API...' });
      const response = await fetch(transcriptionEndpoint(config.baseUrl), { method: 'POST', body: form, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]),
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} });
      if (!response.ok) throw new Error(`ASR API HTTP ${response.status}; no automatic retry`);
      const text = await response.text(); if (text.length > 16_000_000) throw new Error('ASR API response exceeds 16 MB');
      parts.push(normalizeASRApiResponse(JSON.parse(text), audio.length / 16000, offset / 16000, `api-${parts.length}`));
    }
    if (!parts.length) throw new Error('Empty audio');
    return mergeASRApiTranscripts(parts, samples.length / 16000);
  } }));
} };

type WebModel = NonNullable<ReturnType<typeof getWebAsrModel>>;
/**
 * Loads a Transformers.js recognizer, preferring the OSS mirror. `modelBaseUrl` already ends with the repo id,
 * so the mirror host is the prefix before it. The mirror hosts fp32 encoders only (decoder q8); if it is
 * unavailable the load falls back to HuggingFace with uniform q8 weights.
 */
async function loadRecognizer(model: WebModel) {
  const { pipeline, env } = await import('@huggingface/transformers');
  const defaults = { remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate };
  const load = (dtype: 'q8' | Record<string, 'fp32' | 'q8'>) => pipeline('automatic-speech-recognition', model.modelId, { device: 'cpu', dtype });
  const mirror = model.modelBaseUrl?.endsWith(`/${model.modelId}`) ? model.modelBaseUrl.slice(0, -model.modelId.length) : undefined;
  if (mirror && model.family === 'whisper') {
    try {
      env.remoteHost = mirror; env.remotePathTemplate = '{model}/';
      return await load({ encoder_model: 'fp32', decoder_model_merged: 'q8' });
    } catch (error) {
      console.warn(`[transformers] mirror unavailable for ${model.modelId}, falling back to HuggingFace`, error);
    } finally { Object.assign(env, defaults); }
  }
  return load('q8');
}

export const transformersAsrPlugin = { name: 'flycut-asr-transformers', inject: ['providers', 'jobs', 'rpc', 'hostConfig'], apply(ctx: Context) {
  const downloadedFile = join(ctx.hostConfig.home, 'downloaded-models.json');
  async function downloaded(): Promise<string[]> {
    try { return JSON.parse(await readFile(downloadedFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  ctx.effect(() => ctx.providers.describe(PROVIDER_PACKAGES['transformers-web']));
  ctx.effect(() => ctx.rpc.register('asr.downloaded', undefined, downloaded));
  ctx.effect(() => ctx.rpc.register('asr.download', modelIdSchema, ({ modelId }) => ctx.jobs.create(async (signal, report) => {
    const provider = ctx.providers.get('transformers'); if (!provider.prepare) throw new Error('Model download is unavailable');
    await provider.prepare(modelId, signal, report);
    await writeFile(downloadedFile, JSON.stringify([...new Set([...await downloaded(), modelId])])); return { modelId };
  })));
  ctx.effect(() => ctx.providers.register({ id: 'transformers', name: 'Transformers (Host CPU)',
    async prepare(modelId, signal, report) {
      const model = getWebAsrModel(modelId); if (!model) throw new Error('Unknown Transformers model');
      signal.throwIfAborted();
      report({ status: 'loading', purpose: 'download', data: '后端正在下载 Transformers 模型...' });
      const recognizer = await loadRecognizer(model);
      await recognizer.dispose(); signal.throwIfAborted();
    }, async transcribe(input, audioPath, signal, report) {
    const model = getWebAsrModel(input.modelId); if (!model) throw new Error('Unknown Transformers model');
    const samples = wavSamples(await readFile(audioPath)); signal.throwIfAborted();
    report({ status: 'loading', data: '后端加载 Transformers 模型（CPU）...' });
    const recognizer = await loadRecognizer(model);
    try {
      signal.throwIfAborted();
      const raw = await recognizer(samples, { return_timestamps: true,
        ...(model.family === 'whisper' ? { chunk_length_s: 30, ...(input.language !== 'auto' ? { language: input.language } : {}) } : {}) });
      signal.throwIfAborted();
      const output = Array.isArray(raw) ? raw[0] : raw;
      return normalizeASRApiResponse({ text: output.text, segments: output.chunks?.map(chunk => ({ text: chunk.text,
        start: chunk.timestamp[0] ?? 0, end: chunk.timestamp[1] ?? samples.length / 16000 })) }, samples.length / 16000);
    } finally { await recognizer.dispose(); }
  } }));
} };
