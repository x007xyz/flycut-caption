import type { RemoteConnection } from '@/runtime/connection';
import type { ASRProgress } from '@/types/subtitle';
import type { ProjectOpenResult } from '../../shared/projects';
import type { JobSnapshot } from '../../shared/protocol';
import type { DubCueInput, DubCueResult } from '../../shared/tts/dubbing';

export interface DubCueCallOptions {
  signal?: AbortSignal;
  onJobId?: (jobId: string) => void;
  onProgress?: (progress: ASRProgress) => void;
}

export type DubOperationLookup =
  | { state: 'complete'; result: DubCueResult }
  | { state: 'error'; error: string }
  | { state: 'cancelled' }
  | { state: 'running'; job: JobSnapshot }
  | { state: 'missing' };

export function dubbingStreamPath(projectId: string, videoId: string, dubId: string): string {
  return `/projects/${projectId}/videos/${videoId}/dubbing/${dubId}`;
}

export class DubbingService {
  private connection: RemoteConnection;

  constructor(connection: RemoteConnection) {
    this.connection = connection;
  }

  async synthesizeCue(input: DubCueInput, options: DubCueCallOptions = {}): Promise<DubCueResult> {
    const job = await this.connection.call('dubbing.synthesizeCue', input);
    options.onJobId?.(job.id);
    const onAbort = () => {
      void this.connection.call('jobs.cancel', { id: job.id }).catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.connection.waitJob<DubCueResult>(
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

  cancelJob(jobId: string): Promise<JobSnapshot> {
    return this.connection.call('jobs.cancel', { id: jobId });
  }

  async findOperationResult(operationId: string): Promise<DubOperationLookup> {
    const jobs = await this.connection.call('jobs.list');
    const matched = jobs.find(job => job.operationId === operationId);
    if (!matched) return { state: 'missing' };
    if (matched.status === 'complete') return { state: 'complete', result: matched.result as DubCueResult };
    if (matched.status === 'error') return { state: 'error', error: matched.error || '配音生成失败' };
    if (matched.status === 'cancelled') return { state: 'cancelled' };
    return { state: 'running', job: matched };
  }

  fetchProjectOpen(projectId: string, videoId: string): Promise<ProjectOpenResult> {
    return this.connection.call('projects.open', { projectId, videoId });
  }

  async downloadAudioObjectUrl(projectId: string, videoId: string, dubId: string, signal?: AbortSignal): Promise<string> {
    const path = dubbingStreamPath(projectId, videoId, dubId);
    let blob: Blob;
    if (this.connection.downloadPath) {
      blob = await this.connection.downloadPath(path, signal);
    } else {
      const response = await fetch(this.connection.resourceUrl(path), { credentials: 'include', signal });
      if (!response.ok) throw new Error(`加载配音音频失败（HTTP ${response.status}）`);
      blob = await response.blob();
    }
    return URL.createObjectURL(blob);
  }
}
