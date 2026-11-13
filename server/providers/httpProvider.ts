import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { inferHotwordCapabilities, modelInfoSchema, type ModelInfo, type ProviderKind } from '../../shared/providers';
import { formatHotwordsForOption } from '../../shared/terminology';
import { MAX_TTS_AUDIO_BYTES } from '../../shared/tts/audio';
import type { Provider, ProgressReporter } from '../services';

/** Client for the FlyCut Provider protocol v1 (docs/provider-http-protocol.md). */
export const PROTOCOL = { name: 'flycut-provider', version: 1 } as const;
const MAX_RESPONSE = 16_000_000;
const POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface HttpConnection { baseUrl: string; headers?: Record<string, string> }
export interface HttpProviderOptions {
  id: string;
  name: string;
  kind: ProviderKind;
  timeoutMs?: number;
  /** Resolved on every request so a managed worker can start (or restart) lazily. */
  connect(): Promise<HttpConnection>;
}

const healthSchema = z.object({ protocol: z.string(), version: z.number(), name: z.string().optional(), capabilities: z.array(z.string()).default([]) });
const modelsSchema = z.object({ models: z.array(modelInfoSchema) });
const jobSchema = z.object({ id: z.string(), status: z.enum(['queued', 'running', 'complete', 'error', 'cancelled']),
  progress: z.number().optional(), message: z.string().optional(), result: z.unknown().optional(), error: z.string().optional() });
const ttsJobResultSchema = z.object({
  audioUrl: z.string().min(1),
  mimeType: z.string().optional(),
  format: z.enum(['wav', 'mp3', 'ogg', 'flac']).optional(),
  durationSeconds: z.number().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
});

export function createHttpProvider(options: HttpProviderOptions): Provider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const withTimeout = (signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  const formatHttpError = (status: number, message?: unknown) => {
    if (status === 401 || status === 403) {
      const detail = typeof message === 'string' && message.trim() ? `：${message.slice(0, 200)}` : '';
      return `${options.name} 鉴权失败（HTTP ${status}），请检查 API Key${detail}`;
    }
    return typeof message === 'string' ? `${options.name}：${message.slice(0, 500)}` : `${options.name} HTTP ${status}`;
  };
  const wrapFetchError = (error: unknown, signal?: AbortSignal): never => {
    if (signal?.aborted) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || /timed out/i.test(error.message))) {
      throw new Error(`${options.name} 请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  };

  async function call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const { baseUrl, headers = {} } = await options.connect();
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { ...init, redirect: 'error', signal: withTimeout(signal),
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...headers } });
    } catch (error) {
      throw wrapFetchError(error, signal);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE) throw new Error(`${options.name} 响应超过 16 MB`);
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`${options.name} 返回的不是 JSON（HTTP ${response.status}）`); }
    if (!response.ok) {
      throw new Error(formatHttpError(response.status, (data as { error?: unknown }).error));
    }
    return data;
  }
  async function downloadAudio(audioUrl: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string }> {
    const { baseUrl, headers = {} } = await options.connect();
    const base = new URL(baseUrl);
    const target = new URL(audioUrl, base);
    if (target.origin !== base.origin) {
      throw new Error(`${options.name} 返回的音频地址跨源，已拒绝下载`);
    }
    let response: Response;
    try {
      response = await fetch(target, { method: 'GET', redirect: 'error', signal: withTimeout(signal), headers });
    } catch (error) {
      throw wrapFetchError(error, signal);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsedError: unknown;
      try { parsedError = text ? (JSON.parse(text) as { error?: unknown }).error : undefined; } catch { parsedError = undefined; }
      throw new Error(formatHttpError(response.status, parsedError));
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_TTS_AUDIO_BYTES) {
      throw new Error(`${options.name} 音频产物超过 50 MB 上限`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TTS_AUDIO_BYTES) {
      throw new Error(`${options.name} 音频产物超过 50 MB 上限`);
    }
    return { bytes, mimeType: response.headers.get('content-type') ?? undefined };
  }

  let checked: Promise<string[]> | undefined;
  const check = () => checked ??= (async () => {
    const health = healthSchema.parse(await call('/v1/health', {}, AbortSignal.timeout(10_000)));
    if (health.protocol !== PROTOCOL.name || health.version !== PROTOCOL.version) {
      throw new Error(`${options.name} 的协议版本不兼容：${health.protocol} v${health.version}，需要 ${PROTOCOL.name} v${PROTOCOL.version}`);
    }
    return health.capabilities;
  })().catch(error => { checked = undefined; throw error; });

  async function wait(id: string, signal: AbortSignal, report: ProgressReporter, purpose: 'download' | 'transcribe' | 'synthesize') {
    try {
      while (true) {
        signal.throwIfAborted();
        const job = jobSchema.parse(await call(`/v1/jobs/${encodeURIComponent(id)}`, {}, signal));
        if (job.status === 'complete') return job.result;
        if (job.status === 'error' || job.status === 'cancelled') throw new Error(job.error || `${options.name} 任务${job.status === 'cancelled' ? '已取消' : '失败'}`);
        report({ status: purpose === 'download' ? 'progress' : 'running', purpose, progress: job.progress, data: job.message ?? `${options.name}：${job.status}` });
        await setTimeout(POLL_MS, undefined, { signal });
      }
    } finally {
      if (signal.aborted) await call(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, AbortSignal.timeout(5000)).catch(() => undefined);
    }
  }
  // Header values must be Latin-1: escape everything else (e.g. Chinese hotwords) as JSON \uXXXX.
  const headerJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const created = (data: unknown) => z.object({ id: z.string().min(1) }).parse(data).id;

  let cachedModels: ModelInfo[] = [];

  return {
    id: options.id, name: options.name, kind: options.kind,
    async models(signal) {
      await check();
      const parsed = modelsSchema.parse(await call('/v1/models', {}, signal)).models.map((m) =>
        m.role === 'asr' ? { ...m, hotwords: m.hotwords ?? inferHotwordCapabilities(m) } : m,
      );
      cachedModels = parsed;
      return parsed;
    },
    async prepare(modelId, signal, report) {
      await check();
      report({ status: 'loading', purpose: 'download', data: `${options.name} 正在准备模型...` });
      const id = created(await call(`/v1/models/${encodeURIComponent(modelId)}/prepare`, { method: 'POST' }, signal));
      await wait(id, signal, report, 'download');
    },
    async transcribe(request, audioPath, signal, report) {
      await check();
      report({ status: 'loading', data: `上传音频到 ${options.name}...` });
      const modelInfo = cachedModels.find((m) => m.id === request.modelId);
      const caps = modelInfo ? inferHotwordCapabilities(modelInfo) : undefined;
      const forwardedOptions = { ...(request.options ?? {}) };
      if (request.hotwords?.length && modelInfo?.options?.hotword && forwardedOptions.hotword === undefined) {
        forwardedOptions.hotword = formatHotwordsForOption(request.hotwords, caps);
      }
      const headers: Record<string, string> = {
        'Content-Type': 'audio/wav',
        'X-Flycut-Model': request.modelId,
        'X-Flycut-Language': request.language,
        'X-Flycut-Options': headerJson(forwardedOptions),
      };
      if (request.hotwords?.length && caps?.supported) {
        headers['X-Flycut-Hotwords'] = headerJson(request.hotwords);
      }
      const id = created(await call('/v1/asr/jobs', { method: 'POST', body: await readFile(audioPath), headers }, signal));
      return await wait(id, signal, report, 'transcribe') as never;
    },
    async synthesize(request, signal, report) {
      const capabilities = await check();
      if (capabilities.length > 0 && !capabilities.includes('tts')) {
        throw new Error(`${options.name} 未声明 tts 能力`);
      }
      report({ status: 'loading', purpose: 'synthesize', data: `正在向 ${options.name} 提交语音合成请求...` });
      const payload = {
        model: request.modelId,
        text: request.text,
        language: request.language,
        ...(request.voiceId ? { voiceId: request.voiceId } : {}),
        ...(request.speed !== undefined ? { speed: request.speed } : {}),
        ...(request.format ? { format: request.format } : {}),
        ...(request.options ? { options: request.options } : {}),
      };
      let id: string;
      if (request.referenceAudioPath) {
        const referenceBytes = await readFile(request.referenceAudioPath);
        id = created(await call('/v1/tts/jobs', {
          method: 'POST',
          body: referenceBytes,
          headers: {
            'Content-Type': 'audio/wav',
            'X-Flycut-TTS-Request': headerJson({ ...payload, authorization: request.cloneAuthorization }),
          },
        }, signal));
      } else {
        id = created(await call('/v1/tts/jobs', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }, signal));
      }
      const rawResult = await wait(id, signal, report, 'synthesize');
      const result = ttsJobResultSchema.parse(rawResult);
      report({ status: 'running', purpose: 'synthesize', progress: 95, data: `正在下载并校验 ${options.name} 音频产物...` });
      const downloaded = await downloadAudio(result.audioUrl, signal);
      return {
        bytes: downloaded.bytes,
        mimeType: downloaded.mimeType ?? result.mimeType,
        format: result.format,
        durationSeconds: result.durationSeconds,
        sampleRate: result.sampleRate,
      };
    },
  };
}
