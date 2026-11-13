// 字幕相关类型定义

export interface SubtitleChunk {
  text: string;
  /** Text derived from still-active source words, rather than a user correction. */
  edlWordProjection?: boolean;
  /** 当前录音中的匿名说话人编号；不表示跨录音身份。 */
  speaker?: string;
  secondText?: string; // 副字幕文本
  timestamp: [number, number]; // [start, end] in seconds
  id: string;
  selected?: boolean; // 是否被选中删除
  deleted?: boolean; // 是否被删除
  isBlankSpacer?: boolean; // 是否为智能剪切插入的空白占位段
  /** 字词级 chunk 归属的句子 id */
  sentenceId?: string;
  /** 句子级 chunk 包含的字词 id 列表（用于级联删除与字词展示） */
  wordIds?: string[];
}

export interface SubtitleTranscript {
  /** F-0005: formal edits only; pending suggestions are never serialized. */
  editing?: import('../../shared/editing/edl').Editing;
  text: string;
  /** 句子级字幕（必选，用于列表/时间轴/导出） */
  chunks: SubtitleChunk[];
  /** 字词级字幕（模型支持时提供，用于精细裁剪） */
  wordChunks?: SubtitleChunk[];
  /** 是否具备可用于裁剪的字词时间戳 */
  hasWordTimestamps?: boolean;
  language: string;
  duration: number;
}

/** Worker / 引擎进度用途：用于区分「仅下载模型」与真正的识别流程 */
export type ASRProgressPurpose = 'download' | 'load' | 'transcribe' | 'export' | 'synthesize';

export interface ASRProgress {
  status: 'loading' | 'initiate' | 'progress' | 'done' | 'ready' | 'downloaded' | 'loaded' | 'running' | 'complete' | 'error' | 'reset';
  /** 缺省视为识别相关；download 不应驱动字幕编辑器的 ASR 加载态 */
  purpose?: ASRProgressPurpose;
  data?: string;
  file?: string;
  progress?: number;
  total?: number;
  result?: SubtitleTranscript;
  time?: number;
  error?: string;
}

export interface SubtitleEditorState {
  transcript: SubtitleTranscript | null;
  currentTime: number;
  selectedChunks: Set<string>;
  isProcessing: boolean;
  processingProgress: number;
}

export type SubtitleAction = 
  | { type: 'SET_TRANSCRIPT'; transcript: SubtitleTranscript }
  | { type: 'SET_CURRENT_TIME'; time: number }
  | { type: 'TOGGLE_CHUNK_SELECTION'; chunkId: string }
  | { type: 'SELECT_ALL_CHUNKS' }
  | { type: 'DESELECT_ALL_CHUNKS' }
  | { type: 'SET_PROCESSING'; isProcessing: boolean }
  | { type: 'SET_PROCESSING_PROGRESS'; progress: number }
  | { type: 'RESET' };
