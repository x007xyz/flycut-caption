// Client Cordis service (`ctx.ai`). Text model calls are executed by the Host's Cordis text Provider.
import type { AIProgress, AISubtitleItem } from '@/types/ai'
import type { RemoteConnection } from '@/runtime/connection'
import type { KeywordSuggestRequest, KeywordSuggestResult } from '../../shared/text/keywords'
import type { TranslationContextItem } from '../../shared/text/translation'

export interface AITranslateOptions {
  sourceLang?: string
  semanticGroups?: Array<{ sentence: string; itemIds: string[] }>
  contextBefore?: TranslationContextItem[]
  contextAfter?: TranslationContextItem[]
  signal?: AbortSignal
}
export class AIService {
  private connection: RemoteConnection
  constructor(connection: RemoteConnection) { this.connection = connection }
  private callback?: (progress: AIProgress) => void
  setProgressCallback(callback: (progress: AIProgress) => void) { this.callback = callback }
  private async run(
    mode: 'correction' | 'translation',
    items: AISubtitleItem[],
    configId: string,
    targetLang?: string,
    options?: AITranslateOptions,
  ) {
    const connection = this.connection
    const job = await connection.call('text.start', {
      mode,
      items,
      configId,
      targetLang,
      ...(options?.sourceLang ? { sourceLang: options.sourceLang } : {}),
      ...(options?.semanticGroups?.length ? { semanticGroups: options.semanticGroups } : {}),
      ...(options?.contextBefore?.length ? { contextBefore: options.contextBefore } : {}),
      ...(options?.contextAfter?.length ? { contextAfter: options.contextAfter } : {}),
    })
    return connection.waitJob<AISubtitleItem[]>(job.id, snapshot => {
      const progress = snapshot.progress
      if (progress && ['running', 'complete', 'error'].includes(progress.status)) this.callback?.(progress as AIProgress)
    }, options?.signal)
  }
  /** Returns validated model output only; callers keep it pending until the user confirms. */
  correct(items: AISubtitleItem[], configId: string, signal?: AbortSignal) {
    return this.run('correction', items, configId, undefined, { signal })
  }
  translate(
    items: AISubtitleItem[],
    configId: string,
    targetLang: string,
    optionsOrSignal?: AITranslateOptions | AbortSignal,
  ) {
    const options: AITranslateOptions = optionsOrSignal && 'aborted' in optionsOrSignal
      ? { signal: optionsOrSignal as AbortSignal }
      : ((optionsOrSignal as AITranslateOptions | undefined) ?? {})
    return this.run('translation', items, configId, targetLang, options)
  }
  /** F-0025: returns pending keyword candidates; callers keep them in a review layer until confirmed. */
  async suggestKeywords(configId: string, request: KeywordSuggestRequest, signal?: AbortSignal): Promise<KeywordSuggestResult> {
    const job = await this.connection.call('text.suggestKeywords', { configId, request })
    return this.connection.waitJob<KeywordSuggestResult>(job.id, snapshot => {
      const progress = snapshot.progress
      if (progress && ['running', 'complete', 'error'].includes(progress.status)) this.callback?.(progress as AIProgress)
    }, signal)
  }
}
