import { z } from 'zod';
import { modelRefSchema, optionValuesSchema, type ModelRef } from './providers';
import type { SuggestionBatch } from './editing/suggestions';

export const projectTranscribeInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid().optional(),
  model: modelRefSchema,
  language: z.string().min(1).max(32).default('auto'),
  options: optionValuesSchema.optional(),
  operationId: z.uuid().optional(),
});
export type ProjectTranscribeInput = z.input<typeof projectTranscribeInputSchema>;

export interface ProjectTranscribeResult {
  projectId: string;
  videoId: string;
  revision: number;
  language: string;
  duration: number;
  chunkCount: number;
  wordCount: number;
  hasWordTimestamps: boolean;
  model: ModelRef;
}

export const silenceAnalyzeParamsSchema = z.strictObject({
  minPauseSeconds: z.number().finite().positive(),
  guardSeconds: z.number().finite().nonnegative(),
  mode: z.enum(['shorten', 'remove']),
  retainSeconds: z.number().finite().nonnegative(),
});

export const projectSuggestInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid().optional(),
  kind: z.enum(['fillers', 'silence', 'semantic', 'all']).default('fillers'),
  silenceMethod: z.enum(['auto', 'vad', 'gap']).default('auto'),
  configId: z.uuid().optional(),
  vadModel: modelRefSchema.optional(),
  silenceParams: silenceAnalyzeParamsSchema.optional(),
  gapThresholdSeconds: z.number().finite().min(0.2).max(10).optional(),
  operationId: z.uuid().optional(),
});
export type ProjectSuggestInput = z.input<typeof projectSuggestInputSchema>;

export const projectSuggestionsListInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid().optional(),
});

export const projectSuggestionDismissInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  suggestionId: z.uuid(),
});

export interface PendingProjectSuggestion {
  id: string;
  operationId?: string;
  projectId: string;
  videoId: string;
  baseRevision: number;
  createdAt: string;
  status: 'pending';
  batch: SuggestionBatch;
}

export interface ProjectSuggestResult {
  suggestionId: string;
  projectId: string;
  videoId: string;
  baseRevision: number;
  status: 'pending';
  total: number;
  selected: number;
  durationSeconds: number;
  batch: SuggestionBatch;
}

export const projectExportInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid().optional(),
  format: z.enum(['mp4', 'webm', 'srt', 'vtt', 'json', 'ass']).default('mp4'),
  quality: z.enum(['high', 'medium', 'low']).default('medium'),
  preserveAudio: z.boolean().default(true),
  joinFadeMs: z.number().min(0).max(100).default(0),
  subtitleProcessing: z.enum(['none', 'soft', 'hard']).default('none'),
  subtitleExportMode: z.enum(['Bilingual', 'Main', 'Second']).default('Bilingual'),
  operationId: z.uuid().optional(),
});
export type ProjectExportInput = z.input<typeof projectExportInputSchema>;

export interface ProjectExportResult {
  projectId: string;
  videoId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  format: 'mp4' | 'webm' | 'srt' | 'vtt' | 'json' | 'ass';
  durationSeconds: number;
}
