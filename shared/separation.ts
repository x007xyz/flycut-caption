import { z } from 'zod';
import { modelRefSchema } from './providers';

export const separationRecordSchema = z.looseObject({
  id: z.uuid(),
  model: modelRefSchema,
  vocalsFile: z.string().regex(/^separation\/[0-9a-f-]{36}\/vocals\.wav$/i),
  backgroundFile: z.string().regex(/^separation\/[0-9a-f-]{36}\/background\.wav$/i),
  durationSeconds: z.number().finite().positive(),
  sampleRate: z.number().int().positive(),
  sourceFingerprint: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type SeparationRecord = z.infer<typeof separationRecordSchema>;

export const separationAnalyzeInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  model: modelRefSchema,
});
export type SeparationAnalyzeInput = z.infer<typeof separationAnalyzeInputSchema>;

export type SeparationAnalyzeResult = { status: 'saved'; record: SeparationRecord; videoRevision: number; projectRevision: number; updatedAt: string };
