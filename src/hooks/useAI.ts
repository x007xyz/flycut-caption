// AI 字幕纠错 / 翻译流程编排 Hook
import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/stores/appStore'
import { useHistoryStore } from '@/stores/historyStore'
import { useShowSuccess, useShowError, useShowWarning } from '@/stores/messageStore'
import type { AIProgress, AISubtitleItem } from '@/types/ai'
import { useClientRuntime } from '@/runtime/context';
import { getLanguageName } from '@/constants/languages';

export interface UseAIReturn {
  isAILoading: boolean
  aiProgress: AIProgress | null
  hasModels: boolean
  selectedModelId: string | null
  /** AI correction returns model output for a review layer; it never writes formal subtitles. */
  requestCorrection: (items: AISubtitleItem[], configId: string, signal?: AbortSignal) => Promise<AISubtitleItem[]>
  runTranslation: (targetLang: string) => Promise<void>
}

export function useAI(): UseAIReturn {
  const { ai: aiService } = useClientRuntime();
  const aiModels = useAppStore((s) => s.aiModels)
  const selectedAIModelId = useAppStore((s) => s.selectedAIModelId)
  const aiProgress = useAppStore((s) => s.aiProgress)

  const setAIProgress = useAppStore((s) => s.setAIProgress)
  const clearAIProgress = useAppStore((s) => s.clearAIProgress)
  const setAITask = useAppStore((s) => s.setAITask)

  const chunks = useHistoryStore((s) => s.chunks)
  const applyLanguageTranslations = useHistoryStore((s) => s.applyLanguageTranslations)

  const showSuccess = useShowSuccess()
  const showError = useShowError()
  const showWarning = useShowWarning()

  const isAILoading = useMemo(
    () => aiProgress?.status === 'running',
    [aiProgress],
  )

  const getSelectedModel = useCallback(() => {
    if (!selectedAIModelId) return null
    return aiModels.find((m) => m.id === selectedAIModelId) ?? null
  }, [aiModels, selectedAIModelId])

  const requestCorrection = useCallback(
    (items: AISubtitleItem[], configId: string, signal?: AbortSignal) => aiService.correct(items, configId, signal),
    [aiService],
  )

  const run = useCallback(
    async (targetLang: string) => {
      const model = getSelectedModel()
      if (!model) {
        showWarning('未选择 AI 模型', '请先在 API 设置中添加并选择一个 AI 模型')
        return
      }

      const activeItems: AISubtitleItem[] = chunks
        .filter((c) => !c.deleted && c.text.trim() !== '')
        .map((c) => ({ id: c.id, text: c.text }))

      if (activeItems.length === 0) {
        showWarning('没有可处理的字幕', '当前没有未删除的字幕内容')
        return
      }

      setAITask('translation')
      setAIProgress({
        status: 'running',
        progress: 0,
        data: `开始翻译为 ${targetLang}...`,
      })

      // 绑定进度回调
      aiService.setProgressCallback((p) => {
        setAIProgress(p)
      })

      try {
        const results = await aiService.translate(activeItems, model.id, targetLang)
        applyLanguageTranslations({
          languageCode: targetLang,
          name: getLanguageName(targetLang),
          updates: results.map((r) => ({ id: r.id, text: r.text })),
        })

        setAIProgress({ status: 'complete', progress: 100, data: '完成' })
        showSuccess('字幕翻译完成', `共处理 ${results.length} 条`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'AI 处理失败'
        setAIProgress({ status: 'error', error: msg })
        showError('字幕翻译失败', msg)
      } finally {
        // 自动清空运行态（保留 toast 错误信息）
        window.setTimeout(() => {
          clearAIProgress()
        }, 1500)
      }
    },
    [
      getSelectedModel,
      chunks,
      applyLanguageTranslations,
      setAIProgress,
      setAITask,
      clearAIProgress,
      showSuccess,
      showError,
      showWarning, aiService
    ],
  )

  const runTranslation = useCallback((targetLang: string) => run(targetLang), [run])

  return {
    isAILoading,
    aiProgress,
    hasModels: aiModels.length > 0,
    selectedModelId: selectedAIModelId,
    requestCorrection,
    runTranslation,
  }
}
