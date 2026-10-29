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
import type { ASREngineType } from '@/services/asrService'
import type { AIModelConfig, AIProgress } from '@/types/ai'
import { hasWebGPU } from '@/utils/audioUtils'
import { DEFAULT_MODEL_ID } from '@/types/model'
import { DEFAULT_WEB_MODEL_ID, getWebAsrModel } from '../../shared/asr/webModels'
import { isWebAsrModelId } from '@/utils/asrModelId'

// 旧版 model_id（不在当前 manifest 中），升级后需迁移到 DEFAULT_MODEL_ID
const LEGACY_MODEL_IDS = ['sensevoice-small-int8', 'paraformer-small-int8']
// 旧版 Web 模型 id（不在当前 Web 清单中），升级后需迁移到 DEFAULT_WEB_MODEL_ID
const LEGACY_WEB_MODEL_IDS = ['']

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
  asrEngineType: ASREngineType
  asrModelId: string
  // Web (Transformers) 引擎使用的模型 id（Web 短 id，例如 'whisper-small'）
  webModelId: string

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
  setASREngineType: (asrEngineType: ASREngineType) => void
  setASRModelId: (asrModelId: string) => void
  setWebModelId: (webModelId: string) => void

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
  asrEngineType: 'transformers',
  asrModelId: DEFAULT_MODEL_ID,
  webModelId: DEFAULT_WEB_MODEL_ID,

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

      setASREngineType: (asrEngineType) =>
        set((state) => ({
          ...state,
          asrEngineType
        })),

      setASRModelId: (asrModelId) =>
        set((state) => ({
          ...state,
          asrModelId
        })),

      setWebModelId: (webModelId) =>
        set((state) => ({
          ...state,
          webModelId
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
        // 兼容迁移：旧版 model_id（不在当前 manifest 中）→ DEFAULT_MODEL_ID
        set((state) => {
          if (
            LEGACY_MODEL_IDS.includes(state.asrModelId)
            || isWebAsrModelId(state.asrModelId)
          ) {
            return { ...state, asrModelId: DEFAULT_MODEL_ID };
          }
          return state;
        });
        // 兼容迁移：旧版 / 未知 webModelId → DEFAULT_WEB_MODEL_ID
        set((state) => {
          const known = getWebAsrModel(state.webModelId);
          if (!known || LEGACY_WEB_MODEL_IDS.includes(state.webModelId)) {
            return { ...state, webModelId: DEFAULT_WEB_MODEL_ID };
          }
          return state;
        });

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
        asrEngineType: state.asrEngineType,
        asrModelId: state.asrModelId,
        webModelId: state.webModelId,
        shadow: state.shadow,
        display: state.display,
        aiModels: state.aiModels,
        selectedAIModelId: state.selectedAIModelId,
        smartCutSilenceThreshold: state.smartCutSilenceThreshold,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (isWebAsrModelId(state.asrModelId)) {
          state.asrModelId = DEFAULT_MODEL_ID;
        }
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
