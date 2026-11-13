import type { Context } from '@deepseek-ai/cordis';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { endpointInputSchema, type EndpointInfo } from '../../shared/protocol';
import type { ModelInfo } from '../../shared/providers';
import { encodePcmWav, mergeASRApiTranscripts, normalizeASRApiResponse, transcriptionEndpoint } from '../../shared/asr/apiProtocol';
import type { SubtitleTranscript } from '../../src/types/subtitle';
import type { Provider } from '../services';
import { createHttpProvider } from '../providers/httpProvider';
import { assertServiceUrl } from '../urlPolicy';
import { wavSamples } from './asr';

type Endpoint = z.infer<typeof endpointInputSchema>;
type Stored = Omit<Endpoint, 'apiKey'>;

export interface EndpointsConfig {
  /** Allows loopback and private-network service addresses. Off in the `server` profile (SSRF). */
  privateNetwork?: boolean;
}

/** OpenAI-compatible `/audio/transcriptions`: 300 s chunks, no automatic retry of billed requests. */
function openAiProvider(endpoint: Endpoint, apiKey: () => string | undefined): Provider {
  const url = transcriptionEndpoint(endpoint.baseUrl);
  const speechUrl = `${endpoint.baseUrl.trim().replace(/\/+$/, '')}/audio/speech`;
  const models = endpoint.models ?? [];
  const hasAsr = models.some(m => (m.role ?? 'asr') === 'asr');
  const hasTts = models.some(m => m.role === 'tts');
  const provider: Provider = {
    id: `openai:${endpoint.name}`, name: endpoint.label, kind: 'endpoint',
    async models() {
      return models.map((model): ModelInfo => model.role === 'tts'
        ? {
          id: model.id, name: model.id, role: 'tts',
          languages: model.languages?.length ? model.languages : ['auto'],
          status: 'ready',
          tts: {
            voices: (model.voices?.length ? model.voices : ['alloy']).map(voice => ({ id: voice, name: voice })),
            voiceCloning: false,
            durationControl: true,
            outputFormats: ['mp3', 'wav'],
          },
        }
        : {
          id: model.id, name: model.id, role: 'asr', languages: ['auto'],
          timestampLevel: model.timestamps, status: 'ready',
        });
    },
  };
  if (hasAsr) {
    provider.transcribe = async (request, audioPath, signal, report) => {
      const model = models.find(item => item.id === request.modelId && (item.role ?? 'asr') === 'asr');
      if (!model) throw new Error(`未配置识别模型 ${request.modelId}`);
      const samples = wavSamples(await readFile(audioPath));
      const parts: SubtitleTranscript[] = [];
      const key = apiKey();
      for (let offset = 0; offset < samples.length; offset += 16000 * 300) {
        signal.throwIfAborted();
        const audio = samples.subarray(offset, offset + 16000 * 300);
        const form = new FormData(); form.append('file', encodePcmWav(audio), 'audio.wav');
        form.append('model', model.id); form.append('response_format', model.timestamps === 'none' ? 'json' : 'verbose_json');
        if (request.language !== 'auto') form.append('language', request.language);
        if (model.timestamps !== 'none') form.append('timestamp_granularities[]', 'segment');
        if (model.timestamps === 'word') form.append('timestamp_granularities[]', 'word');
        report({ status: 'running', progress: offset / samples.length * 100, data: `正在调用 ${endpoint.label}...` });
        const response = await fetch(url, { method: 'POST', body: form, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutSeconds * 1000)]),
          headers: key ? { Authorization: `Bearer ${key}` } : {} });
        if (!response.ok) throw new Error(`ASR API HTTP ${response.status}; no automatic retry`);
        const text = await response.text(); if (text.length > 16_000_000) throw new Error('ASR API response exceeds 16 MB');
        parts.push(normalizeASRApiResponse(JSON.parse(text), audio.length / 16000, offset / 16000, `api-${parts.length}`));
      }
      if (!parts.length) throw new Error('Empty audio');
      return mergeASRApiTranscripts(parts, samples.length / 16000);
    };
  }
  if (hasTts) {
    provider.synthesize = async (request, signal, report) => {
      const model = models.find(item => item.id === request.modelId && item.role === 'tts');
      if (!model) throw new Error(`未配置 TTS 模型 ${request.modelId}`);
      if (request.referenceAudioPath) throw new Error(`${endpoint.label} 不支持声音克隆`);
      const key = apiKey();
      report({ status: 'running', purpose: 'synthesize', progress: 25, data: `正在调用 ${endpoint.label}...` });
      let response: Response;
      try {
        response = await fetch(speechUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutSeconds * 1000)]),
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model: model.id,
            input: request.text,
            voice: request.voiceId ?? model.voices?.[0] ?? 'alloy',
            ...(request.speed !== undefined ? { speed: request.speed } : {}),
            ...(request.format ? { response_format: request.format } : {}),
          }),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof Error && (error.name === 'TimeoutError' || /timed out/i.test(error.message))) {
          throw new Error(`${endpoint.label} 请求超时（超过 ${endpoint.timeoutSeconds} 秒）`);
        }
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${endpoint.label} 鉴权失败（HTTP ${response.status}），请检查 API Key`);
      }
      if (!response.ok) throw new Error(`TTS API HTTP ${response.status}; no automatic retry`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, mimeType: response.headers.get('content-type') ?? undefined };
    };
  }
  return provider;
}

/** User-added HTTP Providers (`flycut:<name>`, `openai:<name>`). Addresses persist; API keys stay in memory. */
export const endpointsPlugin = { name: 'flycut-endpoints', inject: ['providers', 'rpc', 'hostConfig'], apply(ctx: Context, config: EndpointsConfig = {}) {
  const privateNetwork = config.privateNetwork !== false;
  const file = join(ctx.hostConfig.appData ?? join(ctx.hostConfig.home, 'app-data'), 'endpoints.json');
  const endpoints = new Map<string, { endpoint: Stored; dispose: () => void }>();
  const keys = new Map<string, string>();

  function check(endpoint: Endpoint) {
    assertServiceUrl(endpoint.baseUrl, privateNetwork);
    if (endpoint.protocol === 'openai') {
      transcriptionEndpoint(endpoint.baseUrl);
      if (!endpoint.models?.length) throw new Error('OpenAI 兼容服务至少要填写一个模型名');
    }
  }
  function activate(endpoint: Stored) {
    const apiKey = () => keys.get(endpoint.name);
    const provider = endpoint.protocol === 'openai' ? openAiProvider(endpoint, apiKey) : createHttpProvider({
      id: `flycut:${endpoint.name}`, name: endpoint.label, kind: 'endpoint', timeoutMs: endpoint.timeoutSeconds * 1000,
      async connect() { const key = apiKey(); return { baseUrl: endpoint.baseUrl, headers: key ? { Authorization: `Bearer ${key}` } : undefined }; } });
    endpoints.get(endpoint.name)?.dispose();
    endpoints.set(endpoint.name, { endpoint, dispose: ctx.providers.register(provider) });
  }
  const info = (endpoint: Stored): EndpointInfo => ({ ...endpoint, providerId: `${endpoint.protocol}:${endpoint.name}`, hasApiKey: keys.has(endpoint.name) });
  let writes = Promise.resolve();
  const persist = () => {
    const run = writes.then(async () => {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify([...endpoints.values()].map(item => item.endpoint), null, 2)); await rename(`${file}.tmp`, file);
    });
    writes = run.catch(() => undefined); return run;
  };

  ctx.effect(() => {
    let disposed = false;
    readFile(file, 'utf8').then(text => {
      if (disposed) return;
      for (const raw of JSON.parse(text) as unknown[]) {
        try { const endpoint = endpointInputSchema.omit({ apiKey: true }).parse(raw); check(endpoint); activate(endpoint); }
        catch (error) { console.warn('[endpoints] skipped invalid entry', error); }
      }
    }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[endpoints] cannot read endpoints.json', error); });
    return () => { disposed = true; for (const item of endpoints.values()) item.dispose(); endpoints.clear(); };
  });
  ctx.effect(() => ctx.rpc.register('endpoints.list', undefined, () => [...endpoints.values()].map(item => info(item.endpoint))));
  ctx.effect(() => ctx.rpc.register('endpoints.save', endpointInputSchema, async input => {
    const { apiKey, ...endpoint } = input; check(input);
    const previous = endpoints.get(endpoint.name)?.endpoint;
    if (previous && previous.protocol !== endpoint.protocol) throw new Error('同名服务已存在，请换一个名称或先删除');
    if (apiKey !== undefined) { if (apiKey) keys.set(endpoint.name, apiKey); else keys.delete(endpoint.name); }
    activate(endpoint); await persist();
    return info(endpoint);
  }));
  ctx.effect(() => ctx.rpc.register('endpoints.remove', z.object({ name: z.string() }), async ({ name }) => {
    endpoints.get(name)?.dispose(); endpoints.delete(name); keys.delete(name); await persist();
    return { removed: name };
  }));
} };
