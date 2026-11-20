import { z } from 'zod';

/** Model Provider contract shared by Host and client. Rules: docs/subsystems/providers.md. */
export type ModelRole = 'asr' | 'vad' | 'punc' | 'speaker' | 'align' | 'tts' | 'separation';
export type TimestampLevel = 'none' | 'segment' | 'word';
export type ModelStatus = 'ready' | 'download' | 'unavailable';
export type OptionValue = string | number | boolean;

export type TtsAudioFormat = 'wav' | 'mp3' | 'ogg' | 'flac';

export interface TtsVoice {
  id: string;
  name: string;
  languages?: string[];
  gender?: 'female' | 'male' | 'neutral';
  description?: string;
}

export interface TtsCapabilities {
  /** Built-in fixed voices; empty when the model uses a single default voice or cloning only. */
  voices: TtsVoice[];
  /** Whether reference-audio voice cloning is supported. */
  voiceCloning: boolean;
  /** Provider disclosure/retention terms displayed before sending reference audio. */
  cloningTerms?: string;
  /** Maximum reference audio duration accepted for cloning, in seconds. */
  maxReferenceSeconds?: number;
  streaming?: boolean;
  durationControl?: boolean;
  outputFormats?: TtsAudioFormat[];
}

export interface OptionField {
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;
  description?: string;
  default?: OptionValue;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ModelRecommendation {
  benchmarkId: string;
  cer?: string;
  fillerRecall?: string;
  sampleCount?: number;
  sentenceCount?: number;
  comparedWith?: string[];
}

export interface HotwordCapabilities {
  supported: boolean;
  weights?: boolean;
  maxTerms?: number;
  format?: 'space-separated' | 'weighted-lines' | 'prompt';
}

export interface ModelInfo {
  id: string;
  name: string;
  role: ModelRole;
  description?: string;
  /** Language codes; `auto` means the model detects the language itself. Missing means `['auto']`. */
  languages?: string[];
  /** What the model usually produces. A UI hint only: editing trusts the validated result. */
  timestampLevel?: TimestampLevel;
  size?: string;
  status: ModelStatus;
  reason?: string;
  recommended?: boolean;
  /** True when the model executes locally offline without cloud/network billing. */
  offline?: boolean;
  /** Structured benchmark metadata (e.g. F-0001) supporting a recommendation. */
  recommendation?: ModelRecommendation;
  options?: Record<string, OptionField>;
  /** Present for `role: 'asr'` models declaring whether hotwords/weights are supported. */
  hotwords?: HotwordCapabilities;
  /** Present for `role: 'tts'` models when the Provider declares TTS-specific capabilities. */
  tts?: TtsCapabilities;
}

/** The only way callers address a model. */
export interface ModelRef { providerId: string; modelId: string }

export type ProviderKind = 'builtin' | 'endpoint';
export interface ProviderSummary { id: string; name: string; kind: ProviderKind }
/** One Provider's models; a failing Provider reports `error` without hiding the others. */
export interface ProviderModels { provider: ProviderSummary; models: ModelInfo[]; error?: string }

export const optionValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) });
export const asrHotwordSchema = z.strictObject({
  term: z.string().trim().min(1).max(200),
  weight: z.number().finite().positive().max(100).optional(),
});
export type AsrHotword = z.infer<typeof asrHotwordSchema>;
export const asrRequestSchema = modelRefSchema.extend({
  language: z.string().default('auto'),
  options: optionValuesSchema.optional(),
  hotwords: z.array(asrHotwordSchema).max(500).optional(),
});
export type AsrRequest = z.infer<typeof asrRequestSchema>;

export const TTS_CLONE_AUTH_STATEMENT_ZH = '这是我本人的声音，或我已获得说话人授权';
export const TTS_CLONE_AUTH_STATEMENT_EN = 'This is my voice, or I have the speaker’s permission';

export const ttsCloneAuthorizationSchema = z.strictObject({
  confirmed: z.literal(true),
  statement: z.string().trim().min(1).max(300),
  confirmedAt: z.iso.datetime(),
  sourceLabel: z.string().trim().min(1).max(200).optional(),
});
export type TtsCloneAuthorization = z.infer<typeof ttsCloneAuthorizationSchema>;

export const ttsAudioFormatSchema = z.enum(['wav', 'mp3', 'ogg', 'flac']);

export const ttsVoiceSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  languages: z.array(z.string().max(20)).max(50).optional(),
  gender: z.enum(['female', 'male', 'neutral']).optional(),
  description: z.string().max(500).optional(),
});

export const ttsCapabilitiesSchema = z.object({
  voices: z.array(ttsVoiceSchema).max(200).default([]),
  voiceCloning: z.boolean().default(false),
  cloningTerms: z.string().max(2000).optional(),
  maxReferenceSeconds: z.number().finite().positive().max(300).optional(),
  streaming: z.boolean().optional(),
  durationControl: z.boolean().optional(),
  outputFormats: z.array(ttsAudioFormatSchema).max(10).optional(),
});

export const ttsRequestSchema = modelRefSchema.extend({
  text: z.string().trim().min(1).max(5000),
  voiceId: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(1).max(20).default('auto'),
  speed: z.number().finite().min(0.25).max(4).optional(),
  format: ttsAudioFormatSchema.optional(),
  options: optionValuesSchema.optional(),
  cloneReferenceAssetId: z.uuid().optional(),
  cloneAuthorization: ttsCloneAuthorizationSchema.optional(),
});
export type TtsRequest = z.infer<typeof ttsRequestSchema>;

/** F-0006: VAD output shared by built-in and HTTP Providers. Segments are seconds. */
export interface VoiceActivityResult { vadType: 'fsmn' | 'silero'; duration: number; segments: Array<[number, number]> }
export const voiceActivityResultSchema = z.object({
  vadType: z.enum(['fsmn', 'silero']),
  duration: z.number().finite().positive(),
  segments: z.array(z.tuple([z.number().finite().nonnegative(), z.number().finite().positive()])),
}).superRefine((value, ctx) => {
  let previous = 0;
  for (const [start, end] of value.segments) {
    if (end <= start) ctx.addIssue({ code: 'custom', message: 'Invalid VAD segment' });
    if (start < previous - 0.05) ctx.addIssue({ code: 'custom', message: 'VAD segments are not ordered' });
    if (end > value.duration + 0.1) ctx.addIssue({ code: 'custom', message: 'VAD segment exceeds duration' });
    previous = end;
  }
});

/** Model IDs reachable over HTTP headers and URL paths. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

export const optionFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'select']), label: z.string().min(1), description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
});
export const modelRecommendationSchema = z.object({
  benchmarkId: z.string().min(1).max(64),
  cer: z.string().max(32).optional(),
  fillerRecall: z.string().max(32).optional(),
  sampleCount: z.number().int().positive().optional(),
  sentenceCount: z.number().int().positive().optional(),
  comparedWith: z.array(z.string().max(100)).max(20).optional(),
});
export const hotwordCapabilitiesSchema = z.object({
  supported: z.boolean(),
  weights: z.boolean().optional(),
  maxTerms: z.number().int().positive().max(5000).optional(),
  format: z.enum(['space-separated', 'weighted-lines', 'prompt']).optional(),
});

/** Validates model rows coming from an HTTP Provider; built-in Providers are typed instead. */
export const modelInfoSchema = z.object({
  id: z.string().regex(MODEL_ID_PATTERN), name: z.string().min(1).max(200),
  role: z.enum(['asr', 'vad', 'punc', 'speaker', 'align', 'tts', 'separation']), description: z.string().max(2000).optional(),
  languages: z.array(z.string().max(20)).max(200).optional(), timestampLevel: z.enum(['none', 'segment', 'word']).optional(),
  size: z.string().max(50).optional(), status: z.enum(['ready', 'download', 'unavailable']), reason: z.string().max(1000).optional(),
  recommended: z.boolean().optional(), offline: z.boolean().optional(), recommendation: modelRecommendationSchema.optional(),
  options: z.record(z.string(), optionFieldSchema).optional(),
  hotwords: hotwordCapabilitiesSchema.optional(),
  tts: ttsCapabilitiesSchema.optional(),
});

/** Rejects option keys the model did not declare, and values of the wrong type. */
export function checkOptions(model: ModelInfo, options: Record<string, OptionValue> = {}) {
  for (const [key, value] of Object.entries(options)) {
    const field = model.options?.[key];
    if (!field) throw new Error(`模型 ${model.id} 不支持选项 ${key}`);
    const type = field.type === 'select' ? 'string' : field.type;
    if (typeof value !== type) throw new Error(`选项 ${key} 应为 ${type}`);
    if (field.type === 'select' && !field.options?.some(option => option.value === value)) throw new Error(`选项 ${key} 的值无效：${value}`);
    if (typeof value === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
      throw new Error(`选项 ${key} 超出范围`);
    }
  }
}

/** Resolves effective ASR hotword capabilities from ModelInfo (supporting legacy options.hotword declarations). */
export function inferHotwordCapabilities(model: Pick<ModelInfo, 'hotwords' | 'options'>): HotwordCapabilities {
  if (model.hotwords) return model.hotwords;
  if (model.options?.hotword) {
    return { supported: true, weights: false, format: 'space-separated' };
  }
  return { supported: false };
}

/** Validates an ASR request against the model's declared options and hotword capabilities. */
export function checkAsrRequest(model: ModelInfo, request: AsrRequest): AsrRequest {
  checkOptions(model, request.options);
  if (!request.hotwords?.length) {
    return { ...request, hotwords: undefined };
  }
  const caps = inferHotwordCapabilities(model);
  if (!caps.supported) {
    throw new Error(`模型 ${model.name} 不支持热词 / This model does not support hotwords`);
  }
  if (caps.maxTerms !== undefined && request.hotwords.length > caps.maxTerms) {
    throw new Error(`模型 ${model.name} 最多支持 ${caps.maxTerms} 个热词`);
  }
  const normalized = request.hotwords.map((item) => ({
    term: item.term.trim(),
    ...(caps.weights && item.weight !== undefined ? { weight: item.weight } : {}),
  }));
  return { ...request, hotwords: normalized };
}

/** Validates a TTS request against the target model's declared capabilities and cloning gate. */
export function checkTtsRequest(model: ModelInfo, request: TtsRequest) {
  if (model.role !== 'tts') throw new Error(`${model.name} 不是语音合成（TTS）模型`);
  if (model.status === 'download') throw new Error(`模型未下载：${model.name}`);
  if (model.status === 'unavailable') throw new Error(`${model.name} 不可用：${model.reason ?? '未知原因'}`);
  checkOptions(model, request.options);
  const isCloning = Boolean(request.cloneReferenceAssetId || request.cloneAuthorization);
  if (isCloning) {
    if (!model.tts?.voiceCloning) throw new Error(`模型 ${model.name} 不支持声音克隆`);
    if (!request.cloneReferenceAssetId) throw new Error('声音克隆必须提供参考音频样本');
    if (!request.cloneAuthorization?.confirmed || !request.cloneAuthorization.statement.trim()) {
      throw new Error('声音克隆必须先完成本人或说话人授权确认');
    }
  } else if (request.voiceId && model.tts?.voices?.length && !model.tts.voices.some(v => v.id === request.voiceId)) {
    throw new Error(`模型 ${model.name} 不支持音色 ${request.voiceId}`);
  }
  if (request.language !== 'auto' && model.languages?.length && !model.languages.includes('auto') && !model.languages.includes(request.language)) {
    throw new Error(`模型 ${model.name} 不支持语言 ${request.language}`);
  }
  if (request.format && model.tts?.outputFormats?.length && !model.tts.outputFormats.includes(request.format)) {
    throw new Error(`模型 ${model.name} 不支持输出格式 ${request.format}`);
  }
}
