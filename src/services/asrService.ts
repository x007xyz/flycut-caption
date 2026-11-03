// Client Cordis service (`ctx.asr`). Inference is owned by Host Providers; the client only sends `{ providerId, modelId }`.
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';
import type { AsrRequest, ModelRef } from '../../shared/providers';
import type { RemoteConnection } from '@/runtime/connection';
import { processAudioForASR } from '@/utils/audioUtils';
import { encodePcmWav } from '../../shared/asr/apiProtocol';

export class ASRService {
  private connection: RemoteConnection;
  constructor(connection: RemoteConnection) { this.connection = connection; }
  private callbacks = new Set<(progress: ASRProgress) => void>();
  addProgressCallback(callback: (progress: ASRProgress) => void) { this.callbacks.add(callback); return () => { this.callbacks.delete(callback); }; }
  private emit(progress: ASRProgress) { this.callbacks.forEach(callback => callback(progress)); }

  /** Converts media to 16 kHz mono WAV, uploads it and runs the Host workflow with the given model. */
  async transcribeAudio(buffer: ArrayBuffer, request: AsrRequest): Promise<SubtitleTranscript> {
    const connection = this.connection;
    this.emit({ status: 'loading', data: '准备并上传音频到 FlyCut Host...' });
    const samples = await processAudioForASR(buffer);
    const assetId = await connection.upload(encodePcmWav(samples));
    const job = await connection.call('workflow.start', { asr: { ...request, assetId } });
    const result = await connection.waitJob<{ transcript: SubtitleTranscript; cuts: Array<{ start: number; end: number }> }>(job.id,
      snapshot => { if (snapshot.progress) this.emit(snapshot.progress); })
      .finally(() => { void connection.call('assets.delete', { assetId }).catch(() => undefined); });
    this.emit({ status: 'complete', result: result.transcript });
    return result.transcript;
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
