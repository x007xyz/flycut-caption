// Client Cordis service (`ctx.asr`). Inference is owned by Host Providers; the client only sends `{ providerId, modelId }`.
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';
import type { AsrRequest, ModelRef, ProviderModels } from '../../shared/providers';
import type { RemoteConnection } from '@/runtime/connection';
import { processAudioForASR } from '@/utils/audioUtils';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import { modelStateSignature } from '@/utils/modelRecommendation';
import { TaskOperationRunner } from './taskOperation';

export interface TranscribeOperation {
  key: string;
  signal?: AbortSignal;
  verifyingMessage?: string;
}

export interface ModelDownloadEntry {
  key: string;
  ref: ModelRef;
  status: 'idle' | 'downloading' | 'verifying' | 'completed' | 'error' | 'cancelled';
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  phase?: 'downloading' | 'extracting' | 'verifying' | 'complete';
  message?: string;
  error?: string;
  staleConflict?: boolean;
}

export interface PrepareModelOptions {
  expectedSignature?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ASRProgress) => void;
}

export class StaleModelStateError extends Error {
  constructor(message = 'Model state changed on Host') {
    super(message);
    this.name = 'StaleModelStateError';
  }
}

const refKey = (ref: ModelRef) => `${ref.providerId}/${ref.modelId}`;

export class ASRService {
  private connection: RemoteConnection;
  private tasks: TaskOperationRunner;
  private completedTaskHosts = new Map<string, string>();
  private downloads = new Map<string, ModelDownloadEntry>();
  private snapshot: Record<string, ModelDownloadEntry> = {};
  private downloadListeners = new Set<() => void>();
  private activePrepares = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  constructor(connection: RemoteConnection, tasks = new TaskOperationRunner(connection)) {
    this.connection = connection;
    this.tasks = tasks;
  }

  private callbacks = new Set<(progress: ASRProgress) => void>();
  addProgressCallback(callback: (progress: ASRProgress) => void) {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }
  private emit(progress: ASRProgress) { this.callbacks.forEach(callback => callback(progress)); }

  subscribeDownloads = (listener: () => void) => {
    this.downloadListeners.add(listener);
    return () => { this.downloadListeners.delete(listener); };
  };

  getDownloadsSnapshot = (): Record<string, ModelDownloadEntry> => this.snapshot;

  private setDownloadEntry(key: string, entry: ModelDownloadEntry) {
    this.downloads.set(key, entry);
    this.snapshot = Object.fromEntries(this.downloads.entries());
    this.downloadListeners.forEach(listener => listener());
  }

  resetDownloadState(ref: ModelRef) {
    const key = refKey(ref);
    if (this.activePrepares.has(key)) return;
    this.downloads.delete(key);
    this.snapshot = Object.fromEntries(this.downloads.entries());
    this.downloadListeners.forEach(listener => listener());
  }

  cancelPrepare(ref: ModelRef) {
    const key = refKey(ref);
    const active = this.activePrepares.get(key);
    if (!active) return;
    const current = this.downloads.get(key);
    if (current) {
      this.setDownloadEntry(key, { ...current, message: '正在取消…' });
    }
    active.controller.abort(new DOMException('Cancelled', 'AbortError'));
  }

  /** Queries current Host catalog so we don't blindly repeat side effects or act on stale UI state. */
  private async inspectHostModel(ref: ModelRef) {
    const groups: ProviderModels[] = await this.connection.call('providers.models');
    const group = groups.find(item => item.provider.id === ref.providerId);
    const model = group?.models.find(item => item.id === ref.modelId);
    return { groups, group, model };
  }

  /** Converts media to 16 kHz mono WAV, uploads it and runs the Host workflow with the given model. */
  async transcribeAudio(buffer: ArrayBuffer, request: AsrRequest, operation: TranscribeOperation): Promise<SubtitleTranscript> {
    const connection = this.connection;
    this.emit({ status: 'loading', data: '准备并上传音频到 FlyCut Host...' });
    const samples = await processAudioForASR(buffer);
    const assetId = await connection.upload(encodePcmWav(samples));
    let preserveAsset = false;
    try {
      const completed = await this.tasks.run<{ transcript: SubtitleTranscript; cuts: Array<{ start: number; end: number }> }>({
        kind: 'asr', key: operation.key, signal: operation.signal,
        start: operationId => connection.call('workflow.start', { operationId, asr: { ...request, assetId } }),
        progress: snapshot => { if (snapshot.progress) this.emit(snapshot.progress); },
        verifying: operation.verifyingMessage
          ? () => this.emit({ status: 'running', purpose: 'transcribe', data: operation.verifyingMessage })
          : undefined,
      });
      this.completedTaskHosts.set(operation.key, completed.hostId);
      this.emit({ status: 'complete', result: completed.result.transcript });
      return completed.result.transcript;
    } catch (error) {
      // The Host may already be using this asset even when the client could not
      // observe the final snapshot. Locators make the task recoverable; deleting
      // its input here would make that recovery unusable. Unclaimed assets expire.
      preserveAsset = true;
      throw error;
    } finally {
      if (!preserveAsset) void connection.call('assets.delete', { assetId }).catch(() => undefined);
    }
  }

  /** Clears a completed operation after its result has been handed to the editor/project save path. */
  async completeOperation(key: string, persisted: Promise<boolean> | boolean) {
    if (!(await persisted)) return false;
    const hostId = this.completedTaskHosts.get(key);
    await this.tasks.complete('asr', key, hostId);
    this.completedTaskHosts.delete(key);
    return true;
  }

  /** Downloads and verifies a model through its Provider; deduplicates concurrent requests per runtime. */
  async prepareModel(
    ref: ModelRef,
    onProgressOrOptions?: ((progress: ASRProgress) => void) | PrepareModelOptions,
  ): Promise<void> {
    const opts: PrepareModelOptions = typeof onProgressOrOptions === 'function'
      ? { onProgress: onProgressOrOptions }
      : (onProgressOrOptions ?? {});
    const key = refKey(ref);
    const existing = this.activePrepares.get(key);
    if (existing) {
      if (opts.onProgress) {
        const off = this.addProgressCallback(progress => {
          if (progress.purpose === 'download') opts.onProgress?.(progress);
        });
        try { return await existing.promise; } finally { off(); }
      }
      return existing.promise;
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal?.aborted) controller.abort(opts.signal.reason);
    else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const run = (async () => {
      this.setDownloadEntry(key, {
        key, ref, status: 'downloading', phase: 'downloading', progress: 0, staleConflict: false,
      });
      try {
        if (opts.expectedSignature) {
          const { model } = await this.inspectHostModel(ref);
          if (model?.status === 'ready') {
            this.setDownloadEntry(key, {
              key, ref, status: 'completed', phase: 'complete', progress: 100,
            });
            this.emit({ status: 'downloaded', purpose: 'download', phase: 'complete', progress: 100 });
            if (typeof window !== 'undefined') window.dispatchEvent(new Event('flycut-provider-models-changed'));
            return;
          }
          const actualSignature = modelStateSignature(model);
          if (actualSignature !== opts.expectedSignature) {
            throw new StaleModelStateError();
          }
        }

        const job = await this.connection.call('providers.prepare', ref);
        await this.connection.waitJob(job.id, snapshot => {
          if (!snapshot.progress) return;
          const progress: ASRProgress = { ...snapshot.progress, purpose: 'download' };
          this.emit(progress);
          opts.onProgress?.(progress);
          const phase = progress.phase ?? 'downloading';
          this.setDownloadEntry(key, {
            key,
            ref,
            status: phase === 'verifying' ? 'verifying' : 'downloading',
            phase,
            progress: progress.progress,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            message: progress.data,
          });
        }, controller.signal);

        // Verify with Host that model actually transitioned to ready (AC-7)
        const { model } = await this.inspectHostModel(ref);
        if (model?.status !== 'ready') {
          throw new Error(model?.reason || '模型校验未通过，Host 未确认模型已就绪');
        }
        this.setDownloadEntry(key, {
          key, ref, status: 'completed', phase: 'complete', progress: 100,
        });
        this.emit({ status: 'downloaded', purpose: 'download', phase: 'complete', progress: 100 });
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('flycut-provider-models-changed'));
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          this.setDownloadEntry(key, { key, ref, status: 'cancelled', staleConflict: false });
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('flycut-provider-models-changed'));
          return;
        }
        const staleConflict = error instanceof StaleModelStateError;
        const message = error instanceof Error ? error.message : String(error);
        this.setDownloadEntry(key, {
          key, ref, status: 'error', error: message, staleConflict,
        });
        if (staleConflict && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('flycut-provider-models-changed'));
        }
        throw error;
      } finally {
        opts.signal?.removeEventListener('abort', onCallerAbort);
        this.activePrepares.delete(key);
      }
    })();

    this.activePrepares.set(key, { promise: run, controller });
    return run;
  }

  destroy() {
    for (const active of this.activePrepares.values()) {
      active.controller.abort(new DOMException('Runtime disposed', 'AbortError'));
    }
    this.activePrepares.clear();
    this.downloadListeners.clear();
    this.callbacks.clear();
  }
}
