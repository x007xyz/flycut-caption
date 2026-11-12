// Client Cordis service (`ctx.ai`). Text model calls are executed by the Host's Cordis text Provider.
import type { AIProgress, AISubtitleItem } from '@/types/ai'
import type { RemoteConnection } from '@/runtime/connection'
export class AIService {
  private connection: RemoteConnection
  constructor(connection: RemoteConnection) { this.connection = connection }
  private callback?: (progress: AIProgress) => void
  setProgressCallback(callback: (progress: AIProgress) => void) { this.callback = callback }
  private async run(mode: 'correction' | 'translation', items: AISubtitleItem[], configId: string, targetLang?: string, signal?: AbortSignal) {
    const connection = this.connection
    const job = await connection.call('text.start', { mode, items, configId, targetLang })
    return connection.waitJob<AISubtitleItem[]>(job.id, snapshot => {
      const progress = snapshot.progress
      if (progress && ['running', 'complete', 'error'].includes(progress.status)) this.callback?.(progress as AIProgress)
    }, signal)
  }
  /** Returns validated model output only; callers keep it pending until the user confirms. */
  correct(items: AISubtitleItem[], configId: string, signal?: AbortSignal) { return this.run('correction', items, configId, undefined, signal) }
  translate(items: AISubtitleItem[], configId: string, targetLang: string, signal?: AbortSignal) { return this.run('translation', items, configId, targetLang, signal) }
}
