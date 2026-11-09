// 应用程序状态类型定义

import type { VideoFile, VideoPlayerState, VideoProcessingProgress } from './video';
import type { SubtitleTranscript, ASRProgress } from './subtitle';

export interface AppState {
  // 应用程序阶段
  stage: 'upload' | 'transcribe' | 'edit';
  
  // 视频相关状态
  videoFile: VideoFile | null;
  videoPlayerState: VideoPlayerState;
  videoProcessingProgress: VideoProcessingProgress | null;
  
  // 字幕相关状态  
  transcript: SubtitleTranscript | null;
  asrProgress: ASRProgress | null;
  currentTime: number;
  selectedChunks: Set<string>;
  
  // UI状态
  isLoading: boolean;
  error: string | null;
  
  // 设置
  language: string;
  deviceType: 'webgpu' | 'wasm';
}

export type AppAction =
  | { type: 'SET_STAGE'; stage: AppState['stage'] }
  | { type: 'SET_VIDEO_FILE'; videoFile: VideoFile }
  | { type: 'SET_VIDEO_PLAYER_STATE'; playerState: Partial<VideoPlayerState> }
  | { type: 'SET_VIDEO_PROCESSING_PROGRESS'; progress: VideoProcessingProgress }
  | { type: 'SET_TRANSCRIPT'; transcript: SubtitleTranscript }
  | { type: 'SET_ASR_PROGRESS'; progress: ASRProgress }
  | { type: 'SET_CURRENT_TIME'; time: number }
  | { type: 'TOGGLE_CHUNK_SELECTION'; chunkId: string }
  | { type: 'SELECT_ALL_CHUNKS' }
  | { type: 'DESELECT_ALL_CHUNKS' }
  | { type: 'SET_SELECTED_CHUNKS'; selectedChunks: Set<string> }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_LANGUAGE'; language: string }
  | { type: 'SET_DEVICE_TYPE'; deviceType: 'webgpu' | 'wasm' }
  | { type: 'RESET' };
