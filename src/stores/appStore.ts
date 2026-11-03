// 主应用 Zustand Store
import { createStore } from 'zustand/vanilla';
import { bindRuntimeStore } from './runtimeStore';
import { devtools, persist } from 'zustand/middleware'
import type { 
  VideoFile, 
  VideoPlayerState, 
  VideoProcessingProgress,
  VideoProcessorConfig 
} from '@/types/video'
import type { ASRProgress } from '@/types/subtitle'
import type { ModelRef, OptionValue } from '../../shared/providers'
import type { AIModelConfig, AIProgress } from '@/types/ai'
import { hasWebGPU } from '@/utils/audioUtils'
import { getWebAsrModel } from '../../shared/asr/webModels'

/** Key of a model's saved options in `asrOptions`. */
export const modelKey = (ref: ModelRef) => `${ref.providerId}/${ref.modelId}`

/** Settings saved before Providers (version 0) named an engine type plus two model fields. */
export function migrateLegacyModel(state: { asrEngineType?: string; asrModelId?: string; webModelId?: string }): ModelRef | null {
  if (state.asrEngineType === 'transformers' && state.webModelId && getWebAsrModel(state.webModelId)) {
    return { providerId: 'transformers', modelId: state.webModelId }
  }
  if ((state.asrEngineType === 'funasr-tauri' || state.asrEngineType === 'python-runtime')
    && state.asrModelId && !state.asrModelId.startsWith('custom-') && !getWebAsrModel(state.asrModelId)) {
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
  videoProcessorConfig: VideoProcessorConfig
  
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
  aiModels: AIModelConfig[]
  selectedAIModelId: string | null
  aiProgress: AIProgress | null
  aiTask: 'correction' | 'translation' | null

  // 智能剪切空白段设置
  smartCutSilenceThreshold: number // 秒，超过此时长的空白段将被标记裁剪
}

// 应用动作接口
export interface AppActions {
  // 阶段管理
  setStage: (stage: AppState['stage']) => void
  
  // 视频管理
  setVideoFile: (videoFile: VideoFile | null) => void
  setVideoPlayerState: (playerState: Partial<VideoPlayerState>) => void
  setVideoProcessingProgress: (progress: VideoProcessingProgress) => void
  setVideoProcessorConfig: (config: Partial<VideoProcessorConfig>) => void
  
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
  addAIModel: (model: Omit<AIModelConfig, 'id'>) => string
  updateAIModel: (id: string, patch: Partial<Omit<AIModelConfig, 'id'>>) => void
  removeAIModel: (id: string) => void
  setSelectedAIModelId: (id: string | null) => void
  setAIProgress: (progress: AIProgress) => void
  clearAIProgress: () => void
  setAITask: (task: AppState['aiTask']) => void

  // 智能剪切空白段设置
  setSmartCutSilenceThreshold: (threshold: number) => void

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
  videoProcessorConfig: {
    engine: 'webav',
    outputFormat: 'mp4',
    quality: 'medium',
    preserveAudio: true,
  },
  
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
  aiProgress: null,
  aiTask: null,

  smartCutSilenceThreshold: 1.5,
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
      
      setVideoProcessorConfig: (config) =>
        set((state) => ({
          ...state,
          videoProcessorConfig: {
            ...state.videoProcessorConfig,
            ...config
          }
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

      // AI 模型管理
      addAIModel: (model) => {
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `ai_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        set((state) => ({
          ...state,
          aiModels: [...state.aiModels, { ...model, id }],
          selectedAIModelId: state.selectedAIModelId ?? id,
        }))
        return id
      },

      updateAIModel: (id, patch) =>
        set((state) => ({
          ...state,
          aiModels: state.aiModels.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        })),

      removeAIModel: (id) =>
        set((state) => {
          const aiModels = state.aiModels.filter((m) => m.id !== id)
          const selectedAIModelId =
            state.selectedAIModelId === id
              ? (aiModels[0]?.id ?? null)
              : state.selectedAIModelId
          return { ...state, aiModels, selectedAIModelId }
        }),

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

      setSmartCutSilenceThreshold: (threshold) =>
        set((state) => ({
          ...state,
          smartCutSilenceThreshold: threshold,
        })),

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
        aiModels: state.aiModels,
        selectedAIModelId: state.selectedAIModelId,
        smartCutSilenceThreshold: state.smartCutSilenceThreshold,
      }),
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
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
