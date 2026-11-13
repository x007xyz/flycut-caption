import { z } from 'zod';
import { modelRefSchema, optionValuesSchema, ttsAudioFormatSchema, ttsRequestSchema } from '../providers';

export const ttsSettingsDataSchema = z.strictObject({
  selectedModel: modelRefSchema.nullable(),
  voiceId: z.string().trim().min(1).max(100).nullable(),
  language: z.string().trim().min(1).max(20).default('auto'),
  speed: z.number().finite().min(0.25).max(4).default(1),
  options: optionValuesSchema.default({}),
});
export type TtsSettingsData = z.infer<typeof ttsSettingsDataSchema>;

export const ttsAuditionSummarySchema = z.strictObject({
  assetId: z.uuid(),
  text: z.string().max(500),
  model: modelRefSchema,
  voiceId: z.string().optional(),
  language: z.string(),
  mimeType: z.string(),
  format: ttsAudioFormatSchema,
  byteLength: z.number().int().positive(),
  durationSeconds: z.number().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  verifiedAt: z.iso.datetime(),
});
export type TtsAuditionSummary = z.infer<typeof ttsAuditionSummarySchema>;

export const ttsSettingsSnapshotSchema = z.strictObject({
  hostId: z.uuid(),
  revision: z.number().int().nonnegative(),
  selectedModel: modelRefSchema.nullable(),
  voiceId: z.string().nullable(),
  language: z.string(),
  speed: z.number(),
  options: optionValuesSchema,
  lastAudition: ttsAuditionSummarySchema.nullable(),
  lastOperationId: z.string().optional(),
});
export type TtsSettingsSnapshot = z.infer<typeof ttsSettingsSnapshotSchema>;

export const ttsSettingsSaveInputSchema = z.strictObject({
  hostId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.uuid().optional(),
  settings: ttsSettingsDataSchema,
});
export type TtsSettingsSaveInput = z.infer<typeof ttsSettingsSaveInputSchema>;

export type TtsSettingsSaveResult =
  | { status: 'conflict'; snapshot: TtsSettingsSnapshot }
  | { status: 'saved'; duplicate?: boolean; snapshot: TtsSettingsSnapshot };

export const ttsSynthesizeInputSchema = z.strictObject({
  operationId: z.uuid().optional(),
  request: ttsRequestSchema,
});
export type TtsSynthesizeInput = z.infer<typeof ttsSynthesizeInputSchema>;

export interface TtsSynthesizeResult extends TtsAuditionSummary {
  cloned: boolean;
}

export interface StoredTtsSettings {
  formatVersion: 1;
  hostId: string;
  revision: number;
  selectedModel: { providerId: string; modelId: string } | null;
  voiceId: string | null;
  language: string;
  speed: number;
  options: Record<string, string | number | boolean>;
  lastAudition: TtsAuditionSummary | null;
  operations: Record<string, { requestDigest: string; revision: number }>;
  lastOperationId?: string;
}
