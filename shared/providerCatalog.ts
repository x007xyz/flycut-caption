import type { ProviderCapability, ProviderModel, ProviderPackage } from '../src/types/provider';

/**
 * Declarative catalog entries contributed by Host plugins through `ctx.providers.describe`.
 * Data only: execution is owned by the registered Host Providers.
 */
export const PROVIDER_PACKAGES: Record<string, ProviderPackage> = Object.fromEntries(([
  {
    schemaVersion: 1,
    id: 'transformers-web',
    name: 'Transformers',
    description: 'Host CPU 上运行的 Transformers.js 识别能力。',
    runtime: 'browser',
    status: 'available',
    models: [{ id: 'whisper-small', name: 'Whisper Small', role: 'asr', timestampLevel: 'segment', supportsWordTimestamps: false, size: '466 MB' }],
    capabilities: [
      { id: 'transcribe', kind: 'transcribe', name: '语音识别', description: '在 Host 上使用 Transformers.js（CPU）生成字幕。', status: 'available', input: ['audio', 'video'], output: ['transcript', 'timestamps'] },
    ],
  },
  {
    schemaVersion: 1,
    id: 'funasr-local',
    name: 'FunASR Local',
    description: '本地 sherpa-onnx / FunASR 系列识别能力。',
    runtime: 'tauri',
    status: 'available',
    models: [
      { id: 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17', name: 'SenseVoice Small', role: 'asr', timestampLevel: 'segment', supportsVad: false, supportsWordTimestamps: false, size: '234 MB' },
      { id: 'paraformer-zh-int8-2023-09-14', name: 'Paraformer 中文', role: 'asr', timestampLevel: 'segment', supportsVad: false, supportsWordTimestamps: false, size: '220 MB' },
      { id: 'fsmn-vad', name: 'FSMN VAD', role: 'vad', timestampLevel: 'none', size: '2 MB' },
    ],
    capabilities: [
      { id: 'transcribe', kind: 'transcribe', name: '语音识别', description: '使用本地 SenseVoice、Paraformer、Whisper 等模型生成字幕。', status: 'available', input: ['audio', 'video'], output: ['transcript', 'timestamps'] },
      { id: 'vad', kind: 'vad', name: '语音活动检测', description: '使用 VAD 找到语音片段并辅助字幕分段。', status: 'available', input: ['audio'], output: ['speech-segments'], configFields: { threshold: { type: 'number', label: '检测阈值', default: 0.45, min: 0, max: 1, step: 0.05 } } },
    ],
  },
  {
    schemaVersion: 1,
    id: 'qwen-asr',
    name: 'Qwen ASR',
    description: 'Qwen3-ASR 与 ForcedAligner 本地能力。',
    runtime: 'python',
    status: 'available',
    models: [
      { id: 'custom-qwen3-asr-0-6b', name: 'Qwen3-ASR 0.6B', role: 'asr', timestampLevel: 'segment', supportsVad: false, supportsWordTimestamps: false, size: '1.8 GB' },
      { id: 'custom-qwen3-asr-1-7b', name: 'Qwen3-ASR 1.7B', role: 'asr', timestampLevel: 'segment', supportsVad: false, supportsWordTimestamps: false, size: '4.2 GB' },
      { id: 'custom-qwen-forced-aligner-0-6b', name: 'Qwen ForcedAligner 0.6B', role: 'align', timestampLevel: 'word', supportsWordTimestamps: true, size: '1.6 GB' },
    ],
    capabilities: [
      { id: 'transcribe', kind: 'transcribe', name: '语音识别', description: '使用 Qwen3-ASR 生成多语种转录。', status: 'available', input: ['audio', 'video'], output: ['transcript', 'timestamps'] },
      { id: 'align', kind: 'align', name: '字词时间戳对齐', description: '使用 ForcedAligner 细化字词级时间戳。', status: 'available', input: ['audio', 'transcript'], output: ['word-timestamps'] },
    ],
  },
  {
    schemaVersion: 1,
    id: 'audio-separator',
    name: 'Audio Separator',
    description: 'MDX、VR、Demucs 等音频源分离能力。',
    runtime: 'python',
    status: 'planned',
    models: [{ id: 'mdx-vocal-balanced', name: 'MDX Vocal Balanced', role: 'separator', size: '150 MB' }],
    capabilities: [
      { id: 'separate-vocals', kind: 'separate-vocals', name: '人声分离', description: '从背景音乐中提取 vocals 音轨，再交给识别引擎。', status: 'planned', input: ['audio', 'video'], output: ['vocals', 'instrumental'], configFields: { device: { type: 'select', label: '运行设备', default: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'cpu', label: 'CPU' }, { value: 'cuda', label: 'CUDA' }, { value: 'mps', label: 'Apple GPU' }] }, chunkDuration: { type: 'number', label: '分段时长（秒）', default: 300, min: 30, max: 1800, step: 30 } } },
    ],
  },
  {
    schemaVersion: 1,
    id: 'openai-compatible',
    name: 'OpenAI Compatible API',
    description: '兼容 OpenAI 音频和文本接口的远程能力。',
    runtime: 'remote',
    status: 'available',
    models: [{ id: 'whisper-1', name: 'whisper-1', role: 'asr', timestampLevel: 'word', supportsWordTimestamps: true }],
    capabilities: [
      { id: 'transcribe', kind: 'transcribe', name: '云端语音识别', description: '把音频发送到用户配置的兼容 API。', status: 'available', input: ['audio', 'video'], output: ['transcript', 'timestamps'] },
      { id: 'translate', kind: 'translate', name: '字幕翻译', description: '使用兼容文本 API 翻译字幕。', status: 'available', input: ['transcript'], output: ['translated-transcript'] },
      { id: 'correct', kind: 'correct', name: '字幕纠错', description: '使用兼容文本 API 修正字幕。', status: 'available', input: ['transcript'], output: ['corrected-transcript'] },
    ],
  },
] satisfies ProviderPackage[]).map(item => [item.id, item]));

export function providerModelsByRole(packages: ProviderPackage[], role: ProviderModel['role']) {
  return packages.flatMap(provider => (provider.models ?? []).filter(model => model.role === role)
    .map(model => ({ providerId: provider.id, providerName: provider.name, model })));
}
export function findProviderCapability(packages: ProviderPackage[], providerId: string, capabilityId: string): ProviderCapability | undefined {
  return packages.find(provider => provider.id === providerId)?.capabilities.find(capability => capability.id === capabilityId);
}
