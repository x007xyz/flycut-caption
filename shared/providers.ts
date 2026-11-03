import { z } from 'zod';

/** Model Provider contract shared by Host and client. Rules: docs/subsystems/providers.md. */
export type ModelRole = 'asr' | 'vad' | 'punc' | 'speaker' | 'align' | 'tts';
export type TimestampLevel = 'none' | 'segment' | 'word';
export type ModelStatus = 'ready' | 'download' | 'unavailable';
export type OptionValue = string | number | boolean;

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
  options?: Record<string, OptionField>;
}

/** The only way callers address a model. */
export interface ModelRef { providerId: string; modelId: string }

export type ProviderKind = 'builtin' | 'endpoint';
export interface ProviderSummary { id: string; name: string; kind: ProviderKind }
/** One Provider's models; a failing Provider reports `error` without hiding the others. */
export interface ProviderModels { provider: ProviderSummary; models: ModelInfo[]; error?: string }

export const optionValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) });
export const asrRequestSchema = modelRefSchema.extend({ language: z.string().default('auto'), options: optionValuesSchema.optional() });
export type AsrRequest = z.infer<typeof asrRequestSchema>;

/** Model IDs reachable over HTTP headers and URL paths. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

export const optionFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'select']), label: z.string().min(1), description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
});
/** Validates model rows coming from an HTTP Provider; built-in Providers are typed instead. */
export const modelInfoSchema = z.object({
  id: z.string().regex(MODEL_ID_PATTERN), name: z.string().min(1).max(200),
  role: z.enum(['asr', 'vad', 'punc', 'speaker', 'align', 'tts']), description: z.string().max(2000).optional(),
  languages: z.array(z.string().max(20)).max(200).optional(), timestampLevel: z.enum(['none', 'segment', 'word']).optional(),
  size: z.string().max(50).optional(), status: z.enum(['ready', 'download', 'unavailable']), reason: z.string().max(1000).optional(),
  recommended: z.boolean().optional(), options: z.record(z.string(), optionFieldSchema).optional(),
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
