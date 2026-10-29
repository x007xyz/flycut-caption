// FunASR / sherpa-onnx 模型管理类型
// 与 src-tauri/src/commands/model.rs 中的 DTO 类型对齐，由 models.json (manifest) 派生

export interface ManifestFileDto {
  path: string;
  sha256: string | null;
}

export interface ArtifactDto {
  archive_name: string;
  extract_dir: string;
  size_mb_estimate: number | null;
}

export interface DownloadSourceDto {
  region: string;
  provider: string;
  url: string;
  verify_before_use?: boolean;
  /** `files`：按 manifest.files 逐文件下载；缺省：下载 .tar.bz2 归档 */
  download_mode?: 'files' | 'archive' | string;
}

/** 与 models.json 中 models[].timestamp 对齐 */
export interface ModelTimestampDto {
  level: 'segment' | 'token' | 'word' | string;
  source?: string;
  required_vad?: boolean;
  token_timestamp_verified: boolean;
}

/** recognizer_config 保留为动态对象，按 model_type 分发到不同字段 */
export interface RecognizerConfig {
  model_type: string;
  tokens: string;
  // sense_voice
  sense_voice_model?: string;
  // paraformer
  paraformer_model?: string;
  // whisper
  whisper_encoder?: string;
  whisper_decoder?: string;
  // moonshine
  moonshine_preprocessor?: string;
  moonshine_encoder?: string;
  moonshine_uncached_decoder?: string;
  moonshine_cached_decoder?: string;
  // telespeech_ctc / zipformer_ctc
  telespeech_ctc_model?: string;
  zipformer_ctc_model?: string;
  // nemo_transducer
  encoder?: string;
  decoder?: string;
  joiner?: string;
  // fire_red_asr
  fire_red_asr_encoder?: string;
  fire_red_asr_decoder?: string;
  // 通用
  language?: string;
  use_itn?: boolean;
  task?: string;
  sample_rate?: number;
  feature_dim?: number;
  num_threads?: number;
  [key: string]: unknown;
}

export interface AvailableModel {
  /** Inference runtime; download_sources[].provider only identifies a mirror. */
  provider?: 'sherpa-onnx' | 'qwen-asr';
  local_path?: string | null;
  custom?: boolean;
  id: string;
  name: string;
  family: string;
  enabled: boolean;
  recommended: boolean;
  languages: string[];
  description: string;
  mode: string;
  quantization?: string | null;
  size?: string | null;
  supports_subtitle: boolean;
  timestamp: ModelTimestampDto;
  artifact: ArtifactDto;
  files: ManifestFileDto[];
  recognizer_config: RecognizerConfig;
  download_sources: DownloadSourceDto[];
}

export interface SharedAssetDto {
  id: string;
  name: string;
  type: string;
  description: string;
  required_for_subtitle: boolean;
  files: ManifestFileDto[];
  download_sources: DownloadSourceDto[];
}

/** check_shared_asset_downloaded 返回：可用性 + 是否来自安装包内置 */
export interface SharedAssetStatus {
  available: boolean;
  path: string | null;
  bundled: boolean;
}

// 兼容旧引用（已被 ManifestFileDto 取代）
export type ModelFile = ManifestFileDto;

export interface ModelDownloadProgress {
  model_id: string;
  current_file: string;
  file_index: number;
  total_files: number;
  downloaded_bytes: number;
  total_bytes: number;
  status: 'downloading' | 'skipped' | 'complete' | 'error';
  error?: string;
}

export interface ModelDownloadState {
  isDownloading: boolean;
  currentModelId: string | null;
  progress: ModelDownloadProgress | null;
  downloadedModels: Set<string>;
}

// 全量下载状态（Host models.status 返回）
export interface AllModelsStatus {
  all_downloaded: boolean;
  downloaded_model_ids: string[];
  total_models: number;
  downloaded_count: number;
  total_size_bytes: number;
  downloaded_size_bytes: number;
}

// 模型 family 分组（用于 UI 渲染）
export const MODEL_FAMILY_LABELS: Record<string, string> = {
  qwen_asr: 'Qwen-ASR 多语种',
  sense_voice: 'SenseVoice 多语种',
  paraformer: 'Paraformer 中文优先',
  whisper: 'Whisper 英文 / 多语种',
  moonshine: 'Moonshine 英文轻量',
  telespeech_ctc: 'TeleSpeech 中文方言',
  zipformer_ctc: 'Zipformer CTC 中文',
  nemo_transducer: 'NeMo Transducer 英文',
  fire_red_asr: 'FireRedASR 中英高质量',
};

// 默认推荐模型 id（manifest 中 recommended=true 的中文多语种模型）
export const DEFAULT_MODEL_ID = 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17';
