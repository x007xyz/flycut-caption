import { z } from 'zod';

export const aiConfigIdSchema = z.uuid();
export const aiHostIdSchema = z.uuid();

/** Public AI configuration. The secret is represented only by `hasApiKey`. */
export const aiConfigViewSchema = z.object({
  id: aiConfigIdSchema,
  name: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  temperature: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  hasApiKey: z.boolean(),
});
export type AIConfigView = z.infer<typeof aiConfigViewSchema>;

export const aiSettingsSnapshotSchema = z.object({
  hostId: aiHostIdSchema,
  revision: z.number().int().nonnegative(),
  selectedId: aiConfigIdSchema.nullable(),
  configs: z.array(aiConfigViewSchema),
});
export type AISettingsSnapshot = z.infer<typeof aiSettingsSnapshotSchema>;

const baseUrlSchema = z.url().refine(value => /^https?:$/.test(new URL(value).protocol), 'Base URL 必须使用 http 或 https');
const configFields = {
  name: z.string().trim().min(1).max(80),
  baseUrl: baseUrlSchema,
  model: z.string().trim().min(1).max(200),
  temperature: z.number().finite().min(0).max(2).optional(),
  headers: z.record(z.string().min(1).max(100), z.string().max(2000)).optional(),
  /** Empty or absent keeps the existing secret. Only non-empty values are stored. */
  apiKey: z.string().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
};

export const aiSettingsSaveInputSchema = z.strictObject({
  hostId: aiHostIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  configId: aiConfigIdSchema.optional(),
  config: z.strictObject(configFields),
});
export type AISettingsSaveInput = z.infer<typeof aiSettingsSaveInputSchema>;

export const aiSettingsRemoveInputSchema = z.strictObject({
  hostId: aiHostIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  configId: aiConfigIdSchema,
});

export const aiSettingsSelectInputSchema = z.strictObject({
  hostId: aiHostIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  configId: aiConfigIdSchema.nullable(),
});

export const aiSettingsTestInputSchema = z.strictObject({
  hostId: aiHostIdSchema,
  configId: aiConfigIdSchema,
});

export const aiSettingsImportItemSchema = z.strictObject({
  sourceId: z.string().trim().min(1).max(200),
  ...configFields,
});

export const aiSettingsImportInputSchema = z.strictObject({
  hostId: aiHostIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  migrationId: z.uuid(),
  selectedSourceId: z.string().max(200).nullable().optional(),
  configs: z.array(aiSettingsImportItemSchema).min(1).max(100),
});
export type AISettingsImportInput = z.infer<typeof aiSettingsImportInputSchema>;

export interface AISettingsConflict {
  status: 'conflict';
  snapshot: AISettingsSnapshot;
}

export type AISettingsSaveResult = AISettingsConflict | {
  status: 'saved';
  configId: string;
  snapshot: AISettingsSnapshot;
};

export type AISettingsMutationResult = AISettingsConflict | {
  status: 'saved';
  snapshot: AISettingsSnapshot;
};

export type AISettingsRemoveResult = AISettingsConflict | {
  status: 'removed';
  removed: string;
  snapshot: AISettingsSnapshot;
};

export type AISettingsImportResult = AISettingsConflict | {
  status: 'imported';
  duplicate: boolean;
  configIds: string[];
  snapshot: AISettingsSnapshot;
};

export interface AISettingsTestResult {
  status: 'ok' | 'error';
  message: string;
}

/** Metadata only; this file never contains an API key. */
export interface StoredAISettings {
  formatVersion: 1;
  hostId: string;
  revision: number;
  selectedId: string | null;
  configs: Array<Omit<AIConfigView, 'hasApiKey'> & { sourceId?: string; secretRef?: string }>;
  migrations: Record<string, { configIds: string[]; requestDigest: string }>;
}

/** Runtime-only text model configuration passed inside the Host to an upstream client. */
export interface ResolvedAIConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  headers?: Record<string, string>;
  apiKey: string;
}
