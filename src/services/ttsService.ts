import type { RemoteConnection } from '@/runtime/connection';
import type { ASRProgress } from '@/types/subtitle';
import type { TtsRequest } from '../../shared/providers';
import type {
  TtsSettingsSaveInput,
  TtsSettingsSaveResult,
  TtsSettingsSnapshot,
  TtsSynthesizeResult,
} from '../../shared/tts/settings';

export interface TtsSynthesizeCallOptions {
  operationId?: string;
  signal?: AbortSignal;
  onJobId?: (jobId: string) => void;
  onProgress?: (progress: ASRProgress) => void;
}

export class TTSService {
  private connection: RemoteConnection;

  constructor(connection: RemoteConnection) {
    this.connection = connection;
  }

  getSettings(): Promise<TtsSettingsSnapshot> {
    return this.connection.call('tts.getSettings');
  }

  saveSettings(input: TtsSettingsSaveInput): Promise<TtsSettingsSaveResult> {
    return this.connection.call('tts.saveSettings', input);
  }

  async synthesize(request: TtsRequest, options: TtsSynthesizeCallOptions = {}): Promise<TtsSynthesizeResult> {
    const job = await this.connection.call('tts.synthesize', {
      ...(options.operationId ? { operationId: options.operationId } : {}),
      request,
    });
    options.onJobId?.(job.id);
    const onAbort = () => {
      void this.connection.call('jobs.cancel', { id: job.id }).catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.connection.waitJob<TtsSynthesizeResult>(
        job.id,
        snapshot => {
          if (snapshot.progress) options.onProgress?.(snapshot.progress);
        },
        options.signal,
      );
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  cancelJob(jobId: string) {
    return this.connection.call('jobs.cancel', { id: jobId });
  }

  uploadReferenceAudio(file: File): Promise<string> {
    return this.connection.upload(file);
  }

  async downloadAudioObjectUrl(assetId: string): Promise<string> {
    const blob = await this.connection.download(assetId);
    return URL.createObjectURL(blob);
  }
}
