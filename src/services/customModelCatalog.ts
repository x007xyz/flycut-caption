import type { AvailableModel } from '../types/model';

export const MODEL_CATALOG_CHANGED_EVENT = 'asr-model-catalog-changed';

export function notifyModelCatalogChanged() {
  window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED_EVENT));
}

/** Official qwen-asr package format, rather than the separate *-hf checkpoints. */
export function createQwenModelPreset(size: '0.6B' | '1.7B' = '0.6B'): AvailableModel {
  return {
    id: `custom-qwen3-asr-${size.toLowerCase().replace('.', '-')}`,
    name: `Qwen3-ASR ${size}`,
    provider: 'qwen-asr',
    family: 'qwen_asr',
    enabled: true,
    recommended: false,
    languages: ['multi'],
    description: '本地 Qwen-ASR；默认每 25 秒生成一段字幕，配置 ForcedAligner 后输出字词时间戳。',
    mode: 'offline',
    supports_subtitle: true,
    timestamp: { level: 'segment', source: 'audio-window', required_vad: false, token_timestamp_verified: false },
    artifact: { archive_name: '', extract_dir: '', size_mb_estimate: size === '0.6B' ? 1890 : 4700 },
    files: ['config.json', 'generation_config.json', ...(size === '0.6B' ? ['model.safetensors'] : ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json']), 'preprocessor_config.json',
      'tokenizer_config.json', 'vocab.json', 'merges.txt', 'chat_template.json'].map(path => ({ path, sha256: null })),
    recognizer_config: { model_type: 'qwen_asr', tokens: '', device: 'auto', language: 'auto' },
    download_sources: [{ region: 'global', provider: 'huggingface', download_mode: 'files',
      url: `https://huggingface.co/Qwen/Qwen3-ASR-${size}/resolve/main/` }],
  };
}
