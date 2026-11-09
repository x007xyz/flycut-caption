// 视频相关类型定义

export interface VideoFile {
  file: File;
  url: string;
  duration: number;
  size: number;
  type: string;
  name: string;
  /** 本地文件路径（Tauri 环境下由原生文件选择器提供） */
  path?: string;
  /** 存在 Host 项目里的媒体（Host HTTP 路径，不含 token）；`file` 是空占位（F-0002） */
  remotePath?: string;
}

export interface VideoPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
}

export interface VideoSegment {
  start: number;
  end: number;
  keep: boolean; // true = 保留, false = 删除
  text?: string; // 字幕文本内容
  secondText?: string; // 副字幕文本
  id?: string; // 字幕片段ID
}

export interface VideoProcessingProgress {
  stage: 'analyzing' | 'cutting' | 'encoding' | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  error?: string;
}

export interface ExportOptions {
  format: 'mp4' | 'webm' | 'avi';
  quality: 'high' | 'medium' | 'low';
  includeSubtitles: boolean;
  subtitleFormat?: 'srt' | 'vtt' | 'json';
}

export type VideoAction =
  | { type: 'SET_VIDEO_FILE'; videoFile: VideoFile }
  | { type: 'SET_PLAYER_STATE'; playerState: Partial<VideoPlayerState> }
  | { type: 'SET_PROCESSING_PROGRESS'; progress: VideoProcessingProgress }
  | { type: 'RESET_VIDEO' };
