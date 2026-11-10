// Client Cordis service (`ctx.asr`). Inference is owned by Host Providers; the client only sends `{ providerId, modelId }`.
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';
import type { AsrRequest, ModelRef } from '../../shared/providers';
import type { RemoteConnection } from '@/runtime/connection';
import { processAudioForASR } from '@/utils/audioUtils';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import { TaskOperationRunner } from './taskOperation';

export interface TranscribeOperation {
  key: string;
  signal?: AbortSignal;
  verifyingMessage?: string;
}

export class ASRService {
  private connection: RemoteConnection;
  private tasks: TaskOperationRunner;
  private completedTaskHosts = new Map<string, string>();
  constructor(connection: RemoteConnection, tasks = new TaskOperationRunner(connection)) {
    this.connection = connection; this.tasks = tasks;
  }
  private callbacks = new Set<(progress: ASRProgress) => void>();
  addProgressCallback(callback: (progress: ASRProgress) => void) { this.callbacks.add(callback); return () => { this.callbacks.delete(callback); }; }
  private emit(progress: ASRProgress) { this.callbacks.forEach(callback => callback(progress)); }

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

  /** Downloads a model through its Provider; progress is reported with `purpose: 'download'`. */
  async prepareModel(ref: ModelRef, onProgress?: (progress: ASRProgress) => void) {
    const job = await this.connection.call('providers.prepare', ref);
    await this.connection.waitJob(job.id, snapshot => {
      if (!snapshot.progress) return;
      const progress = { ...snapshot.progress, purpose: 'download' as const };
      this.emit(progress); onProgress?.(progress);
    });
    this.emit({ status: 'downloaded', purpose: 'download', progress: 100 });
  }

  destroy() { this.callbacks.clear(); }
}
