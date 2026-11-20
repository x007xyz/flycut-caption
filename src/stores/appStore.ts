// 主应用 Zustand Store
import { createStore } from 'zustand/vanilla';
import { bindRuntimeStore } from './runtimeStore';
import { devtools, persist } from 'zustand/middleware'
import type { 
  VideoFile, 
  VideoPlayerState, 
  VideoProcessingProgress
} from '@/types/video'
import type { ASRProgress } from '@/types/subtitle'
import type { ModelRef, OptionValue } from '../../shared/providers'
import type { AIModelView, AIProgress } from '@/types/ai'
import type { AISettingsSnapshot } from '../../shared/aiSettings'
import { stashLegacyAISettings } from '@/services/aiMigration'
import { hasWebGPU } from '@/utils/audioUtils'
import { defaultSubtitleStylePair, type SubtitleStylePair } from '@/subtitle'
import { DEFAULT_TRANSLATION_LIMITS, type TranslationLimits } from '../../shared/text/translation'

/** Key of a model's saved options in `asrOptions`. */
export const modelKey = (ref: ModelRef) => `${ref.providerId}/${ref.modelId}`

/** Settings saved before Providers (version 0) named an engine type plus two model fields. */
export function migrateLegacyModel(state: { asrEngineType?: string; asrModelId?: string; webModelId?: string }): ModelRef | null {
  // Transformers.js was removed: those users pick a model again.
  if ((state.asrEngineType === 'funasr-tauri' || state.asrEngineType === 'python-runtime')
    && state.asrModelId && !state.asrModelId.startsWith('custom-')) {
    return { providerId: 'sherpa-onnx', modelId: state.asrModelId }
  }
  return null
}

// 应用状态接口
export interface AppState {
  // 应用程序阶段
  stage: 'upload' | 'transcribe' | 'edit'
  
  // 视频相关状态
  videoFile: VideoFile | null
  videoPlayerState: VideoPlayerState
  videoProcessingProgress: VideoProcessingProgress | null
  
  // ASR相关状态（仅进度，实际数据在historyStore）
  asrProgress: ASRProgress | null
  currentTime: number
  
  // UI状态
  isLoading: boolean
  error: string | null
  
  // 设置
  language: string
  deviceType: 'webgpu' | 'wasm'
  /** 当前识别模型；null 表示还没选，界面会提示到「设置 → 模型」下载或添加 */
  asrModel: ModelRef | null
  /** 每个模型各自保存的选项，键为 `providerId/modelId` */
  asrOptions: Record<string, Record<string, OptionValue>>

  // Aimu 风格设置
  shadow: 'N' | 'S' | 'M' | 'L'
  display: 'Bilingual' | 'Main' | 'Second'

  // AI 模型设置（字幕纠错 / 翻译）
  aiModels: AIModelView[]
  selectedAIModelId: string | null
  aiSettingsHostId: string | null
  aiSettingsRevision: number
  aiProgress: AIProgress | null
  aiTask: 'correction' | 'translation' | null
  translationLimits: TranslationLimits

  // 智能剪切空白段设置
  smartCutSilenceThreshold: number // 秒，超过此时长的空白段将被标记裁剪
  /** F-0021: show only this speaker in the subtitle list; null shows all. */
  speakerFilter: string | null
  /** F-0006：EDL 内部接点的音频淡入淡出，毫秒；0 关闭 */
  joinFadeMs: number

  /** 主 / 副字幕样式（含画幅 aspectPreset）。随项目保存（F-0002），不写 localStorage */
  subtitleStylePair: SubtitleStylePair
  /** 样式来自已保存的项目：载入视频时不再按画面尺寸自动推断画幅，以免覆盖用户的选择 */
  subtitleStyleRestored: boolean
}

// 应用动作接口
export interface AppActions {
  // 阶段管理
  setStage: (stage: AppState['stage']) => void

  /** 修改样式对；`restored` 只在载入项目时传 true */
  setSubtitleStylePair: (next: SubtitleStylePair | ((previous: SubtitleStylePair) => SubtitleStylePair), restored?: boolean) => void
  
  // 视频管理
  setVideoFile: (videoFile: VideoFile | null) => void
  setVideoPlayerState: (playerState: Partial<VideoPlayerState>) => void
  setVideoProcessingProgress: (progress: VideoProcessingProgress) => void
  
  // ASR管理（仅进度）
  setASRProgress: (progress: ASRProgress) => void
  clearASRProgress: () => void
  setCurrentTime: (time: number) => void
  
  // UI状态管理
  setLoading: (isLoading: boolean) => void
  setError: (error: string | null) => void
  
  // 设置管理
  setLanguage: (language: string) => void
  setDeviceType: (deviceType: 'webgpu' | 'wasm') => void
  setASRModel: (asrModel: ModelRef | null) => void
  setASROptions: (ref: ModelRef, options: Record<string, OptionValue>) => void

  // Aimu 风格设置管理
  setShadow: (shadow: AppState['shadow']) => void
  setDisplay: (display: AppState['display']) => void

  // AI 模型管理
  applyAISettings: (snapshot: AISettingsSnapshot) => void
  clearAISettings: () => void
  setSelectedAIModelId: (id: string | null) => void
  setAIProgress: (progress: AIProgress) => void
  clearAIProgress: () => void
  setAITask: (task: AppState['aiTask']) => void
  setTranslationLimits: (limits: Partial<TranslationLimits>) => void

  // 智能剪切空白段设置
  setSmartCutSilenceThreshold: (threshold: number) => void
  setSpeakerFilter: (speaker: string | null) => void
  setJoinFadeMs: (joinFadeMs: number) => void

  // 重置
  reset: () => void
  
  // 初始化
  initialize: () => Promise<void>
}

// 初始状态
const initialState: AppState = {
  stage: 'upload',
  
  videoFile: null,
  videoPlayerState: {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
  },
  videoProcessingProgress: null,
  
  asrProgress: null,
  currentTime: 0,
  
  isLoading: false,
  error: null,
  
  language: 'en',
  deviceType: 'wasm',
  asrModel: null,
  asrOptions: {},

  shadow: 'N',
  display: 'Bilingual',

  aiModels: [],
  selectedAIModelId: null,
  aiSettingsHostId: null,
  aiSettingsRevision: 0,
  aiProgress: null,
  aiTask: null,
  translationLimits: DEFAULT_TRANSLATION_LIMITS,

  smartCutSilenceThreshold: 1.5,
  speakerFilter: null,
  joinFadeMs: 5,

  subtitleStylePair: defaultSubtitleStylePair,
  subtitleStyleRestored: false,
}

// 创建Store
/** One instance per client runtime; see `ctx.stores`. */
export const createAppStore = () => createStore<AppState & AppActions>()(
  devtools(
    persist(
    (set) => ({
      ...initialState,
      
      // 阶段管理
      setStage: (stage) =>
        set((state) => ({
          ...state,
          stage
        })),

      setSubtitleStylePair: (next, restored) =>
        set((state) => {
          const subtitleStylePair = typeof next === 'function' ? next(state.subtitleStylePair) : next
          if (subtitleStylePair === state.subtitleStylePair && restored === undefined) return state
          return { ...state, subtitleStylePair, subtitleStyleRestored: restored ?? state.subtitleStyleRestored }
        }),
      
      // 视频管理
      setVideoFile: (videoFile) =>
        set((state) => ({
          ...state,
          videoFile,
          stage: videoFile ? 'transcribe' : 'upload'
        })),
      
      setVideoPlayerState: (playerState) =>
        set((state) => ({
          ...state,
          videoPlayerState: {
            ...state.videoPlayerState,
            ...playerState
          }
        })),
      
      setVideoProcessingProgress: (progress) =>
        set((state) => ({
          ...state,
          videoProcessingProgress: progress
        })),
      
      // ASR管理（仅进度）
      setASRProgress: (progress) =>
        set((state) => ({
          ...state,
          asrProgress: progress
        })),

      clearASRProgress: () =>
        set((state) => ({
          ...state,
          asrProgress: null,
          error: null,
        })),
      
      setCurrentTime: (time) =>
        set((state) => ({
          ...state,
          currentTime: time
        })),
      
      // UI状态管理
      setLoading: (isLoading) =>
        set((state) => ({
          ...state,
          isLoading
        })),
      
      setError: (error) => {
        console.error('应用错误状态更新:', error)
        set((state) => ({
          ...state,
          error,
          isLoading: false
        }))
        
        // 自动清除错误 - 5秒后
        if (error) {
          setTimeout(() => {
            set((state) => ({
              ...state,
              error: null
            }))
          }, 5000)
        }
      },
      
      // 设置管理
      setLanguage: (language) =>
        set((state) => ({
          ...state,
          language
        })),
      
      setDeviceType: (deviceType) =>
        set((state) => ({
          ...state,
          deviceType
        })),

      setASRModel: (asrModel) =>
        set((state) => ({
          ...state,
          asrModel
        })),

      setASROptions: (ref, options) =>
        set((state) => ({
          ...state,
          asrOptions: { ...state.asrOptions, [modelKey(ref)]: options }
        })),

      setShadow: (shadow) =>
        set((state) => ({
          ...state,
          shadow
        })),
      
      setDisplay: (display) =>
        set((state) => ({
          ...state,
          display
        })),

      // Host AI settings are a non-persistent projection; Host storage is the source of truth.
      applyAISettings: (snapshot) =>
        set((state) => ({
          ...state,
          aiModels: snapshot.configs,
          selectedAIModelId: snapshot.selectedId,
          aiSettingsHostId: snapshot.hostId,
          aiSettingsRevision: snapshot.revision,
        })),

      clearAISettings: () =>
        set((state) => ({
          ...state,
          aiModels: [],
          selectedAIModelId: null,
          aiSettingsHostId: null,
          aiSettingsRevision: 0,
        })),

      setSelectedAIModelId: (id) =>
        set((state) => ({
          ...state,
          selectedAIModelId: id,
        })),

      setAIProgress: (progress) =>
        set((state) => ({
          ...state,
          aiProgress: progress,
        })),

      clearAIProgress: () =>
        set((state) => ({
          ...state,
          aiProgress: null,
          aiTask: null,
        })),

      setAITask: (aiTask) =>
        set((state) => ({
          ...state,
          aiTask,
        })),

      setTranslationLimits: (limits) =>
        set((state) => {
          const current = state.translationLimits ?? DEFAULT_TRANSLATION_LIMITS
          const maxCharsPerLine = limits.maxCharsPerLine === undefined
            ? current.maxCharsPerLine
            : Math.min(200, Math.max(5, Math.round(limits.maxCharsPerLine)))
          const maxCps = limits.maxCps === undefined
            ? current.maxCps
            : Math.min(100, Math.max(1, Math.round(limits.maxCps)))
          return {
            ...state,
            translationLimits: { maxCharsPerLine, maxCps },
          }
        }),

      setSpeakerFilter: (speakerFilter) => set({ speakerFilter }),
      setSmartCutSilenceThreshold: (threshold) =>
        set((state) => ({
          ...state,
          smartCutSilenceThreshold: threshold,
        })),

      setJoinFadeMs: (joinFadeMs: number) =>
        set((state) => ({ ...state, joinFadeMs })),

      // 重置
      reset: () =>
        set((state) => ({
          ...initialState,
          language: state.language, // 保持语言设置
          deviceType: state.deviceType, // 保持设备类型设置
        })),
      
      // 初始化：仅在无已保存配置时自动检测设备
      initialize: async () => {
        const hasPersistedSettings = localStorage.getItem('app-settings')
        if (hasPersistedSettings) return
        
        try {
          const supportsWebGPU = await hasWebGPU()
          set((state) => ({
            ...state,
            deviceType: supportsWebGPU ? 'webgpu' : 'wasm'
          }))
        } catch (error) {
          console.warn('设备检测失败:', error)
          set((state) => ({
            ...state,
            deviceType: 'wasm'
          }))
        }
      },
    }),
    {
      name: 'app-settings',
      partialize: (state) => ({
        language: state.language,
        deviceType: state.deviceType,
        asrModel: state.asrModel,
        asrOptions: state.asrOptions,
        shadow: state.shadow,
        display: state.display,
        smartCutSilenceThreshold: state.smartCutSilenceThreshold,
        joinFadeMs: state.joinFadeMs,
        translationLimits: state.translationLimits,
      }),
      version: 2,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
        if (version < 2) {
          stashLegacyAISettings(state.aiModels, state.selectedAIModelId)
          const next = { ...state }
          delete next.aiModels; delete next.selectedAIModelId
          if (version < 1) {
            const { asrEngineType, asrModelId, webModelId, ...rest } = next as Record<string, string | undefined>
            return { ...rest, aiModels: [], selectedAIModelId: null,
              asrModel: migrateLegacyModel({ asrEngineType, asrModelId, webModelId }), asrOptions: {} }
          }
          return { ...next, aiModels: [], selectedAIModelId: null }
        }
        if (version < 1) {
          const { asrEngineType, asrModelId, webModelId, ...rest } = state as Record<string, string | undefined>
          return { ...rest, asrModel: migrateLegacyModel({ asrEngineType, asrModelId, webModelId }), asrOptions: {} }
        }
        return state
      },
    }
    ),
    {
      name: 'app-store', // 用于Redux DevTools
    }
  )
)

// 注意: 直接使用 useAppStore(state => state.property) 或 useAppStore(state => state.actionName)
// 这样可以获得更好的性能和类型安全

export const useAppStore = bindRuntimeStore('app');
