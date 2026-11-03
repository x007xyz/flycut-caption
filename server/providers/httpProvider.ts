import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { modelInfoSchema, type ProviderKind } from '../../shared/providers';
import type { Provider, ProgressReporter } from '../services';

/** Client for the FlyCut Provider protocol v1 (docs/provider-http-protocol.md). */
export const PROTOCOL = { name: 'flycut-provider', version: 1 } as const;
const MAX_RESPONSE = 16_000_000;
const POLL_MS = 500;

export interface HttpConnection { baseUrl: string; headers?: Record<string, string> }
export interface HttpProviderOptions {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Resolved on every request so a managed worker can start (or restart) lazily. */
  connect(): Promise<HttpConnection>;
}

const healthSchema = z.object({ protocol: z.string(), version: z.number(), name: z.string().optional(), capabilities: z.array(z.string()).default([]) });
const modelsSchema = z.object({ models: z.array(modelInfoSchema) });
const jobSchema = z.object({ id: z.string(), status: z.enum(['queued', 'running', 'complete', 'error', 'cancelled']),
  progress: z.number().optional(), message: z.string().optional(), result: z.unknown().optional(), error: z.string().optional() });

export function createHttpProvider(options: HttpProviderOptions): Provider {
  async function call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const { baseUrl, headers = {} } = await options.connect();
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { ...init, redirect: 'error', signal,
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...headers } });
    const text = await response.text();
    if (text.length > MAX_RESPONSE) throw new Error(`${options.name} 响应超过 16 MB`);
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`${options.name} 返回的不是 JSON（HTTP ${response.status}）`); }
    if (!response.ok) {
      const message = (data as { error?: unknown }).error;
      throw new Error(typeof message === 'string' ? `${options.name}：${message.slice(0, 500)}` : `${options.name} HTTP ${response.status}`);
    }
    return data;
  }
  let checked: Promise<void> | undefined;
  const check = () => checked ??= (async () => {
    const health = healthSchema.parse(await call('/v1/health', {}, AbortSignal.timeout(10_000)));
    if (health.protocol !== PROTOCOL.name || health.version !== PROTOCOL.version) {
      throw new Error(`${options.name} 的协议版本不兼容：${health.protocol} v${health.version}，需要 ${PROTOCOL.name} v${PROTOCOL.version}`);
    }
  })().catch(error => { checked = undefined; throw error; });

  async function wait(id: string, signal: AbortSignal, report: ProgressReporter, purpose: 'download' | 'transcribe') {
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

  return {
    id: options.id, name: options.name, kind: options.kind,
    async models(signal) { await check(); return modelsSchema.parse(await call('/v1/models', {}, signal)).models; },
    async prepare(modelId, signal, report) {
      await check();
      report({ status: 'loading', purpose: 'download', data: `${options.name} 正在准备模型...` });
      const id = created(await call(`/v1/models/${encodeURIComponent(modelId)}/prepare`, { method: 'POST' }, signal));
      await wait(id, signal, report, 'download');
    },
    async transcribe(request, audioPath, signal, report) {
      await check();
      report({ status: 'loading', data: `上传音频到 ${options.name}...` });
      const id = created(await call('/v1/asr/jobs', { method: 'POST', body: await readFile(audioPath), headers: {
        'Content-Type': 'audio/wav', 'X-Flycut-Model': request.modelId, 'X-Flycut-Language': request.language,
        'X-Flycut-Options': headerJson(request.options ?? {}) } }, signal));
      return await wait(id, signal, report, 'transcribe') as never;
    },
  };
}
